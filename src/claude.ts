import { spawn } from "child_process";

// Global concurrency limiter to avoid hitting rate limits
const MAX_CONCURRENT = 2;
const MIN_DELAY_MS = 1000; // minimum 1s between spawns
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

        console.error(
            `[Claude CLI] Spawning with model=${model || "default"}, ANTHROPIC_MODEL=${env.ANTHROPIC_MODEL || "unset"} (active: ${activeCount}/${MAX_CONCURRENT}, queued: ${queue.length})`,
        );
        const proc = spawn("claude", args, { env });

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (data) => {
            stdout += data.toString();
        });
        proc.stderr.on("data", (data) => {
            stderr += data.toString();
        });

        proc.on("close", (code) => {
            if (code === 0) {
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

        proc.on("error", reject);

        proc.stdin.write(input);
        proc.stdin.end();

        setTimeout(() => {
            proc.kill();
            reject(new Error("Claude CLI timed out after 120 seconds"));
        }, 120000);
    });
}

export function runClaude(
    args: string[],
    input: string,
    model?: string,
): Promise<{ stdout: string; stderr: string }> {
    return enqueue(() => spawnClaude(args, input, model));
}
