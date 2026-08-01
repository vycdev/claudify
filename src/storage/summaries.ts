import fs from "fs";
import {
    HISTORY_V2_DIR,
    SUMMARIES_V2_DIR,
    BOT_EFFORT,
    BOT_MODEL,
} from "../config.js";
import { runClaude } from "../claude.js";
import { renderPrompt } from "../prompts.js";
import {
    getChannelHistoryPath,
    parseChannelHistoryFileName,
} from "./historyPaths.js";

const summariesInProgress = new Set<string>();

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
    for (let i = 1; i <= days; i++) {
        const date = new Date(Date.now() - i * 86400000);
        const summaryPath = getSummaryPath(channelId, date, channelName);
        if (fs.existsSync(summaryPath)) {
            const dateStr = date.toISOString().split("T")[0];
            summaries.push(
                `[${dateStr}] ${fs.readFileSync(summaryPath, "utf-8").trim()}`,
            );
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
        if (!log || log.split("\n").length < 3) {
            fs.writeFileSync(summaryPath, log, "utf-8");
            return;
        }

        try {
            const dateStr = date.toISOString().split("T")[0];
            console.error(
                `[Summary] Generating summary for #${channelName} on ${dateStr}`,
            );
            const { stdout } = await runClaude(
                [
                    "-p",
                    "--system-prompt",
                    renderPrompt("dailySummarySystem"),
                ],
                log,
                BOT_MODEL,
                BOT_EFFORT,
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
