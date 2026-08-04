import fs from "fs";
import path from "path";

const CHANNEL_HISTORY_PREFIX = "v2_";
const DATE_PATTERN = "\\d{4}-\\d{2}-\\d{2}";

export interface ChannelHistoryFile {
    channelId: string;
    channelName: string;
    date: string;
}

function sanitizeSegment(value: string, fallback: string): string {
    const sanitized = value.replace(/[^a-zA-Z0-9-_]/g, "_");
    return sanitized || fallback;
}

export function getChannelHistoryFileName(
    channelId: string,
    channelName: string,
    date: Date,
): string {
    const dateStr = date.toISOString().split("T")[0];
    const safeChannelId = sanitizeSegment(channelId, "unknown");
    const safeChannelName = sanitizeSegment(channelName, "channel");
    return `${CHANNEL_HISTORY_PREFIX}${safeChannelId}__${safeChannelName}_${dateStr}.txt`;
}

export function getChannelHistoryPath(
    directory: string,
    channelId: string,
    channelName: string,
    date: Date,
): string {
    const expectedPath = path.join(
        directory,
        getChannelHistoryFileName(channelId, channelName, date),
    );
    if (fs.existsSync(expectedPath)) return expectedPath;

    const safeChannelId = sanitizeSegment(channelId, "unknown");
    const dateStr = date.toISOString().split("T")[0];
    try {
        const existingFile = fs.readdirSync(directory).find((fileName) => {
            const parsed = parseChannelHistoryFileName(fileName);
            return parsed?.channelId === safeChannelId && parsed.date === dateStr;
        });
        return existingFile ? path.join(directory, existingFile) : expectedPath;
    } catch {
        return expectedPath;
    }
}

export function parseChannelHistoryFileName(
    fileName: string,
): ChannelHistoryFile | null {
    const match = fileName.match(
        new RegExp(`^${CHANNEL_HISTORY_PREFIX}([^_]+)__(.+)_(${DATE_PATTERN})\\.txt$`),
    );
    if (!match) return null;

    return {
        channelId: match[1],
        channelName: match[2],
        date: match[3],
    };
}
