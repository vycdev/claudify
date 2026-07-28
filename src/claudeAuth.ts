import {
    ChildProcessWithoutNullStreams,
    spawn,
} from "child_process";

const MAX_CAPTURED_OUTPUT = 64 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface ClaudeAuthStatus {
    loggedIn: boolean;
    authMethod?: string;
    apiProvider?: string;
}

export interface ClaudeAuthManagerOptions {
    command?: string;
    prefixArgs?: string[];
    commandTimeoutMs?: number;
    loginTimeoutMs?: number;
    env?: NodeJS.ProcessEnv;
}

interface LoginCompletion {
    code: number | null;
    error?: Error;
    timedOut: boolean;
}

interface LoginSession {
    ownerId: string;
    child: ChildProcessWithoutNullStreams;
    output: string;
    urlResolved: boolean;
    resolveUrl: (url: string) => void;
    rejectUrl: (error: Error) => void;
    completion: Promise<LoginCompletion>;
    resolveCompletion: (result: LoginCompletion) => void;
    timeout: NodeJS.Timeout;
    timedOut: boolean;
    codeSubmitted: boolean;
}

function appendBounded(current: string, chunk: string): string {
    const combined = current + chunk;
    return combined.length <= MAX_CAPTURED_OUTPUT
        ? combined
        : combined.slice(-MAX_CAPTURED_OUTPUT);
}

function stripAnsi(text: string): string {
    return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function optionalString(
    value: Record<string, unknown>,
    key: string,
): string | undefined {
    return typeof value[key] === "string" ? value[key] : undefined;
}

export function parseClaudeAuthStatus(
    stdout: string,
    exitCode: number | null,
): ClaudeAuthStatus {
    try {
        const parsed: unknown = JSON.parse(stdout);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const value = parsed as Record<string, unknown>;
            const authMethod = optionalString(value, "authMethod");
            const apiProvider = optionalString(value, "apiProvider");
            return {
                loggedIn:
                    typeof value.loggedIn === "boolean"
                        ? value.loggedIn
                        : exitCode === 0,
                ...(authMethod ? { authMethod } : {}),
                ...(apiProvider ? { apiProvider } : {}),
            };
        }
    } catch {
        // Fall back to the documented exit code contract.
    }

    return { loggedIn: exitCode === 0 };
}

