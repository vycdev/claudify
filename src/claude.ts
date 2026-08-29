import { spawn } from "child_process";
import {
    ClaudeStreamCollector,
    type ClaudeExecutionTrace,
} from "./claudeStream.js";
import type { ClaudeRunOptions, ClaudeRunResult } from "./claudeTypes.js";

export interface ClaudeExecutable {
    command: string;
    args?: readonly string[];
}

// Global concurrency limiter to avoid hitting rate limits
const MAX_CONCURRENT = 2;
const MIN_DELAY_MS = 1000; // minimum 1s between spawns
const FORCE_KILL_GRACE_MS = 5_000;
const MAX_CAPTURED_OUTPUT = 64 * 1024;
export const CLAUDE_TIMEOUT_CODE = "CLAUDE_TIMEOUT";

interface ClaudeExecutionError extends Error {
    code?: string;
    stdout?: string;
    stderr?: string;
    trace?: ClaudeExecutionTrace;
    timeoutMs?: number;
}

export function isClaudeTimeoutError(
    error: unknown,
): error is ClaudeExecutionError {
    return error instanceof Error
        && (error as ClaudeExecutionError).code === CLAUDE_TIMEOUT_CODE;
}

function appendBounded(current: string, chunk: string): string {
    const combined = current + chunk;
    if (combined.length <= MAX_CAPTURED_OUTPUT) return combined;

    const start = combined.length - MAX_CAPTURED_OUTPUT;
    const firstCodeUnit = combined.charCodeAt(start);
    const previousCodeUnit = combined.charCodeAt(start - 1);
    const splitsSurrogatePair =
        firstCodeUnit >= 0xDC00
        && firstCodeUnit <= 0xDFFF
        && previousCodeUnit >= 0xD800
        && previousCodeUnit <= 0xDBFF;
    return combined.slice(splitsSurrogatePair ? start + 1 : start);
}
let activeCount = 0;
let activeBackgroundCount = 0;
let lastSpawnTime = 0;
const queue: Array<{
    workload: ClaudeRunOptions["workload"];
    run: () => void;
}> = [];

function isBackgroundWorkload(workload: ClaudeRunOptions["workload"]): boolean {
    return workload !== "response";
}

function tryRunNext(): void {
    if (queue.length === 0 || activeCount >= MAX_CONCURRENT) return;

    const now = Date.now();
    const timeSinceLast = now - lastSpawnTime;
    if (timeSinceLast < MIN_DELAY_MS) {
        setTimeout(tryRunNext, MIN_DELAY_MS - timeSinceLast);
        return;
    }

    const responseIndex = queue.findIndex((item) => item.workload === "response");
    const nextIndex = responseIndex >= 0
        ? responseIndex
        : activeBackgroundCount === 0
            ? 0
            : -1;
    if (nextIndex < 0) return;

    const [next] = queue.splice(nextIndex, 1);
    if (next) {
        activeCount++;
        if (isBackgroundWorkload(next.workload)) activeBackgroundCount++;
        lastSpawnTime = Date.now();
        next.run();
    }
}

function enqueue<T>(
    workload: ClaudeRunOptions["workload"],
    fn: () => Promise<T>,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        queue.push({
            workload,
            run: () => {
                fn().then(resolve, reject).finally(() => {
                    activeCount--;
                    if (isBackgroundWorkload(workload)) {
                        activeBackgroundCount--;
                    }
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
    options: ClaudeRunOptions,
    executable: ClaudeExecutable,
): Promise<ClaudeRunResult> {
    return new Promise((resolve, reject) => {
        const { workload, model, effort } = options;
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (key.toUpperCase() === "CLAUDECODE") continue;
            if (value !== undefined) env[key] = value;
        }
        delete env.MCP_SERVER_NAME;
        delete env.ANTHROPIC_MODEL;
        let claudeArgs = [...args];
        if (model) {
            env.ANTHROPIC_MODEL = model;
            claudeArgs = ["--model", model, ...claudeArgs];
        }
        if (effort) {
            claudeArgs = ["--effort", effort, ...claudeArgs];
        }

        console.error(
            `[Claude CLI][${workload}] Spawning with model=${model || "default"}, effort=${effort || "default"}, ANTHROPIC_MODEL=${env.ANTHROPIC_MODEL || "unset"} (active: ${activeCount}/${MAX_CONCURRENT}, queued: ${queue.length})`,
        );
        const proc = spawn(
            executable.command,
            [...(executable.args ?? []), ...claudeArgs],
            { env },
        );

        let stdout = "";
        let stderr = "";
        const streamCollector = claudeArgs.some((arg, index) =>
            (
                arg === "--output-format"
                && claudeArgs[index + 1] === "stream-json"
            ) || arg === "--output-format=stream-json"
        ) ? new ClaudeStreamCollector() : undefined;
        let stdinError: Error | undefined;
        let timeoutError: ClaudeExecutionError | undefined;
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

        proc.stdout.setEncoding("utf8");
        proc.stderr.setEncoding("utf8");
        proc.stdout.on("data", (data) => {
            if (streamCollector) streamCollector.consume(data);
            else stdout = appendBounded(stdout, data);
        });
        proc.stderr.on("data", (data) => {
            stderr = appendBounded(stderr, data);
        });

        const timeout = setTimeout(() => {
            timeoutError = new Error(
                `Claude CLI [${workload}] timed out after 120 seconds`,
            );
            timeoutError.code = CLAUDE_TIMEOUT_CODE;
            timeoutError.timeoutMs = 120_000;
            terminateProcess();
        }, 120000);

        proc.on("close", (code) => {
            clearProcessTimers();
            if (stdinError) {
                reject(stdinError);
            } else if (timeoutError) {
                const streamResult = streamCollector?.finish();
                timeoutError.stdout = streamResult?.result ?? stdout;
                timeoutError.stderr = stderr;
                if (streamResult) timeoutError.trace = streamResult.trace;
                reject(timeoutError);
            } else if (code === 0) {
                if (streamCollector) {
                    const streamResult = streamCollector.finish();
                    resolve({
                        stdout: streamResult.result,
                        stderr,
                        trace: streamResult.trace,
                    });
                } else {
                    resolve({ stdout, stderr });
                }
            } else {
                const streamResult = streamCollector?.finish();
                const err: any = new Error(
                    `Claude CLI [${workload}] exited with code ${code}`,
                );
                err.stdout = streamResult?.result ?? stdout;
                if (streamResult) err.trace = streamResult.trace;
                err.stderr = stderr;
                reject(err);
            }
        });

        proc.on("error", (error) => {
            clearProcessTimers();
            reject(
                timeoutError
                ?? new Error(
                    `Claude CLI [${workload}] failed to start: ${error.message}`,
                ),
            );
        });

        proc.stdin.on("error", (error) => {
            stdinError = new Error(
                `Claude CLI [${workload}] stdin failed: ${error.message}`,
            );
            terminateProcess();
        });
        proc.stdin.write(input);
        proc.stdin.end();
    });
}

export function createClaudeRunner(
    executable: ClaudeExecutable = { command: "claude" },
): (
    args: string[],
    input: string,
    options: ClaudeRunOptions,
) => Promise<ClaudeRunResult> {
    return (args, input, options) => enqueue(
        options.workload,
        () => spawnClaude(args, input, options, executable),
    );
}

export const runClaude = createClaudeRunner();
