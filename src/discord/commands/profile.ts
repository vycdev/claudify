import { Message, TextChannel } from "discord.js";
import { getUserProfile } from "../../storage/profiles.js";

export async function handleProfile(msg: Message): Promise<void> {
    const mentioned = msg.mentions.users.first();
    const targetUser = mentioned || msg.author;
    const profile = getUserProfile(targetUser.id);
    if (profile) {
        const header = `**Profile for ${targetUser.tag}:**\n`;
        const full = header + profile;
        if (full.length <= 2000) {
            await msg.reply(full);
        } else {
            const firstMax = 2000 - header.length;
            await msg.reply(header + profile.slice(0, firstMax));
            let remaining = profile.slice(firstMax);
            while (remaining.length > 0) {
                await (msg.channel as TextChannel).send(
                    remaining.slice(0, 2000),
                );
                remaining = remaining.slice(2000);
            }
        }
    } else {
        await msg.reply(
            `No profile found for ${targetUser.tag}. Profiles are built automatically as users interact with the bot.`,
        );
    }
}
