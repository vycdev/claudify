import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolvePrivateCodexHome } from "./codexHome.js";
import { CODEX_HOST_OVERRIDE } from "./codexPolicy.js";

export interface CodexClient {
    request(
        method: string,
        params?: Record<string, unknown>,
    ): Promise<Record<string, unknown>>;
    onNotification(
        listener: (method: string, params: Record<string, unknown>) => void,
    ): () => void;
    close(): void;
}

export interface CodexClientOptions {
    home: string;
    forbiddenRoots?: readonly string[];
    executable?: { command: string; args?: readonly string[] };
    requestTimeoutMs?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

// Only transport prerequisites reach Codex. In particular, no bot token, API
// key, inherited provider endpoint, or ambient NODE_OPTIONS reaches the child.
function environment(home: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { CODEX_HOME: home };
    for (const key of [
        "PATH",
        "HOME",
        "USERPROFILE",
        "SYSTEMROOT",
        "WINDIR",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LANG",
        "LC_ALL",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
    ]) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return env;
}

export async function createCodexClient(
    options: CodexClientOptions,
): Promise<CodexClient> {
    const home = resolvePrivateCodexHome(options.home, options.forbiddenRoots);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    resolvePrivateCodexHome(home, options.forbiddenRoots);
    const stat = fs.lstatSync(home);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(
            "Codex home must be a private directory, not a symbolic link.",
        );
    }
    fs.chmodSync(home, 0o700);
    // This bot owns its Codex home. Do not load an unrelated CLI profile,
    // custom provider, MCP process, hook, or API-key configuration from it.
    if (fs.existsSync(path.join(home, "config.toml"))) {
        throw new Error(
            "Claudify requires a dedicated CODEX_HOME without config.toml; configure the bot through environment variables.",
        );
    }
    const executable = options.executable ?? { command: "codex" };
    const proc = spawn(
        executable.command,
        [
            ...(executable.args ?? []),
            "app-server",
            "--listen",
            "stdio://",
            "-c",
            'forced_login_method="chatgpt"',
            "-c",
            'cli_auth_credentials_store="file"',
            "-c",
            'model_provider="openai"',
            "-c",
            CODEX_HOST_OVERRIDE,
        ],
        { env: environment(home), cwd: home, stdio: ["pipe", "pipe", "pipe"] },
    );
    let sequence = 0;
    let closed = false;
    let buffer = "";
    const listeners = new Set<
        (method: string, params: Record<string, unknown>) => void
    >();
    const pending = new Map<
        number,
        {
            resolve: (value: Record<string, unknown>) => void;
            reject: (error: Error) => void;
            timer: NodeJS.Timeout;
        }
    >();
    const notify = (method: string, params: Record<string, unknown>): void => {
        for (const listener of [...listeners]) listener(method, params);
    };
    const close = (): void => {
        if (closed) return;
        closed = true;
        buffer = "";
        for (const item of pending.values()) {
            clearTimeout(item.timer);
            item.reject(new Error("Codex connection closed."));
        }
        pending.clear();
        proc.stdin.destroy();
        proc.kill("SIGTERM");
        const killTimer = setTimeout(() => {
            if (proc.exitCode === null && proc.signalCode === null)
                proc.kill("SIGKILL");
        }, 1000);
        killTimer.unref();
        proc.once("close", () => clearTimeout(killTimer));
        notify("$closed", {});
        listeners.clear();
    };
    const send = (message: Record<string, unknown>): void => {
        if (closed) throw new Error("Codex connection closed.");
        proc.stdin.write(`${JSON.stringify(message)}\n`);
    };
    proc.on("error", close);
    proc.on("close", close);
    proc.stdin.on("error", close);
    // Auth URLs, codes and provider diagnostics must never enter bot logs.
    proc.stderr.resume();
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
        if (closed) return;
        buffer += chunk;
        if (buffer.length > 8 * 1024 * 1024) {
            close();
            return;
        }
        let newline: number;
        while (!closed && (newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            let message: Record<string, unknown> | undefined;
            try {
                message = record(JSON.parse(line));
            } catch {
                close();
                return;
            }
            if (!message) {
                close();
                return;
            }
            if (typeof message.method === "string") {
                if (message.id !== undefined) {
                    // The bot never grants shell, file-edit or permission requests.
                    try {
                        send({
                            id: message.id,
                            error: {
                                code: -32601,
                                message:
                                    "Interactive tool requests are not permitted by Claudify.",
                            },
                        });
                    } catch {
                        close();
                        return;
                    }
                } else notify(message.method, record(message.params) ?? {});
                continue;
            }
            if (typeof message.id !== "number") continue;
            const item = pending.get(message.id);
            if (!item) continue;
            pending.delete(message.id);
            clearTimeout(item.timer);
            if (message.error)
                item.reject(
                    new Error(
                        "Codex rejected the request. Check authentication, model availability, and CLI compatibility.",
                    ),
                );
            else item.resolve(record(message.result) ?? {});
        }
    });
    const client: CodexClient = {
        request(method, params = {}) {
            if (closed)
                return Promise.reject(new Error("Codex connection closed."));
            const id = ++sequence;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error("Codex request timed out."));
                    close();
                }, options.requestTimeoutMs ?? 30_000);
                pending.set(id, { resolve, reject, timer });
                try {
                    send({ id, method, params });
                } catch {
                    close();
                }
            });
        },
        onNotification(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        close,
    };
    try {
        await client.request("initialize", {
            clientInfo: {
                name: "claudify",
                title: "Claudify",
                version: "1.0.0",
            },
            capabilities: { experimentalApi: true },
        });
        send({ method: "initialized", params: {} });
        return client;
    } catch (error) {
        close();
        throw error;
    }
}
