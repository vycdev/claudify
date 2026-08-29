import { parseAskCommand } from "./commands/ask.js";

export interface DiscordReplyContext {
    messageId: string;
    author: string;
    authorBot: boolean;
    content: string;
}

export interface DiscordInvocationContext {
    triggerKind: "message" | "reaction";
    sourceMessageId?: string;
    messageContent: string;
    historySearchText?: string;
    replyToMessageId?: string;
    replyTarget?: DiscordReplyContext;
    replyChain?: DiscordReplyContext[];
    attachments?: Array<{
        filename: string;
        url: string;
        size: number;
        contentType?: string;
        description?: string;
    }>;
}

export interface HistoricalSearchMessage {
    authorId: string;
    content: string;
    createdAt: Date;
}

export type TextRequirement =
    | "current-question"
    | "explicit-request"
    | "answer-to-bot-question";

export interface ConversationTurnState {
    version: 1;
    triggerKind: DiscordInvocationContext["triggerKind"];
    sourceMessageId: string | null;
    responseTargetMessageId: string | null;
    currentMessage: string;
    currentMessageHasQuestion: boolean;
    currentMessageHasExplicitRequest: boolean;
    directReply: {
        messageId: string;
        author: string;
        authorBot: boolean;
        content: string;
        hasQuestion: boolean;
    } | null;
    answersBotQuestion: boolean;
    requiresTextResponse: boolean;
    textRequirement: TextRequirement | null;
}

const LEADING_MENTION = /^(?:<@!?\d+>|[\p{L}\p{N}_.-]+[:,])\s*/u;
const QUESTION_OPENING = /^(?:who|what|when|where|why|how|which|whose|can|could|would|will|should|do|does|did|is|are|am|was|were|has|have|had)\b/iu;
const EXPLICIT_REQUEST = /^(?:please\s+)?(?:answer|check|compare|describe|explain|fetch|find|give|help|list|look\s+up|make|read|review|run|send|show|summari[sz]e|tell|try|write)\b/iu;
const HISTORY_SEARCH_ADJACENT_MAX_MESSAGES = 6;
const HISTORY_SEARCH_ADJACENT_MAX_GAP_MS = 10 * 60 * 1000;

export function buildHistoricalSearchText(
    currentContent: string,
    currentAuthorId: string,
    currentCreatedAt: Date,
    recentMessages: readonly HistoricalSearchMessage[],
): string {
    const candidates = recentMessages
        .filter((message) => message.createdAt < currentCreatedAt)
        .sort((left, right) =>
            left.createdAt.getTime() - right.createdAt.getTime()
        );
    const adjacent: string[] = [];
    let nextTimestamp = currentCreatedAt.getTime();

    for (
        let index = candidates.length - 1;
        index >= 0 && adjacent.length < HISTORY_SEARCH_ADJACENT_MAX_MESSAGES;
        index--
    ) {
        const message = candidates[index];
        const timestamp = message.createdAt.getTime();
        if (nextTimestamp - timestamp > HISTORY_SEARCH_ADJACENT_MAX_GAP_MS) {
            break;
        }
        if (message.authorId !== currentAuthorId) break;

        const content = message.content.trim();
        if (content) adjacent.unshift(content);
        nextTimestamp = timestamp;
    }

    return [...adjacent, currentContent.trim()].filter(Boolean).join("\n");
}

function normalizeOpening(content: string): string {
    return content.trim().replace(LEADING_MENTION, "").trim();
}

export function messageHasQuestion(content: string): boolean {
    const normalized = normalizeOpening(content);
    return /[?？]/u.test(normalized) || QUESTION_OPENING.test(normalized);
}

export function messageHasExplicitRequest(content: string): boolean {
    return parseAskCommand(content) !== null
        || EXPLICIT_REQUEST.test(normalizeOpening(content));
}

export function buildConversationTurnState(
    invocation: DiscordInvocationContext,
): ConversationTurnState {
    const directReply = invocation.replyTarget
        ? {
            messageId: invocation.replyTarget.messageId,
            author: invocation.replyTarget.author,
            authorBot: invocation.replyTarget.authorBot,
            content: invocation.replyTarget.content,
            hasQuestion: messageHasQuestion(invocation.replyTarget.content),
        }
        : null;
    const currentMessageHasQuestion = messageHasQuestion(
        invocation.messageContent,
    );
    const currentMessageHasExplicitRequest = messageHasExplicitRequest(
        invocation.messageContent,
    );
    const answersBotQuestion = Boolean(
        directReply?.authorBot && directReply.hasQuestion,
    );
    const textRequirement: TextRequirement | null = currentMessageHasQuestion
        ? "current-question"
        : currentMessageHasExplicitRequest
            ? "explicit-request"
            : answersBotQuestion
                ? "answer-to-bot-question"
                : null;

    return {
        version: 1,
        triggerKind: invocation.triggerKind,
        sourceMessageId: invocation.sourceMessageId ?? null,
        responseTargetMessageId:
            invocation.sourceMessageId
            ?? invocation.replyToMessageId
            ?? null,
        currentMessage: invocation.messageContent,
        currentMessageHasQuestion,
        currentMessageHasExplicitRequest,
        directReply,
        answersBotQuestion,
        requiresTextResponse: textRequirement !== null,
        textRequirement,
    };
}

export function renderConversationTurnState(
    state: ConversationTurnState,
): string {
    return JSON.stringify(state, null, 2);
}
