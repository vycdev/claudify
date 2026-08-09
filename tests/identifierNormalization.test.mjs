import assert from "node:assert/strict";
import test from "node:test";

import { ChannelType, Collection, TextChannel } from "discord.js";
import {
    findChannel,
    normalizeChannelIdentifier,
    normalizeGuildIdentifier,
} from "../build/discord/helpers.js";

test("normalizes optional server identifiers before lookup", () => {
    assert.equal(normalizeGuildIdentifier("  Project Server  "), "Project Server");
    assert.equal(normalizeGuildIdentifier("   "), undefined);
    assert.equal(normalizeGuildIdentifier(undefined), undefined);
});

test("finds a channel when MCP-style identifiers have display whitespace", async () => {
    assert.equal(normalizeChannelIdentifier("  #general  "), "general");
    const [{ client }] = await Promise.all([
        import("../build/discord/client.js"),
    ]);
    const guild = {
        id: "111111111111111111",
        name: "Project Server",
        channels: { cache: new Collection() },
    };
    const channel = Object.create(TextChannel.prototype);
    Object.defineProperties(channel, {
        id: { value: "222222222222222222" },
        type: { value: ChannelType.GuildText },
        name: { value: "general" },
        guild: { value: guild },
    });
    guild.channels.cache.set(channel.id, channel);

    const originalGuildFetch = client.guilds.fetch;
    const originalChannelFetch = client.channels.fetch;
    client.guilds.cache.set(guild.id, guild);
    client.guilds.fetch = async () => {
        throw new Error("Not a guild ID");
    };
    client.channels.fetch = async () => {
        throw new Error("Not a channel ID");
    };

    try {
        assert.equal(
            await findChannel("  #general  ", "  Project Server  "),
            channel,
        );
    } finally {
        client.guilds.fetch = originalGuildFetch;
        client.channels.fetch = originalChannelFetch;
        client.guilds.cache.delete(guild.id);
    }
});
