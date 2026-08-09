import { TextChannel } from "discord.js";
import { client } from "./client.js";

export function normalizeGuildIdentifier(
    guildIdentifier?: string,
): string | undefined {
    const normalized = guildIdentifier?.trim();
    return normalized || undefined;
}

export function normalizeChannelIdentifier(channelIdentifier: string): string {
    return channelIdentifier.trim().replace(/^#+/, "");
}

export async function findGuild(guildIdentifier?: string) {
    const normalizedGuildIdentifier = normalizeGuildIdentifier(guildIdentifier);
    if (!normalizedGuildIdentifier) {
        if (client.guilds.cache.size === 1) {
            return client.guilds.cache.first()!;
        }
        const guildList = Array.from(client.guilds.cache.values())
            .map((g) => `"${g.name}"`)
            .join(", ");
        throw new Error(
            `Bot is in multiple servers. Please specify server name or ID. Available servers: ${guildList}`,
        );
    }

    try {
        const guild = await client.guilds.fetch(normalizedGuildIdentifier);
        if (guild) return guild;
    } catch {
        const guilds = client.guilds.cache.filter(
            (g) => g.name.toLowerCase() === normalizedGuildIdentifier.toLowerCase(),
        );

        if (guilds.size === 0) {
            const availableGuilds = Array.from(client.guilds.cache.values())
                .map((g) => `"${g.name}"`)
                .join(", ");
            throw new Error(
                `Server "${normalizedGuildIdentifier}" not found. Available servers: ${availableGuilds}`,
            );
        }
        if (guilds.size > 1) {
            const guildList = guilds
                .map((g) => `${g.name} (ID: ${g.id})`)
                .join(", ");
            throw new Error(
                `Multiple servers found with name "${normalizedGuildIdentifier}": ${guildList}. Please specify the server ID.`,
            );
        }
        return guilds.first()!;
    }
    throw new Error(`Server "${normalizedGuildIdentifier}" not found`);
}

export async function findChannel(
    channelIdentifier: string,
    guildIdentifier?: string,
): Promise<TextChannel> {
    const normalizedChannelIdentifier = normalizeChannelIdentifier(channelIdentifier);
    const guild = await findGuild(guildIdentifier);

    try {
        const channel = await client.channels.fetch(normalizedChannelIdentifier);
        if (channel instanceof TextChannel && channel.guild.id === guild.id) {
            return channel;
        }
    } catch {
        const normalizedLower = normalizedChannelIdentifier.toLowerCase();
        const channels = guild.channels.cache.filter(
            (channel): channel is TextChannel =>
                channel instanceof TextChannel &&
                channel.name.toLowerCase() === normalizedLower,
        );

        if (channels.size === 0) {
            const availableChannels = guild.channels.cache
                .filter((c): c is TextChannel => c instanceof TextChannel)
                .map((c) => `"#${c.name}"`)
                .join(", ");
            throw new Error(
                `Channel "${normalizedChannelIdentifier}" not found in server "${guild.name}". Available channels: ${availableChannels}`,
            );
        }
        if (channels.size > 1) {
            const channelList = channels
                .map((c) => `#${c.name} (${c.id})`)
                .join(", ");
            throw new Error(
                `Multiple channels found with name "${normalizedChannelIdentifier}" in server "${guild.name}": ${channelList}. Please specify the channel ID.`,
            );
        }
        return channels.first()!;
    }
    throw new Error(
        `Channel "${normalizedChannelIdentifier}" is not a text channel or not found in server "${guild.name}"`,
    );
}
