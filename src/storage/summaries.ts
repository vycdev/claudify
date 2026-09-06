import fs from "fs";
import {
    CLAUDE_WORKLOAD_CONFIG,
    HISTORY_RECAP_MAX_CHARS,
    HISTORY_RECAP_MAX_LINES,
    HISTORY_V2_DIR,
    SUMMARIES_V2_DIR,
} from "../config.js";
import { runClaude } from "../claude.js";
import { renderPrompt } from "../prompts.js";
import {
    getChannelHistoryPath,
    parseChannelHistoryFileName,
} from "./historyPaths.js";

const summariesInProgress = new Set<string>();

function truncateUtf16(text: string, maxChars: number): string {
    let end = Math.min(text.length, maxChars);
    if (
        end > 0 &&
        end < text.length &&
        /[\uD800-\uDBFF]/.test(text[end - 1]) &&
        /[\uDC00-\uDFFF]/.test(text[end])
    ) {
        end--;
    }
    return text.slice(0, end);
}

function trimSummaryInput(log: string): string {
    const lines = log.split("\n");
    const selected = HISTORY_RECAP_MAX_LINES === 0
        ? []
        : lines.slice(-HISTORY_RECAP_MAX_LINES);

    while (
        selected.length > 0 &&
        selected.join("\n").length > HISTORY_RECAP_MAX_CHARS
    ) {
        selected.shift();
    }

    return selected.join("\n").trim();
}
type ClaudeRunner = typeof runClaude;

export function getSummaryPath(
    channelId: string,
    date: Date,
    channelName: string = "channel",
): string {
    return getChannelHistoryPath(SUMMARIES_V2_DIR, channelId, channelName, date);
}

export function loadRecentSummaries(
    channelId: string,
    days: number = 7,
    channelName: string = "channel",
): string {
    const summaries: string[] = [];
    let remainingChars = HISTORY_RECAP_MAX_CHARS;
    for (let i = 1; i <= days; i++) {
        const date = new Date(Date.now() - i * 86400000);
        const summaryPath = getSummaryPath(channelId, date, channelName);
        if (fs.existsSync(summaryPath)) {
            const summary = fs
                .readFileSync(summaryPath, "utf-8")
                .trim();
            if (!summary) continue;

            const dateStr = date.toISOString().split("T")[0];
            const prefix = `[${dateStr}] `;
            const separatorLength = summaries.length > 0 ? 2 : 0;
            const contentBudget =
                remainingChars - prefix.length - separatorLength;
            if (contentBudget <= 0) break;

            const boundedSummary = truncateUtf16(summary, contentBudget);
            if (!boundedSummary) continue;
            summaries.push(`${prefix}${boundedSummary}`);
            remainingChars -=
                prefix.length + boundedSummary.length + separatorLength;
        }
    }
    return summaries.reverse().join("\n\n");
}

function getLogPath(channelId: string, channelName: string, date: Date): string {
    return getChannelHistoryPath(HISTORY_V2_DIR, channelId, channelName, date);
}

export async function generateDailySummary(
    channelId: string,
    channelName: string,
    date: Date,
    claudeRunner: ClaudeRunner = runClaude,
): Promise<void> {
    const logPath = getLogPath(channelId, channelName, date);
    const summaryPath = getSummaryPath(channelId, date, channelName);

    if (
        !fs.existsSync(logPath) ||
        fs.existsSync(summaryPath) ||
        summariesInProgress.has(summaryPath)
    ) {
        return;
    }

    summariesInProgress.add(summaryPath);
    try {
        const log = fs.readFileSync(logPath, "utf-8").trim();
        const summaryInput = trimSummaryInput(log);
        if (!summaryInput || summaryInput.split("\n").length < 2) {
            fs.writeFileSync(summaryPath, summaryInput, "utf-8");
            return;
        }

        try {
            const dateStr = date.toISOString().split("T")[0];
            console.error(
                `[Summary] Generating summary for #${channelName} on ${dateStr}`,
            );
            const { stdout } = await claudeRunner(
                [
                    "-p",
                    "--system-prompt",
                    renderPrompt("dailySummarySystem"),
                ],
                summaryInput,
                CLAUDE_WORKLOAD_CONFIG["daily-summary"],
            );

            if (stdout.trim()) {
                fs.writeFileSync(summaryPath, stdout.trim(), "utf-8");
                console.error(
                    `[Summary] Saved summary for #${channelName} on ${dateStr}`,
                );
            }
        } catch (err: any) {
            console.error(`[Summary] Failed to generate summary: ${err.message}`);
        }
    } finally {
        summariesInProgress.delete(summaryPath);
    }
}

export async function ensureYesterdaySummaries(): Promise<void> {
    const yesterday = new Date(Date.now() - 86400000);
    try {
        const files = fs
            .readdirSync(HISTORY_V2_DIR)
            .filter((f) => f.endsWith(".txt"));
        const dateStr = yesterday.toISOString().split("T")[0];
        const yesterdayFiles = files.filter((file) => {
            const parsed = parseChannelHistoryFileName(file);
            return parsed?.date === dateStr;
        });
        for (const file of yesterdayFiles) {
            const parsed = parseChannelHistoryFileName(file);
            if (!parsed) continue;
            await generateDailySummary(
                parsed.channelId,
                parsed.channelName,
                yesterday,
            );
        }
    } catch (err: any) {
        console.error(
            `[Summary] Error checking yesterday summaries: ${err.message}`,
        );
    }
}
