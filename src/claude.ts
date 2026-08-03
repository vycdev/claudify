import { spawn } from "child_process";

// Global concurrency limiter to avoid hitting rate limits
const MAX_CONCURRENT = 2;
const MIN_DELAY_MS = 1000; // minimum 1s between spawns
const FORCE_KILL_GRACE_MS = 5_000;
let activeCount = 0;
let lastSpawnTime = 0;
const queue: Array<{
    run: () => void;
}> = [];

function tryRunNext(): void {
    if (queue.length === 0 || activeCount >= MAX_CONCURRENT) return;

    const now = Date.now();
    const timeSinceLast = now - lastSpawnTime;
    if (timeSinceLast < MIN_DELAY_MS) {
        setTimeout(tryRunNext, MIN_DELAY_MS - timeSinceLast);
        return;
    }

    const next = queue.shift();
    if (next) {
        activeCount++;
        lastSpawnTime = Date.now();
        next.run();
    }
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        queue.push({
            run: () => {
                fn().then(resolve, reject).finally(() => {
                    activeCount--;
                    tryRunNext();
                });
            },
        });
        tryRunNext();
    });
}

function spawnClaude(
    args: string[],
    input: string,
    model?: string,
    effort?: string,
): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) env[key] = value;
        }
        delete env.MCP_SERVER_NAME;
        if (model) {
            env.ANTHROPIC_MODEL = model;
            args = ["--model", model, ...args];
        }
        if (effort) {
            args = ["--effort", effort, ...args];
        }

        console.error(
            `[Claude CLI] Spawning with model=${model || "default"}, effort=${effort || "default"}, ANTHROPIC_MODEL=${env.ANTHROPIC_MODEL || "unset"} (active: ${activeCount}/${MAX_CONCURRENT}, queued: ${queue.length})`,
        );
        const proc = spawn("claude", args, { env });

        let stdout = "";
        let stderr = "";
        let stdinError: Error | undefined;
        let timeoutError: Error | undefined;
        let forceKillTimeout: NodeJS.Timeout | undefined;

        const terminateProcess = (): void => {
            if (proc.exitCode !== null || proc.signalCode !== null) return;

            try {
                proc.kill();
            } catch {
                // The close/error handlers will settle an already-ended process.
            }
            if (forceKillTimeout) return;

            forceKillTimeout = setTimeout(() => {
                forceKillTimeout = undefined;
                if (proc.exitCode !== null || proc.signalCode !== null) return;
                try {
                    proc.kill("SIGKILL");
                } catch {
                    // Process termination is best-effort; close/error owns cleanup.
                }
            }, FORCE_KILL_GRACE_MS);
            forceKillTimeout.unref();
        };

        const clearProcessTimers = (): void => {
            clearTimeout(timeout);
            if (forceKillTimeout) {
                clearTimeout(forceKillTimeout);
                forceKillTimeout = undefined;
            }
        };

        proc.stdout.on("data", (data) => {
            stdout += data.toString();
        });
        proc.stderr.on("data", (data) => {
            stderr += data.toString();
        });

        const timeout = setTimeout(() => {
            timeoutError = new Error("Claude CLI timed out after 120 seconds");
            terminateProcess();
        }, 120000);

        proc.on("close", (code) => {
            clearProcessTimers();
            if (stdinError) {
                reject(stdinError);
            } else if (timeoutError) {
                reject(timeoutError);
            } else if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                const err: any = new Error(
                    `Claude CLI exited with code ${code}`,
                );
                err.stdout = stdout;
                err.stderr = stderr;
                reject(err);
            }
        });

        proc.on("error", (error) => {
            clearProcessTimers();
            reject(timeoutError ?? error);
        });

        proc.stdin.on("error", (error) => {
            stdinError = error;
            terminateProcess();
        });
        proc.stdin.write(input);
        proc.stdin.end();
    });
}

export function runClaude(
    args: string[],
    input: string,
    model?: string,
    effort?: string,
): Promise<{ stdout: string; stderr: string }> {
    return enqueue(() => spawnClaude(args, input, model, effort));
}
