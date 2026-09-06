import fs from "fs";
import path from "path";
import { TextChannel, Message } from "discord.js";
import { MESSAGES_DIR, PENDING_DIR } from "../config.js";
import { writeVerifiedUtf8File } from "./safeRead.js";

export function savePending(msg: Message) {
    const filename = `${msg.id}.txt`;
    const content = [
        `Author: ${msg.author.tag}`,
        `Channel: #${(msg.channel as TextChannel).name}`,
        `Channel ID: ${msg.channelId}`,
        `Timestamp: ${msg.createdAt.toISOString()}`,
        `---`,
        msg.content,
    ].join("\n");
    const saved = writeVerifiedUtf8File(
        path.join(PENDING_DIR, filename),
        content,
        MESSAGES_DIR,
        PENDING_DIR,
    );
    if (!saved) {
        throw new Error("Could not safely save pending message");
    }
}

export function removePending(msgId: string) {
    const filePath = path.join(PENDING_DIR, `${msgId}.txt`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}
