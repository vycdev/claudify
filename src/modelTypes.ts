import type { ClaudeRunResult, ClaudeWorkload } from "./claudeTypes.js";
export type ModelProvider = "claude" | "codex";
export type ModelEffort =
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";
export interface ModelRunOptions {
    workload: ClaudeWorkload;
    model?: string;
    effort?: ModelEffort;
}
// Retain the existing three-argument invocation seam for Claude and callers
// injecting a runner. Only the provider adapter interprets CLI-shaped options.
export type ModelRunner = (
    args: string[],
    input: string,
    options: ModelRunOptions,
    imagePaths?: string[],
) => Promise<ClaudeRunResult>;
