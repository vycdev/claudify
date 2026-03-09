import fs from "fs";
import path from "path";
import { Message } from "discord.js";
import {
    HISTORY_DIR,
    PENDING_DIR,
    SUMMARIES_DIR,
    PROFILES_DIR,
    IMAGES_DIR,
    MESSAGES_DIR,
} from "../../config.js";

export async function handleStorage(msg: Message): Promise<void> {
    console.error(`[Bot] Storage requested by ${msg.author.tag}`);
    const countFiles = (dir: string) => {
        try {
            return fs.readdirSync(dir).filter((f) => f.endsWith(".txt")).length;
        } catch {
            return 0;
        }
    };
    const getDirSize = (dir: string): number => {
        try {
            return fs.readdirSync(dir).reduce((total, file) => {
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                return (
                    total +
                    (stat.isDirectory() ? getDirSize(filePath) : stat.size)
                );
            }, 0);
        } catch {
            return 0;
        }
    };
    const formatSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    const historyCount = countFiles(HISTORY_DIR);
    const pendingCount = countFiles(PENDING_DIR);
    const summaryCount = countFiles(SUMMARIES_DIR);
    const profileCount = countFiles(PROFILES_DIR);
    const historySize = getDirSize(HISTORY_DIR);
    const pendingSize = getDirSize(PENDING_DIR);
    const summariesSize = getDirSize(SUMMARIES_DIR);
    const profilesSize = getDirSize(PROFILES_DIR);
    const imagesSize = getDirSize(IMAGES_DIR);
    const totalSize = getDirSize(MESSAGES_DIR);

    const output = [
        `History:    ${historyCount} files (${formatSize(historySize)})`,
        `Summaries:  ${summaryCount} files (${formatSize(summariesSize)})`,
        `Profiles:   ${profileCount} files (${formatSize(profilesSize)})`,
        `Pending:    ${pendingCount} files (${formatSize(pendingSize)})`,
        `Images:     ${formatSize(imagesSize)}`,
        `Total:      ${formatSize(totalSize)}`,
    ].join("\n");

    await msg.reply("```\n" + output + "\n```");
}
