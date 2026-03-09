import fs from "fs";
import path from "path";
import { TextChannel, Message } from "discord.js";
import { PENDING_DIR } from "../config.js";

export function savePending(msg: Message) {
    const filename = `${msg.id}.txt`;
    const content = [
        `Author: ${msg.author.tag}`,
        `Channel: #${(msg.channel as TextChannel).name}`,
        `Timestamp: ${msg.createdAt.toISOString()}`,
        `---`,
        msg.content,
    ].join("\n");
    fs.writeFileSync(path.join(PENDING_DIR, filename), content, "utf-8");
}

export function removePending(msgId: string) {
    const filePath = path.join(PENDING_DIR, `${msgId}.txt`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}
