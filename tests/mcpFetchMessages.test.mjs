import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
    ChannelType,
    DMChannel,
    NewsChannel,
    TextChannel,
    ThreadChannel,
} from "discord.js";

const messagesDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudify-mcp-fetch-messages-"),
);
const previousMessagesDir = process.env.MESSAGES_DIR;
process.env.MESSAGES_DIR = messagesDir;
const [{ client: discordClient }, { createMcpServer }] = await Promise.all([
    import("../build/discord/client.js"),
    import("../build/mcp/server.js"),
]);
if (previousMessagesDir === undefined) {
    delete process.env.MESSAGES_DIR;
} else {
    process.env.MESSAGES_DIR = previousMessagesDir;
}
after(() => fs.rmSync(messagesDir, { recursive: true, force: true }));

async function createTestClient(t) {
    const server = createMcpServer();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(async () => {
        await Promise.allSettled([client.close(), server.close()]);
    });

    return client;
}

test("fetch-messages rejects non-string link values", async (t) => {
    const client = await createTestClient(t);

    await assert.rejects(
        client.callTool({
            name: "fetch-messages",
            arguments: { links: [123] },
        }),
        /Invalid arguments: links\.0: Expected string, received number/,
    );
});

test("fetch-messages still reports malformed string links per item", async (t) => {
    const client = await createTestClient(t);

    const result = await client.callTool({
        name: "fetch-messages",
        arguments: { links: ["not-a-discord-link"] },
    });

    assert.equal(result.content.length, 1);
    assert.match(result.content[0].text, /Invalid Discord message link format/);
});

test("fetch-messages supports guild text channel variants", async (t) => {
    for (const [kind, ChannelClass, channelType] of [
        ["thread", ThreadChannel, ChannelType.PublicThread],
        ["announcement", NewsChannel, ChannelType.GuildAnnouncement],
    ]) {
        await t.test(kind, async (t) => {
            const fetchedMessageIds = [];
            const channel = Object.create(ChannelClass.prototype);
            Object.defineProperties(channel, {
                type: { value: channelType },
                name: { value: `${kind}-channel` },
                guild: {
                    value: {
                        id: "111111111111111111",
                        name: "Expected Server",
                    },
                },
                messages: {
                    value: {
                        fetch: async (id) => {
                            fetchedMessageIds.push(id);
                            return {
                                id,
                                author: { tag: "user#0001" },
                                content: `${kind} content`,
                                createdAt: new Date(
                                    "2026-08-01T00:00:00.000Z",
                                ),
                                attachments: new Map(),
                                embeds: [],
                            };
                        },
                    },
                },
            });

            const originalFetch = discordClient.channels.fetch;
            discordClient.channels.fetch = async () => channel;
            try {
                const client = await createTestClient(t);
                const response = await client.callTool({
                    name: "fetch-messages",
                    arguments: {
                        links: [
                            "https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333",
                        ],
                    },
                });
                const [result] = JSON.parse(response.content[0].text);

                assert.equal(result.id, "333333333333333333");
                assert.equal(result.channel, `#${kind}-channel`);
                assert.equal(result.server, "Expected Server");
                assert.equal(result.content, `${kind} content`);
                assert.deepEqual(fetchedMessageIds, ["333333333333333333"]);
            } finally {
                discordClient.channels.fetch = originalFetch;
            }
        });
    }
});

test("fetch-messages rejects direct-message channels", async (t) => {
    let fetchedMessage = false;
    const channel = Object.create(DMChannel.prototype);
    Object.defineProperties(channel, {
        type: { value: ChannelType.DM },
        messages: {
            value: {
                fetch: async () => {
                    fetchedMessage = true;
                },
            },
        },
    });

    const originalFetch = discordClient.channels.fetch;
    discordClient.channels.fetch = async () => channel;
    try {
        const client = await createTestClient(t);
        const response = await client.callTool({
            name: "fetch-messages",
            arguments: {
                links: [
                    "https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333",
                ],
            },
        });
        const [result] = JSON.parse(response.content[0].text);

        assert.equal(result.error, "Channel is not a guild text channel");
        assert.equal(fetchedMessage, false);
    } finally {
        discordClient.channels.fetch = originalFetch;
    }
});

test("fetch-messages validates the server ID in message links", async (t) => {
    const fetchedMessageIds = [];
    const channel = Object.create(TextChannel.prototype);
    Object.defineProperties(channel, {
        name: { value: "general" },
        guild: {
            value: {
                id: "111111111111111111",
                name: "Expected Server",
            },
        },
        messages: {
            value: {
                fetch: async (id) => {
                    fetchedMessageIds.push(id);
                    return {
                        id,
                        author: { tag: "user#0001" },
                        content: "expected content",
                        createdAt: new Date("2026-08-01T00:00:00.000Z"),
                        attachments: new Map(),
                        embeds: [],
                    };
                },
            },
        },
    });

    const originalFetch = discordClient.channels.fetch;
    discordClient.channels.fetch = async () => channel;
    try {
        const client = await createTestClient(t);
        const response = await client.callTool({
            name: "fetch-messages",
            arguments: {
                links: [
                    "https://discord.com/channels/999999999999999999/222222222222222222/333333333333333333",
                    "https://discord.com/channels/111111111111111111/222222222222222222/444444444444444444",
                ],
            },
        });
        const results = JSON.parse(response.content[0].text);

        assert.deepEqual(results[0], {
            link: "https://discord.com/channels/999999999999999999/222222222222222222/333333333333333333",
            error: "Message link server does not match the channel's server",
        });
        assert.equal(results[1].id, "444444444444444444");
        assert.equal(results[1].server, "Expected Server");
        assert.equal(results[1].content, "expected content");
        assert.deepEqual(fetchedMessageIds, ["444444444444444444"]);
    } finally {
        discordClient.channels.fetch = originalFetch;
    }
});
