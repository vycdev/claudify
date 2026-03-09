import fs from "fs";
import path from "path";
import { HISTORY_DIR, SUMMARIES_DIR } from "../config.js";
import { runClaude } from "../claude.js";

export function getSummaryPath(channelName: string, date: Date): string {
    const dateStr = date.toISOString().split("T")[0];
    const safeName = channelName.replace(/[^a-zA-Z0-9-_]/g, "_");
    return path.join(SUMMARIES_DIR, `${safeName}_${dateStr}.txt`);
}

export function loadRecentSummaries(channelName: string, days: number = 7): string {
    const summaries: string[] = [];
    for (let i = 1; i <= days; i++) {
        const date = new Date(Date.now() - i * 86400000);
        const summaryPath = getSummaryPath(channelName, date);
        if (fs.existsSync(summaryPath)) {
            const dateStr = date.toISOString().split("T")[0];
            summaries.push(
                `[${dateStr}] ${fs.readFileSync(summaryPath, "utf-8").trim()}`,
            );
        }
    }
    return summaries.reverse().join("\n\n");
}

function getLogPath(channelName: string, date: Date): string {
    const dateStr = date.toISOString().split("T")[0];
    const safeName = channelName.replace(/[^a-zA-Z0-9-_]/g, "_");
    return path.join(HISTORY_DIR, `${safeName}_${dateStr}.txt`);
}

export async function generateDailySummary(
    channelName: string,
    date: Date,
): Promise<void> {
    const logPath = getLogPath(channelName, date);
    const summaryPath = getSummaryPath(channelName, date);

    if (!fs.existsSync(logPath) || fs.existsSync(summaryPath)) return;

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
                "You are a conversation summarizer. Summarize the following Discord chat log into a concise paragraph (max 200 words). Focus on key topics discussed, decisions made, and important information shared. Do not include greetings, small talk, or filler. Output ONLY the summary, no preamble.",
            ],
            log,
            "claude-haiku-4-5",
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
}

export async function ensureYesterdaySummaries(): Promise<void> {
    const yesterday = new Date(Date.now() - 86400000);
    try {
        const files = fs
            .readdirSync(HISTORY_DIR)
            .filter((f) => f.endsWith(".txt"));
        const dateStr = yesterday.toISOString().split("T")[0];
        const yesterdayFiles = files.filter((f) => f.includes(dateStr));
        for (const file of yesterdayFiles) {
            const channelName = file.replace(`_${dateStr}.txt`, "");
            await generateDailySummary(channelName, yesterday);
        }
    } catch (err: any) {
        console.error(
            `[Summary] Error checking yesterday summaries: ${err.message}`,
        );
    }
}
