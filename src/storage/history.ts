import fs from "fs";
import path from "path";
import {
    HISTORY_DIR,
    HISTORY_RECENT_LINES,
    HISTORY_RECAP_MAX_CHARS,
    HISTORY_RECAP_MAX_LINES,
    HISTORY_SEARCH_CONTEXT_LINES,
    HISTORY_SEARCH_MAX_BLOCKS,
} from "../config.js";
import { getSummaryPath, loadRecentSummaries } from "./summaries.js";

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

export function getDailyLogPath(channelName: string, date: Date = new Date()): string {
    const dateStr = date.toISOString().split("T")[0];
    const safeName = channelName.replace(/[^a-zA-Z0-9-_]/g, "_");
    return path.join(HISTORY_DIR, `${safeName}_${dateStr}.txt`);
}

export function appendToLog(
    author: string,
    content: string,
    channelName: string,
    timestamp: Date = new Date(),
) {
    const filePath = getDailyLogPath(channelName, timestamp);
    const time = timestamp.toTimeString().split(" ")[0];
    const normalized = content.replace(/\s+/g, " ").trim() || "[no text]";
    const line = `[${time}] ${author}: ${normalized}\n`;
    fs.appendFileSync(filePath, line, "utf-8");
}

export function isDeepHistoryRequest(question: string): boolean {
    const normalized = question.toLowerCase();
    return /\b(all|catch\s*up|digest|earlier|everything|full|recap|summari[sz]e|summary|today|tldr|tl;dr)\b/.test(normalized);
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
): { lines: string[]; omitted: number } {
    let selected = [...lines];
    let omitted = 0;

    if (selected.length > maxLines) {
        omitted = selected.length - maxLines;
        selected = selected.slice(-maxLines);
    }

    let charCount = selected.join("\n").length;
    while (charCount > maxChars && selected.length > 0) {
        const removed = selected.shift();
        omitted++;
        charCount -= (removed?.length || 0) + 1;
    }

    return { lines: selected, omitted };
}

function extractSearchTerms(question: string): string[] {
    const cleaned = question
        .toLowerCase()
        .replace(/<@!?\d+>/g, " ")
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/[^a-z0-9_-]+/g, " ");

    const terms = cleaned
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 3 && !HISTORY_STOP_WORDS.has(term));

    return Array.from(new Set(terms)).slice(0, 8);
}

function buildRelevantSnippets(lines: string[], terms: string[]): string[] {
    if (terms.length === 0 || lines.length === 0) return [];

    const snippets: string[] = [];
    const usedIndexes = new Set<number>();

    for (let i = 0; i < lines.length && snippets.length < HISTORY_SEARCH_MAX_BLOCKS; i++) {
        const lowerLine = lines[i].toLowerCase();
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

export function loadRecentHistory(channelName: string, question: string = ""): string {
    const parts: string[] = [];
    const deepHistory = isDeepHistoryRequest(question);
    const searchTerms = extractSearchTerms(question);

    const olderSummaries = loadRecentSummaries(channelName, 7);
    if (olderSummaries) {
        parts.push(`--- Past week summaries ---\n${olderSummaries}`);
    }

    const yesterday = new Date(Date.now() - 86400000);
    const yesterdaySummary = getSummaryPath(channelName, yesterday);
    const yesterdayLog = getDailyLogPath(channelName, yesterday);
    if (!fs.existsSync(yesterdaySummary) && fs.existsSync(yesterdayLog)) {
        const lines = readLogLines(yesterdayLog);
        if (lines.length > 0) {
            const relevantSnippets = buildRelevantSnippets(lines, searchTerms);
            if (relevantSnippets.length > 0) {
                parts.push(
                    `--- Yesterday relevant snippets (${relevantSnippets.length} match blocks) ---\n${relevantSnippets.join("\n\n...\n\n")}`,
                );
            } else {
                parts.push(`--- Yesterday recent tail ---\n${lines.slice(-30).join("\n")}`);
            }
        }
    }

    const todayPath = getDailyLogPath(channelName);
    if (fs.existsSync(todayPath)) {
        const lines = readLogLines(todayPath);
        const relevantSnippets = buildRelevantSnippets(lines, searchTerms);
        const lineLimit = deepHistory ? HISTORY_RECAP_MAX_LINES : HISTORY_RECENT_LINES;
        const charLimit = deepHistory ? HISTORY_RECAP_MAX_CHARS : Math.floor(HISTORY_RECAP_MAX_CHARS / 4);
        const { lines: selectedLines, omitted } = trimLinesToBudget(lines, lineLimit, charLimit);

        if (relevantSnippets.length > 0 && !deepHistory) {
            parts.push(
                `--- Today relevant snippets (${relevantSnippets.length} match blocks) ---\n${relevantSnippets.join("\n\n...\n\n")}`,
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
