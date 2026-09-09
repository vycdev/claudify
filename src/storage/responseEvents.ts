import path from "path";
import { MESSAGES_DIR, RESPONSE_EVENTS_DIR } from "../config.js";
import {
    readVerifiedUtf8File,
    writeVerifiedUtf8File,
} from "./safeRead.js";

export type ResponseEventReason =
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

export type ResponseEventTextRequirement =
    | "current-question"
    | "explicit-request"
    | "answer-to-bot-question";

export interface ResponseEvent {
    version: 1;
    createdAt: string;
    channelId: string;
    guildId: string | null;
    authorId: string;
    sourceMessageId: string | null;
    replyToMessageId: string | null;
    responseTargetMessageId: string | null;
    reason: ResponseEventReason;
    reaction: string | null;
    textRequired: boolean;
    textRequirement: ResponseEventTextRequirement | null;
    textPresent: boolean;
    structured: boolean;
    contractFallback: boolean;
}

function dateKey(date: Date): string {
    return date.toISOString().slice(0, 10);
}

export function getResponseEventsPath(
    channelId: string,
    date: Date = new Date(),
): string {
    return path.join(
        RESPONSE_EVENTS_DIR,
        `${encodeURIComponent(channelId)}_${dateKey(date)}.jsonl`,
    );
}

export function appendResponseEvent(event: ResponseEvent): void {
    const filePath = getResponseEventsPath(
        event.channelId,
        new Date(event.createdAt),
    );
    const existing = readVerifiedUtf8File(
        filePath,
        MESSAGES_DIR,
        RESPONSE_EVENTS_DIR,
    );
    if (existing.state === "unsafe") {
        throw new Error("Could not safely read response events");
    }
    const text = `${existing.state === "valid" ? existing.text : ""}${JSON.stringify(event)}\n`;
    if (!writeVerifiedUtf8File(
        filePath,
        text,
        MESSAGES_DIR,
        RESPONSE_EVENTS_DIR,
    )) {
        throw new Error("Could not safely save response event");
    }
}

function isResponseEvent(value: unknown): value is ResponseEvent {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const event = value as Partial<ResponseEvent>;
    return event.version === 1
        && typeof event.createdAt === "string"
        && typeof event.channelId === "string"
        && typeof event.authorId === "string"
        && typeof event.reason === "string"
        && typeof event.textRequired === "boolean"
        && typeof event.textPresent === "boolean"
        && typeof event.structured === "boolean"
        && typeof event.contractFallback === "boolean";
}

function readEvents(filePath: string): ResponseEvent[] {
    const result = readVerifiedUtf8File(
        filePath,
        MESSAGES_DIR,
        RESPONSE_EVENTS_DIR,
    );
    if (result.state !== "valid") return [];
    return result.text
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
            try {
                const value: unknown = JSON.parse(line);
                return isResponseEvent(value) ? [value] : [];
            } catch {
                return [];
            }
        });
}

export function loadRecentResponseEvents(
    channelId: string,
    limit: number = 8,
    now: Date = new Date(),
): ResponseEvent[] {
    if (limit <= 0) return [];
    const yesterday = new Date(now.getTime() - 86_400_000);
    return [
        ...readEvents(getResponseEventsPath(channelId, yesterday)),
        ...readEvents(getResponseEventsPath(channelId, now)),
    ].slice(-limit);
}
