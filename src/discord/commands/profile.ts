import { Message, TextChannel } from "discord.js";
import { getUserProfile } from "../../storage/profiles.js";
import { smartSplit } from "../split.js";

export function createProfileMessageOptions(content: string) {
    return {
        content,
        allowedMentions: { parse: [] as const },
    };
}

export async function handleProfile(msg: Message): Promise<void> {
    const mentioned = msg.mentions.users.first();
    const targetUser = mentioned || msg.author;
    const profile = getUserProfile(targetUser.id);
    if (profile) {
        const header = `**Profile for ${targetUser.tag}:**\n`;
        const [first, ...remaining] = smartSplit(header + profile);
        await msg.reply(createProfileMessageOptions(first));
        for (const chunk of remaining) {
            await (msg.channel as TextChannel).send(
                createProfileMessageOptions(chunk),
            );
        }
    } else {
        await msg.reply(
            createProfileMessageOptions(
                `No profile found for ${targetUser.tag}. Profiles are built automatically as users interact with the bot.`,
            ),
        );
    }
}
