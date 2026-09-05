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

function walkStorageTree(
    dir: string,
    onFile: (name: string, filePath: string) => number,
): number {
    try {
        const dirStat = fs.lstatSync(dir);
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return 0;

        return fs.readdirSync(dir, { withFileTypes: true }).reduce(
            (total, entry) => {
                // Storage directories may be operator-mounted, so do not follow
                // links into unrelated paths or recurse through symlink cycles.
                if (entry.isSymbolicLink()) return total;

                const filePath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    return total + walkStorageTree(filePath, onFile);
                }
                if (!entry.isFile()) return total;
                return total + onFile(entry.name, filePath);
            },
            0,
        );
    } catch {
        return 0;
    }
}

export function countStorageFiles(
    dir: string,
    extensions: readonly string[] = [".txt"],
): number {
    return walkStorageTree(
        dir,
        (name) => extensions.some((extension) => name.endsWith(extension)) ? 1 : 0,
    );
}

export function getStorageDirectorySize(dir: string): number {
    return walkStorageTree(
        dir,
        (_name, filePath) => fs.statSync(filePath).size,
    );
}

export async function handleStorage(msg: Message): Promise<void> {
    console.error(`[Bot] Storage requested by ${msg.author.tag}`);
    const formatSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    const historyCount = countStorageFiles(HISTORY_DIR);
    const pendingCount = countStorageFiles(PENDING_DIR);
    const summaryCount = countStorageFiles(SUMMARIES_DIR);
    const profileCount = countStorageFiles(PROFILES_DIR, [".txt", ".json"]);
    const historySize = getStorageDirectorySize(HISTORY_DIR);
    const pendingSize = getStorageDirectorySize(PENDING_DIR);
    const summariesSize = getStorageDirectorySize(SUMMARIES_DIR);
    const profilesSize = getStorageDirectorySize(PROFILES_DIR);
    const imagesSize = getStorageDirectorySize(IMAGES_DIR);
    const totalSize = getStorageDirectorySize(MESSAGES_DIR);

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
