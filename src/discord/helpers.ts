import { TextChannel } from "discord.js";
import { client } from "./client.js";

export async function findGuild(guildIdentifier?: string) {
    if (!guildIdentifier) {
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
        const guild = await client.guilds.fetch(guildIdentifier);
        if (guild) return guild;
    } catch {
        const guilds = client.guilds.cache.filter(
            (g) => g.name.toLowerCase() === guildIdentifier.toLowerCase(),
        );

        if (guilds.size === 0) {
            const availableGuilds = Array.from(client.guilds.cache.values())
                .map((g) => `"${g.name}"`)
                .join(", ");
            throw new Error(
                `Server "${guildIdentifier}" not found. Available servers: ${availableGuilds}`,
            );
        }
        if (guilds.size > 1) {
            const guildList = guilds
                .map((g) => `${g.name} (ID: ${g.id})`)
                .join(", ");
            throw new Error(
                `Multiple servers found with name "${guildIdentifier}": ${guildList}. Please specify the server ID.`,
            );
        }
        return guilds.first()!;
    }
    throw new Error(`Server "${guildIdentifier}" not found`);
}

export async function findChannel(
    channelIdentifier: string,
    guildIdentifier?: string,
): Promise<TextChannel> {
    const guild = await findGuild(guildIdentifier);

    try {
        const channel = await client.channels.fetch(channelIdentifier);
        if (channel instanceof TextChannel && channel.guild.id === guild.id) {
            return channel;
        }
    } catch {
        const channels = guild.channels.cache.filter(
            (channel): channel is TextChannel =>
                channel instanceof TextChannel &&
                (channel.name.toLowerCase() ===
                    channelIdentifier.toLowerCase() ||
                    channel.name.toLowerCase() ===
                        channelIdentifier.toLowerCase().replace("#", "")),
        );

        if (channels.size === 0) {
            const availableChannels = guild.channels.cache
                .filter((c): c is TextChannel => c instanceof TextChannel)
                .map((c) => `"#${c.name}"`)
                .join(", ");
            throw new Error(
                `Channel "${channelIdentifier}" not found in server "${guild.name}". Available channels: ${availableChannels}`,
            );
        }
        if (channels.size > 1) {
            const channelList = channels
                .map((c) => `#${c.name} (${c.id})`)
                .join(", ");
            throw new Error(
                `Multiple channels found with name "${channelIdentifier}" in server "${guild.name}": ${channelList}. Please specify the channel ID.`,
            );
        }
        return channels.first()!;
    }
    throw new Error(
        `Channel "${channelIdentifier}" is not a text channel or not found in server "${guild.name}"`,
    );
}
