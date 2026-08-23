import fs from "fs";
import {
    HISTORY_V2_DIR,
    HISTORY_RECENT_LINES,
    HISTORY_RECAP_MAX_CHARS,
    HISTORY_RECAP_MAX_LINES,
    HISTORY_SEARCH_CONTEXT_LINES,
    HISTORY_SEARCH_MAX_BLOCKS,
} from "../config.js";
import { getSummaryPath, loadRecentSummaries } from "./summaries.js";
import { getChannelHistoryPath } from "./historyPaths.js";

const HISTORY_STOP_WORDS = new Set([
    "about",
    "again",
    "also",
    "and",
    "are",
    "because",
    "been",
    "but",
    "can",
    "convo",
    "conversation",
    "day",
    "did",
    "dig",
    "everything",
    "for",
    "from",
    "full",
    "has",
    "have",
    "here",
    "history",
    "into",
    "just",
    "like",
    "messages",
    "more",
    "need",
    "not",
    "recap",
    "said",
    "show",
    "some",
    "summarize",
    "summary",
    "that",
    "the",
    "their",
    "them",
    "there",
    "this",
    "tldr",
    "today",
    "was",
    "were",
    "what",
    "when",
    "with",
    "you",
]);
const SNIPPET_SEPARATOR = "\n\n...\n\n";

export function getDailyLogPath(
    channelId: string,
    date: Date = new Date(),
    channelName: string = "channel",
): string {
    return getChannelHistoryPath(HISTORY_V2_DIR, channelId, channelName, date);
}

export function appendToLog(
    author: string,
    content: string,
    channelId: string,
    channelName: string,
    timestamp: Date = new Date(),
) {
    const filePath = getDailyLogPath(channelId, timestamp, channelName);
    const time = `${timestamp.toISOString().slice(11, 19)} UTC`;
    const normalized = content.replace(/\s+/g, " ").trim() || "[no text]";
    const line = `[${time}] ${author}: ${normalized}\n`;
    fs.appendFileSync(filePath, line, "utf-8");
}

export function isDeepHistoryRequest(question: string): boolean {
    const normalized = question.toLowerCase();
    return /\b(catch\s+(?:me\s+)?up|digest|recap|summari[sz]e|summary|tldr|tl;dr|what\s+(?:all\s+)?happened|what\s+did\s+i\s+miss)\b/.test(normalized);
}

function readLogLines(filePath: string): string[] {
    if (!fs.existsSync(filePath)) return [];
    return fs
        .readFileSync(filePath, "utf-8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

function trimLinesToBudget(
    lines: string[],
    maxLines: number,
    maxChars: number,
    separator: string = "\n",
): { lines: string[]; omitted: number } {
    let selected = [...lines];
    let omitted = 0;

    if (maxLines === 0) {
        return { lines: [], omitted: selected.length };
    }

    if (selected.length > maxLines) {
        omitted = selected.length - maxLines;
        selected = selected.slice(-maxLines);
    }

    let charCount = selected.join(separator).length;
    while (charCount > maxChars && selected.length > 0) {
        const removed = selected.shift();
        omitted++;
        charCount -= removed?.length || 0;
        if (selected.length > 0) charCount -= separator.length;
    }

    return { lines: selected, omitted };
}

function extractSearchTerms(question: string): string[] {
    const cleaned = question
        .normalize("NFC")
        .toLowerCase()
        .replace(/<@!?\d+>/g, " ")
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/[^\p{L}\p{M}\p{N}_-]+/gu, " ");

    const terms = cleaned
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => {
            const minimumLength = /^[\x00-\x7F]+$/.test(term) ? 3 : 2;
            return Array.from(term).length >= minimumLength
                && !HISTORY_STOP_WORDS.has(term);
        });

    return Array.from(new Set(terms)).slice(0, 8);
}

function buildRelevantSnippets(lines: string[], terms: string[]): string[] {
    if (terms.length === 0 || lines.length === 0) return [];

    const snippets: string[] = [];
    const usedIndexes = new Set<number>();

    for (let i = 0; i < lines.length && snippets.length < HISTORY_SEARCH_MAX_BLOCKS; i++) {
        const lowerLine = lines[i].normalize("NFC").toLowerCase();
        if (!terms.some((term) => lowerLine.includes(term))) continue;

        const start = Math.max(0, i - HISTORY_SEARCH_CONTEXT_LINES);
        const end = Math.min(lines.length, i + HISTORY_SEARCH_CONTEXT_LINES + 1);
        const blockIndexes = [];
        for (let j = start; j < end; j++) blockIndexes.push(j);

        if (blockIndexes.every((index) => usedIndexes.has(index))) continue;
        for (const index of blockIndexes) usedIndexes.add(index);

        snippets.push(blockIndexes.map((index) => lines[index]).join("\n"));
    }

    return snippets;
}

