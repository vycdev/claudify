import type { ClaudeExecutionTrace } from "./claudeStream.js";

export interface MorpheusGroundingAssessment {
    grounded: boolean;
    morpheusCallCount: number;
    reason: "grounded" | "missing-call" | "missing-result";
}

const MORPHEUS_SIGNAL = /\bmorpheus\b|(?:^|\s)m![a-z0-9]/iu;
const CONTEXTUAL_ACTION = /^(?:please\s+)?(?:try(?:\s+it)?\s+again|retry|do\s+(?:it|that)|run\s+(?:it|that)|execute\s+(?:it|that)|press\s+(?:it|the\s+button)|use\s+(?:it|that)|run\s+(?:the\s+)?(?:top|activity|leaderboard|command)|(?:the\s+)?top\s+command(?:\s+again)?|check\s+(?:it|that)(?:\s+again)?)\W*$/iu;
const RETRY_SAFE_TOOL_NAMES = new Set([
    "Glob",
    "Grep",
    "Read",
    "ToolSearch",
    "WebFetch",
    "WebSearch",
    "mcp__discord__fetch-messages",
    "mcp__discord__read-message-history",
    "mcp__discord__read-messages",
]);

export const MORPHEUS_GROUNDING_RETRY_INSTRUCTION = [
    "=== Harness-required retry ===",
    "This request requires Morpheus grounding, but the previous attempt made no Morpheus MCP call.",
    "Retry the request from scratch and call at least one relevant mcp__morpheus__ tool before answering.",
    "Ground claims about availability, execution, and results only in returned tool data. If the tool fails, report that failure instead of inventing a result.",
].join("\n");

export function requiresMorpheusGrounding(
    question: string,
    replyContext: string,
    liveContext: string,
): boolean {
    if (MORPHEUS_SIGNAL.test(question)) return true;
    if (!CONTEXTUAL_ACTION.test(question.trim())) return false;
    return MORPHEUS_SIGNAL.test(replyContext)
        || MORPHEUS_SIGNAL.test(liveContext);
}

export function assessMorpheusGrounding(
    trace: ClaudeExecutionTrace | undefined,
): MorpheusGroundingAssessment {
    const calls = trace?.toolCalls.filter((call) =>
        call.name.startsWith("mcp__morpheus__")
    ) ?? [];
    if (calls.length === 0) {
        return {
            grounded: false,
            morpheusCallCount: 0,
            reason: "missing-call",
        };
    }
    if (calls.some((call) => call.resultStatus === "pending")) {
        return {
            grounded: false,
            morpheusCallCount: calls.length,
            reason: "missing-result",
        };
    }
    return {
        grounded: true,
        morpheusCallCount: calls.length,
        reason: "grounded",
    };
}

export function canRetryMissingMorpheusCall(
    trace: ClaudeExecutionTrace | undefined,
): boolean {
    return trace !== undefined
        && trace.toolCalls.every((call) => RETRY_SAFE_TOOL_NAMES.has(call.name));
}
