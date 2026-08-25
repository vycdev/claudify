import fs from "fs";
import path from "path";
import { RESPONSE_EVENTS_DIR } from "../config.js";

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
    fs.appendFileSync(
        getResponseEventsPath(event.channelId, new Date(event.createdAt)),
        `${JSON.stringify(event)}\n`,
        "utf8",
    );
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
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, "utf8")
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
