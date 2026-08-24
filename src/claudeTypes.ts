import type { ClaudeExecutionTrace } from "./claudeStream.js";

export type ClaudeWorkload =
    | "response"
    | "profile-update"
    | "server-memory-update"
    | "daily-summary";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeRunOptions {
    workload: ClaudeWorkload;
    model?: string;
    effort?: ClaudeEffort;
}

export interface ClaudeRunResult {
    stdout: string;
    stderr: string;
    trace?: ClaudeExecutionTrace;
}
