import type { ConversationTurnState } from "./turn.js";

export type ResponseReason =
    | "answer"
    | "acknowledgement"
    | "clarification"
    | "correction"
    | "information"
    | "action-result"
    | "joke"
    | "skepticism"
    | "other"
    | "legacy"
    | "contract-fallback";

export interface ParsedClaudeResponse {
    reactions: string[];
    text: string;
    historyContent: string;
    reason: ResponseReason;
    targetMessageId: string | null;
    structured: boolean;
    contractFallback: boolean;
}

const STRUCTURED_REASONS: ReadonlySet<string> = new Set([
    "answer",
    "acknowledgement",
    "clarification",
    "correction",
    "information",
    "action-result",
    "joke",
    "skepticism",
    "other",
]);

interface ResponseEnvelope {
    text: string;
    reaction: string | null;
    reason: Exclude<ResponseReason, "legacy" | "contract-fallback">;
    targetMessageId: string | null;
}

function historyContent(text: string, reactions: string[]): string {
    return text || (reactions.length > 0
        ? `[reacted: ${reactions.join(", ")}]`
        : "");
}

function unwrapJsonFence(response: string): string {
    const trimmed = response.trim();
    const match = trimmed.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/iu);
    return match?.[1].trim() ?? trimmed;
}

function parseResponseEnvelope(response: string): ResponseEnvelope | undefined {
    let value: unknown;
    try {
        value = JSON.parse(unwrapJsonFence(response));
    } catch {
        return undefined;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }

    const envelope = value as Record<string, unknown>;
    if (
        typeof envelope.text !== "string"
        || (
            envelope.reaction !== null
            && typeof envelope.reaction !== "string"
        )
        || typeof envelope.reason !== "string"
        || !STRUCTURED_REASONS.has(envelope.reason)
        || (
            envelope.targetMessageId !== null
            && typeof envelope.targetMessageId !== "string"
        )
    ) {
        return undefined;
    }

    return {
        text: envelope.text.trim(),
        reaction: envelope.reaction?.trim() || null,
        reason: envelope.reason as ResponseEnvelope["reason"],
        targetMessageId: envelope.targetMessageId,
    };
}

function maskFencedCode(text: string): string {
    const lines = text.split(/(\r\n|\n|\r)/);
    let inFence = false;
    let fenceCharacter: "`" | "~" | undefined;
    let fenceLength = 0;

    return lines
        .map((line) => {
            if (line === "\r\n" || line === "\n" || line === "\r") {
                return line;
            }
            const opening = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
            const closing = line.match(/^( {0,3})(`{3,}|~{3,})[ \t]*$/);
            if (inFence) {
                if (
                    closing &&
                    closing[2][0] === fenceCharacter &&
                    closing[2].length >= fenceLength
                ) {
                    inFence = false;
                    fenceCharacter = undefined;
                    fenceLength = 0;
                }
                return " ".repeat(line.length);
            }
            if (
                opening &&
                (opening[2][0] === "~" || !opening[3].includes("`"))
            ) {
                inFence = true;
                fenceCharacter = opening[2][0] as "`" | "~";
                fenceLength = opening[2].length;
                return " ".repeat(line.length);
            }
            return line;
        })
        .join("");
}

interface InlineCodeSpan {
    start: number;
    end: number;
}

function findInlineCodeSpans(text: string): InlineCodeSpan[] {
    const spans: InlineCodeSpan[] = [];
    let index = 0;

    while (index < text.length) {
        if (text[index] !== "`") {
            index++;
            continue;
        }

        let markerEnd = index + 1;
        while (text[markerEnd] === "`") markerEnd++;
        const marker = text.slice(index, markerEnd);
        const lineBreakOffset = text.slice(markerEnd).search(/[\r\n]/);
        const lineEnd =
            lineBreakOffset === -1 ? text.length : markerEnd + lineBreakOffset;
        const closingStart = text.indexOf(marker, markerEnd);
        if (closingStart === -1 || closingStart >= lineEnd) {
            index = markerEnd;
            continue;
        }

        spans.push({
            start: index,
            end: closingStart + marker.length,
        });
        index = closingStart + marker.length;
    }

    return spans;
}

function maskInlineCode(text: string): string {
    let masked = text;
    for (const span of findInlineCodeSpans(text).reverse()) {
        masked =
            masked.slice(0, span.start) +
            " ".repeat(span.end - span.start) +
            masked.slice(span.end);
    }
    return masked;
}

export function parseClaudeResponse(response: string): ParsedClaudeResponse {
    const envelope = parseResponseEnvelope(response);
    if (envelope) {
        const reactions = envelope.reaction ? [envelope.reaction] : [];
        return {
            reactions,
            text: envelope.text,
            historyContent: historyContent(envelope.text, reactions),
            reason: envelope.reason,
            targetMessageId: envelope.targetMessageId,
            structured: true,
            contractFallback: false,
        };
    }

    const maskedResponse = maskInlineCode(maskFencedCode(response));
    const matches = [
        ...maskedResponse.matchAll(/\[REACT:(.+?)\]\s*/g),
    ];
    const reactions = matches
        .map((match) => match[1].trim())
        .filter((emoji) => emoji.length > 0);
    let text = response;
    for (let i = matches.length - 1; i >= 0; i -= 1) {
        const match = matches[i];
        text = text.slice(0, match.index) + text.slice(match.index + match[0].length);
    }
    text = text.trim();
    return {
        reactions,
        text,
        historyContent: historyContent(text, reactions),
        reason: "legacy",
        targetMessageId: null,
        structured: false,
        contractFallback: false,
    };
}

function fallbackText(state: ConversationTurnState): string {
    if (state.textRequirement === "answer-to-bot-question") return "Got it.";
    if (state.textRequirement === "current-question") {
        return "I couldn't generate a complete answer to that.";
    }
    return "I couldn't generate a complete response to that request.";
}

export function enforceResponseContract(
    parsed: ParsedClaudeResponse,
    state: ConversationTurnState,
): ParsedClaudeResponse {
    const expectedTarget = state.responseTargetMessageId;
    const targetMismatch = parsed.structured
        && parsed.targetMessageId !== expectedTarget;
    const missingRequiredText = state.requiresTextResponse && !parsed.text;

    if (!targetMismatch && !missingRequiredText) {
        return {
            ...parsed,
            targetMessageId: expectedTarget,
        };
    }

    const text = missingRequiredText ? fallbackText(state) : parsed.text;
    return {
        ...parsed,
        reactions: [],
        text,
        historyContent: historyContent(text, []),
        reason: "contract-fallback",
        targetMessageId: expectedTarget,
        contractFallback: true,
    };
}
