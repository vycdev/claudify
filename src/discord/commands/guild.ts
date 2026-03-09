import { Message, TextChannel } from "discord.js";
import { getServerMemory } from "../../storage/profiles.js";

export async function handleGuild(msg: Message): Promise<void> {
    if (!msg.guild) {
        await msg.reply("This command can only be used in a server.");
        return;
    }
    const memory = getServerMemory(msg.guild.id);
    if (memory) {
        const header = `**Server memory for ${msg.guild.name}:**\n`;
        const full = header + memory;
        if (full.length <= 2000) {
            await msg.reply(full);
        } else {
            const firstMax = 2000 - header.length;
            await msg.reply(header + memory.slice(0, firstMax));
            let remaining = memory.slice(firstMax);
            while (remaining.length > 0) {
                await (msg.channel as TextChannel).send(
                    remaining.slice(0, 2000),
                );
                remaining = remaining.slice(2000);
            }
        }
    } else {
        await msg.reply(
            `No server memory found for ${msg.guild.name}. Server memory is built automatically as users interact with the bot.`,
        );
    }
}
