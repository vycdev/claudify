import { Message, TextChannel } from "discord.js";
import { getServerMemory } from "../../storage/profiles.js";
import { smartSplit } from "../split.js";

function createGuildMessageOptions(content: string) {
    return {
        content,
        allowedMentions: { parse: [] as const },
    };
}

export async function handleGuild(msg: Message): Promise<void> {
    if (!msg.guild) {
        await msg.reply("This command can only be used in a server.");
        return;
    }
    const memory = getServerMemory(msg.guild.id);
    if (memory) {
        const header = `**Server memory for ${msg.guild.name}:**\n`;
        const [first, ...remaining] = smartSplit(header + memory);
        await msg.reply(createGuildMessageOptions(first));
        for (const chunk of remaining) {
            await (msg.channel as TextChannel).send(
                createGuildMessageOptions(chunk),
            );
        }
    } else {
        await msg.reply(
            createGuildMessageOptions(
                `No server memory found for ${msg.guild.name}. Server memory is built automatically as users interact with the bot.`,
            ),
        );
    }
}
