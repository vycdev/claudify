import assert from "node:assert/strict";
import test from "node:test";

import { ChannelType, Collection, NewsChannel } from "discord.js";

const [{ client }, { findChannel }] = await Promise.all([
    import("../build/discord/client.js"),
    import("../build/discord/helpers.js"),
]);

function createAnnouncementChannel({
    channelId = "222222222222222222",
    channelName = "announcements",
    guildId = "111111111111111111",
} = {}) {
    const channel = Object.create(NewsChannel.prototype);
    const guild = {
        id: guildId,
        name: "Test Server",
        channels: { cache: new Collection() },
    };
    Object.defineProperties(channel, {
        id: { value: channelId },
        type: { value: ChannelType.GuildAnnouncement },
        name: { value: channelName },
        guild: { value: guild },
        messages: { value: {} },
    });
    guild.channels.cache.set(channel.id, channel);
    return { channel, guild };
}

test("findChannel resolves announcement channels by ID", async () => {
    const { channel, guild } = createAnnouncementChannel();
    const originalFetch = client.channels.fetch;
    client.guilds.cache.set(guild.id, guild);
    client.channels.fetch = async () => channel;

    try {
        assert.equal(await findChannel(channel.id), channel);
    } finally {
        client.channels.fetch = originalFetch;
        client.guilds.cache.delete(guild.id);
    }
});

test("findChannel resolves announcement channels by name", async () => {
    const { channel, guild } = createAnnouncementChannel();
    const originalFetch = client.channels.fetch;
    client.guilds.cache.set(guild.id, guild);
    client.channels.fetch = async () => {
        throw new Error("Not a channel ID");
    };

    try {
        assert.equal(await findChannel("#announcements"), channel);
    } finally {
        client.channels.fetch = originalFetch;
        client.guilds.cache.delete(guild.id);
    }
});

test("findChannel falls back to a numeric channel name after an ID mismatch", async () => {
    const identifier = "222222222222222222";
    const { channel: namedChannel, guild } = createAnnouncementChannel({
        channelId: "333333333333333333",
        channelName: identifier,
    });
    const { channel: otherGuildChannel } = createAnnouncementChannel({
        channelId: identifier,
        guildId: "444444444444444444",
    });
    const originalFetch = client.channels.fetch;
    client.guilds.cache.set(guild.id, guild);
    client.channels.fetch = async () => otherGuildChannel;

    try {
        assert.equal(await findChannel(identifier, guild.id), namedChannel);
    } finally {
        client.channels.fetch = originalFetch;
        client.guilds.cache.delete(guild.id);
    }
});
