import {
    ChildProcessWithoutNullStreams,
    spawn,
} from "child_process";

const MAX_CAPTURED_OUTPUT = 64 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
const FORCE_KILL_GRACE_MS = 1_000;
const REJECTED_CODE_PATTERN =
    /\binvalid code\b|\bcode (?:has )?expired\b|\bauthentication code (?:was )?rejected\b/i;

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

interface CodeAttempt {
    output: string;
    rejection: Promise<never>;
    reject: (error: Error) => void;
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
    forceKillTimeout?: NodeJS.Timeout;
    timedOut: boolean;
    codeSubmitted: boolean;
    codeAttempt?: CodeAttempt;
}

function appendBounded(current: string, chunk: string): string {
    const combined = current + chunk;
    return combined.length <= MAX_CAPTURED_OUTPUT
        ? combined
        : combined.slice(-MAX_CAPTURED_OUTPUT);
}

function stripTerminalSequences(text: string): string {
    return text
        .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function validTimeout(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value)
        && value !== undefined
        && value > 0
        && value <= MAX_TIMER_DELAY_MS
        ? value
        : fallback;
}

function isTrustedClaudeLoginUrl(value: string): boolean {
    try {
        const url = new URL(value);
        const trustedHost =
            url.hostname === "claude.com"
            || url.hostname.endsWith(".claude.com")
            || url.hostname === "claude.ai"
            || url.hostname.endsWith(".claude.ai")
            || url.hostname === "anthropic.com"
            || url.hostname.endsWith(".anthropic.com");
        return url.protocol === "https:"
            && trustedHost
            && /oauth|authorize|login/i.test(url.pathname);
    } catch {
        return false;
    }
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
    const urls =
        stripTerminalSequences(output).match(/https:\/\/[^\s<>"']+/g) || [];
    return urls
        .map((url) => url.replace(/[.,;]+$/, ""))
        .find(isTrustedClaudeLoginUrl);
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
        this.commandTimeoutMs = validTimeout(
            options.commandTimeoutMs,
            DEFAULT_COMMAND_TIMEOUT_MS,
        );
        this.loginTimeoutMs = validTimeout(
            options.loginTimeoutMs,
            DEFAULT_LOGIN_TIMEOUT_MS,
        );
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
                    session.resolveCompletion({
                        code: null,
                        timedOut: true,
                    });
                    this.terminateSession(session);
                }, this.loginTimeoutMs),
                timedOut: false,
                codeSubmitted: false,
            };
            this.activeSession = session;

            const capture = (data: Buffer) => {
                session.output = appendBounded(
                    session.output,
                    data.toString(),
                );
                if (!session.urlResolved) {
                    const loginUrl = extractClaudeLoginUrl(session.output);
                    if (loginUrl) {
                        session.urlResolved = true;
                        session.resolveUrl(loginUrl);
                    }
                }

                const attempt = session.codeAttempt;
                if (attempt) {
                    attempt.output = appendBounded(
                        attempt.output,
                        data.toString(),
                    );
                    if (
                        REJECTED_CODE_PATTERN.test(
                            stripTerminalSequences(attempt.output),
                        )
                    ) {
                        session.codeAttempt = undefined;
                        session.codeSubmitted = false;
                        attempt.reject(
                            new Error(
                                "Claude rejected the authentication code. Check it and try again.",
                            ),
                        );
                    }
                }
            };

            child.stdout.on("data", capture);
            child.stderr.on("data", capture);
            child.stdin.on("error", () => {
                const attempt = session.codeAttempt;
                if (!attempt) return;
                session.codeAttempt = undefined;
                session.codeSubmitted = false;
                attempt.reject(
                    new Error(
                        "The Claude authentication process could not accept the code.",
                    ),
                );
            });

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
        let rejectAttempt!: (error: Error) => void;
        const rejection = new Promise<never>((_, reject) => {
            rejectAttempt = reject;
        });
        const attempt: CodeAttempt = {
            output: "",
            rejection,
            reject: rejectAttempt,
        };
        session.codeAttempt = attempt;
        const attemptResult = Promise.race([
            session.completion,
            attempt.rejection,
        ]);

        try {
            await new Promise<void>((resolve, reject) => {
                session.child.stdin.write(
                    `${normalizedCode}\n\n`,
                    (error?: Error | null) => {
                        if (error) {
                            reject(
                                new Error(
                                    "The Claude authentication process could not accept the code.",
                                ),
                            );
                            return;
                        }
                        resolve();
                    },
                );
            });
        } catch (error) {
            if (session.codeAttempt === attempt) {
                session.codeAttempt = undefined;
                session.codeSubmitted = false;
            }
            throw error;
        }

        const result = await attemptResult;
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
        this.terminateSession(session);
    }

    private terminateSession(session: LoginSession): void {
        const child = session.child;
        if (child.exitCode !== null || child.signalCode !== null) return;

        try {
            child.kill();
        } catch {
            // The close/error handlers will finalize an already-ended process.
        }
        if (session.forceKillTimeout) return;

        session.forceKillTimeout = setTimeout(() => {
            session.forceKillTimeout = undefined;
            if (child.exitCode !== null || child.signalCode !== null) return;
            try {
                child.kill("SIGKILL");
            } catch {
                // Process termination is best-effort; close/error owns cleanup.
            }
        }, FORCE_KILL_GRACE_MS);
        session.forceKillTimeout.unref();
    }

    private requireOwnedSession(ownerId: string): LoginSession {
        const session = this.activeSession;
        if (!session) {
            throw new Error("There is no active Claude authentication session.");
        }
        if (session.ownerId !== ownerId) {
            throw new Error(
                "The active Claude authentication session belongs to another allowed user.",
            );
        }
        return session;
    }

    private finishSession(session: LoginSession): void {
        clearTimeout(session.timeout);
        if (session.forceKillTimeout) {
            clearTimeout(session.forceKillTimeout);
            session.forceKillTimeout = undefined;
        }
        session.output = "";
        session.codeAttempt = undefined;
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
            let forceKillTimeout: NodeJS.Timeout | undefined;

            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                child.kill();
                forceKillTimeout = setTimeout(() => {
                    forceKillTimeout = undefined;
                    if (
                        child.exitCode !== null
                        || child.signalCode !== null
                    ) return;
                    try {
                        child.kill("SIGKILL");
                    } catch {
                        // Process termination is best-effort.
                    }
                }, FORCE_KILL_GRACE_MS);
                forceKillTimeout.unref();
                reject(new Error("Claude authentication status timed out."));
            }, this.commandTimeoutMs);

            const clearForceKillTimeout = () => {
                if (!forceKillTimeout) return;
                clearTimeout(forceKillTimeout);
                forceKillTimeout = undefined;
            };

            child.stdout.on("data", (data: Buffer) => {
                stdout = appendBounded(stdout, data.toString());
            });
            child.stderr.on("data", (data: Buffer) => {
                stderr = appendBounded(stderr, data.toString());
            });
            child.on("error", (error) => {
                clearForceKillTimeout();
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
                clearForceKillTimeout();
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve({ code, stdout, stderr });
            });
        });
    }
}
