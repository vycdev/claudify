import type { ResponseEffortMode } from "./config.js";
import type { ClaudeEffort, ClaudeRunOptions } from "./claudeTypes.js";

export type ResponseEffortReason =
    | "fixed"
    | "morpheus"
    | "attachment"
    | "long-request"
    | "code-or-error"
    | "multi-part"
    | "reasoning-intent"
    | "simple";

export interface ResponseEffortSignals {
    question: string;
    imageCount: number;
    requiresMorpheus: boolean;
}

export interface ResponseEffortSelection {
    options: Readonly<ClaudeRunOptions>;
    reason: ResponseEffortReason;
}

const COMPLEX_REASONING_INTENT = /\b(?:analy[sz]e|analysis|compare|contrast|design|architect|plan|review|debug|diagnos(?:e|is)|troubleshoot|investigate|research|recap|summari[sz]e|explain|trade-?offs?|pros\s+and\s+cons|step\s+by\s+step|implement|refactor|optimi[sz]e|prove|derive)\b|^\s*(?:why|how\s+(?:does|do|would|can|should))\b/iu;
const CODE_OR_ERROR = /```|`[^`\n]{12,}`|\b(?:stack\s*trace|traceback|exception|compiler\s+error|runtime\s+error|type\s+error|syntax\s+error)\b/iu;
const MULTI_PART_REQUEST = /(?:^|\n)\s*(?:\d+[.)]|[-*])\s+|\b(?:first|initially)\b[\s\S]*\b(?:then|after that|finally)\b/iu;

export function classifyResponseEffort(
    signals: ResponseEffortSignals,
): Exclude<ResponseEffortReason, "fixed"> {
    if (signals.requiresMorpheus) return "morpheus";
    if (signals.imageCount > 0) return "attachment";

    const question = signals.question.trim();
    if (question.length >= 600) return "long-request";
    if (CODE_OR_ERROR.test(question)) return "code-or-error";
    if (
        MULTI_PART_REQUEST.test(question)
        || (question.match(/\?/gu)?.length ?? 0) >= 2
    ) return "multi-part";
    if (COMPLEX_REASONING_INTENT.test(question)) return "reasoning-intent";
    return "simple";
}

export function selectResponseRunOptions(
    baseOptions: Readonly<ClaudeRunOptions>,
    mode: ResponseEffortMode,
    simpleEffort: ClaudeEffort | undefined,
    signals: ResponseEffortSignals,
): ResponseEffortSelection {
    if (mode === "fixed") {
        return { options: baseOptions, reason: "fixed" };
    }

    const reason = classifyResponseEffort(signals);
    return {
        options: Object.freeze({
            ...baseOptions,
            effort: reason === "simple" ? simpleEffort : baseOptions.effort,
        }),
        reason,
    };
}