export function loadRecentHistory(
    channelId: string,
    question: string = "",
    channelName: string = "channel",
): string {
    const parts: string[] = [];
    const deepHistory = isDeepHistoryRequest(question);
    const searchTerms = extractSearchTerms(question);

    const olderSummaries = loadRecentSummaries(channelId, 7, channelName);
    if (olderSummaries) {
        parts.push(`--- Past week summaries ---\n${olderSummaries}`);
    }

    const yesterday = new Date(Date.now() - 86400000);
    const yesterdaySummary = getSummaryPath(channelId, yesterday, channelName);
    const yesterdayLog = getDailyLogPath(channelId, yesterday, channelName);
    if (!fs.existsSync(yesterdaySummary) && fs.existsSync(yesterdayLog)) {
        const lines = readLogLines(yesterdayLog);
        if (lines.length > 0) {
            const relevantSnippets = buildRelevantSnippets(lines, searchTerms);
            const charLimit = deepHistory
                ? HISTORY_RECAP_MAX_CHARS
                : Math.floor(HISTORY_RECAP_MAX_CHARS / 4);
            const selectedSnippets = trimLinesToBudget(
                relevantSnippets,
                HISTORY_SEARCH_MAX_BLOCKS,
                charLimit,
                SNIPPET_SEPARATOR,
            ).lines;
            if (selectedSnippets.length > 0) {
                parts.push(
                    `--- Yesterday relevant snippets (${selectedSnippets.length} match blocks) ---\n${selectedSnippets.join(SNIPPET_SEPARATOR)}`,
                );
            } else {
                const selectedLines = trimLinesToBudget(lines, 30, charLimit).lines;
                if (selectedLines.length > 0) {
                    parts.push(`--- Yesterday recent tail ---\n${selectedLines.join("\n")}`);
                }
            }
        }
    }

    const todayPath = getDailyLogPath(channelId, new Date(), channelName);
    if (fs.existsSync(todayPath)) {
        const lines = readLogLines(todayPath);
        const relevantSnippets = buildRelevantSnippets(lines, searchTerms);
        const lineLimit = deepHistory ? HISTORY_RECAP_MAX_LINES : HISTORY_RECENT_LINES;
        const charLimit = deepHistory ? HISTORY_RECAP_MAX_CHARS : Math.floor(HISTORY_RECAP_MAX_CHARS / 4);
        let selectedSnippets: string[] = [];
        let remainingCharLimit = charLimit;

        if (
            relevantSnippets.length > 0
            && !deepHistory
            && lineLimit > 0
            && charLimit > 0
        ) {
            selectedSnippets = trimLinesToBudget(
                relevantSnippets,
                HISTORY_SEARCH_MAX_BLOCKS,
                charLimit,
                SNIPPET_SEPARATOR,
            ).lines;
            remainingCharLimit -= selectedSnippets.join(SNIPPET_SEPARATOR).length;
        }

        const { lines: selectedLines, omitted } = trimLinesToBudget(
            lines,
            lineLimit,
            remainingCharLimit,
        );

        if (selectedSnippets.length > 0) {
            parts.push(
                `--- Today relevant snippets (${selectedSnippets.length} match blocks) ---\n${selectedSnippets.join(SNIPPET_SEPARATOR)}`,
            );
        }

        if (selectedLines.length > 0) {
            const mode = deepHistory ? "expanded for recap/older-context request" : "recent tail";
            const coverage = omitted > 0
                ? `${selectedLines.length} of ${lines.length} saved lines; ${omitted} older lines omitted`
                : `${selectedLines.length} of ${lines.length} saved lines`;
            parts.push(
                `--- Today saved channel log (${mode}; ${coverage}) ---\n${selectedLines.join("\n")}`,
            );
        } else {
            parts.push(`--- Today saved channel log ---\n(no saved messages yet)`);
        }
    }

    return parts.join("\n\n").trim() || "No previous conversation history.";
}