export function extractClaudeLoginUrl(output: string): string | undefined {
    const urls = stripAnsi(output).match(/https:\/\/[^\s<>"']+/g) || [];
    const candidates = urls
        .map((url) => url.replace(/[.,;]+$/, ""))
        .filter((url) => {
            try {
                return new URL(url).protocol === "https:";
            } catch {
                return false;
            }
        });

    return candidates.find((url) => /oauth|authorize/i.test(url))
        || candidates.find((url) =>
            /login|claude\.ai|anthropic\.com/i.test(url),
        )
        || candidates[0];
}

export class ClaudeAuthManager {
    private readonly command: string;
    private readonly prefixArgs: string[];
    private readonly commandTimeoutMs: number;
    private readonly loginTimeoutMs: number;
    private readonly env: NodeJS.ProcessEnv;
    private activeSession?: LoginSession;

    constructor(options: ClaudeAuthManagerOptions = {}) {
        this.command = options.command || "claude";
        this.prefixArgs = options.prefixArgs || [];
        this.commandTimeoutMs =
            options.commandTimeoutMs || DEFAULT_COMMAND_TIMEOUT_MS;
        this.loginTimeoutMs =
            options.loginTimeoutMs || DEFAULT_LOGIN_TIMEOUT_MS;
        this.env = options.env || process.env;
    }

    async getStatus(): Promise<ClaudeAuthStatus> {
        const result = await this.runCommand(["auth", "status"]);
        return parseClaudeAuthStatus(result.stdout, result.code);
    }

    hasActiveLogin(): boolean {
        return this.activeSession !== undefined;
    }

    async startLogin(
        ownerId: string,
        method: "subscription" | "console" = "subscription",
    ): Promise<string> {
        if (this.activeSession) {
            throw new Error(
                "A Claude authentication session is already active.",
            );
        }

        const args = [
            ...this.prefixArgs,
            "auth",
            "login",
            ...(method === "console" ? ["--console"] : []),
        ];
        const child = spawn(this.command, args, {
            env: this.env,
            stdio: ["pipe", "pipe", "pipe"],
        });

        let resolveCompletion!: (result: LoginCompletion) => void;
        const completion = new Promise<LoginCompletion>((resolve) => {
            resolveCompletion = resolve;
        });

        return new Promise<string>((resolveUrl, rejectUrl) => {
            const session: LoginSession = {
                ownerId,
                child,
                output: "",
                urlResolved: false,
                resolveUrl,
                rejectUrl,
                completion,
                resolveCompletion,
                timeout: setTimeout(() => {
                    session.timedOut = true;
                    if (!session.urlResolved) {
                        session.rejectUrl(
                            new Error(
                                "Claude authentication did not provide a login URL before timing out.",
                            ),
                        );
                    }
                    child.kill();
                }, this.loginTimeoutMs),
                timedOut: false,
                codeSubmitted: false,
            };
            this.activeSession = session;

            const capture = (data: Buffer) => {
                session.output = appendBounded(
                    session.output,
                    stripAnsi(data.toString()),
                );
                if (!session.urlResolved) {
                    const loginUrl = extractClaudeLoginUrl(session.output);
                    if (loginUrl) {
                        session.urlResolved = true;
                        session.resolveUrl(loginUrl);
                    }
                }
            };

            child.stdout.on("data", capture);
            child.stderr.on("data", capture);

            child.on("error", (error) => {
                if (!session.urlResolved) {
                    session.rejectUrl(
                        new Error(
                            `Could not start the Claude CLI: ${error.message}`,
                        ),
                    );
                }
                session.resolveCompletion({
                    code: null,
                    error,
                    timedOut: session.timedOut,
                });
                this.finishSession(session);
            });

            child.on("close", (code) => {
                if (!session.urlResolved) {
                    session.rejectUrl(
                        new Error(
                            session.timedOut
                                ? "Claude authentication timed out."
                                : "Claude authentication ended before providing a login URL.",
                        ),
                    );
                }
                session.resolveCompletion({
                    code,
                    timedOut: session.timedOut,
                });
                this.finishSession(session);
            });
        });
    }

    async submitCode(
        ownerId: string,
        code: string,
    ): Promise<ClaudeAuthStatus> {
        const session = this.requireOwnedSession(ownerId);
        const normalizedCode = code.trim();
        if (
            normalizedCode.length === 0 ||
            normalizedCode.length > 4096 ||
            /[\r\n\u0000]/.test(normalizedCode)
        ) {
            throw new Error("The authentication code is not valid.");
        }
        if (!session.urlResolved || session.child.stdin.destroyed) {
            throw new Error(
                "The Claude authentication session is not accepting a code.",
            );
        }
        if (session.codeSubmitted) {
            throw new Error(
                "An authentication code is already being verified.",
            );
        }

        session.codeSubmitted = true;
        session.child.stdin.write(`${normalizedCode}\n\n`);
        const result = await session.completion;
        if (result.error) {
            throw new Error("The Claude authentication process failed.");
        }
        if (result.timedOut) {
            throw new Error("Claude authentication timed out.");
        }

        const status = await this.getStatus();
        if (!status.loggedIn) {
            throw new Error(
                result.code === 0
                    ? "Claude did not report an authenticated session."
                    : "Claude rejected the authentication code.",
            );
        }
        return status;
    }

    cancelLogin(ownerId: string): void {
        const session = this.requireOwnedSession(ownerId);
        this.finishSession(session);
        session.child.kill();
    }

    private requireOwnedSession(ownerId: string): LoginSession {
        const session = this.activeSession;
        if (!session) {
            throw new Error("There is no active Claude authentication session.");
        }
        if (session.ownerId !== ownerId) {
            throw new Error(
                "The active Claude authentication session belongs to another administrator.",
            );
        }
        return session;
    }

    private finishSession(session: LoginSession): void {
        clearTimeout(session.timeout);
        session.output = "";
        if (this.activeSession === session) {
            this.activeSession = undefined;
        }
    }

    private runCommand(
        args: string[],
    ): Promise<{ code: number | null; stdout: string; stderr: string }> {
        return new Promise((resolve, reject) => {
            const child = spawn(
                this.command,
                [...this.prefixArgs, ...args],
                {
                    env: this.env,
                    stdio: ["ignore", "pipe", "pipe"],
                },
            );
            let stdout = "";
            let stderr = "";
            let settled = false;

            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                child.kill();
                reject(new Error("Claude authentication status timed out."));
            }, this.commandTimeoutMs);

            child.stdout.on("data", (data: Buffer) => {
                stdout = appendBounded(stdout, data.toString());
            });
            child.stderr.on("data", (data: Buffer) => {
                stderr = appendBounded(stderr, data.toString());
            });
            child.on("error", (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                reject(
                    new Error(
                        `Could not start the Claude CLI: ${error.message}`,
                    ),
                );
            });
            child.on("close", (code) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve({ code, stdout, stderr });
            });
        });
    }
}
