import fs from "fs";
import path from "path";
import { HISTORY_DIR } from "../config.js";
import { getSummaryPath, loadRecentSummaries } from "./summaries.js";

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
    const line = `[${time}] ${author}: ${content}\n`;
    fs.appendFileSync(filePath, line, "utf-8");
}

export function loadRecentHistory(channelName: string): string {
    const parts: string[] = [];

    const olderSummaries = loadRecentSummaries(channelName, 7);
    if (olderSummaries) {
        parts.push(`--- Past week summaries ---\n${olderSummaries}`);
    }

    const yesterday = new Date(Date.now() - 86400000);
    const yesterdaySummary = getSummaryPath(channelName, yesterday);
    const yesterdayLog = getDailyLogPath(channelName, yesterday);
    if (fs.existsSync(yesterdaySummary)) {
        const dateStr = yesterday.toISOString().split("T")[0];
        parts.push(
            `--- Yesterday (${dateStr}) summary ---\n${fs.readFileSync(yesterdaySummary, "utf-8").trim()}`,
        );
    } else if (fs.existsSync(yesterdayLog)) {
        const content = fs.readFileSync(yesterdayLog, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());
        if (lines.length > 0) {
            parts.push(`--- Yesterday ---\n${lines.slice(-30).join("\n")}`);
        }
    }

    const todayPath = getDailyLogPath(channelName);
    if (fs.existsSync(todayPath)) {
        const content = fs.readFileSync(todayPath, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());
        if (lines.length > 50) {
            parts.push(
                `--- Today (last 50 of ${lines.length} messages) ---\n${lines.slice(-50).join("\n")}`,
            );
        } else {
            parts.push(`--- Today ---\n${content}`);
        }
    }

    return parts.join("\n\n").trim() || "No previous conversation history.";
}
