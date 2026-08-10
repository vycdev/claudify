import assert from "node:assert/strict";
import test from "node:test";

import { TextChannel } from "discord.js";

const [{ client: discordClient }, { createMcpServer }] = await Promise.all([
    import("../build/discord/client.js"),
    import("../build/mcp/server.js"),
]);

test("read-messages preserves attachment metadata", async () => {
    const guild = {
        id: "111111111111111111",
        name: "Test Server",
    };
    const message = {
        id: "333333333333333333",
        author: { tag: "user#0001" },
        content: "See the attached document",
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        attachments: new Map([
            [
                "444444444444444444",
                {
                    id: "444444444444444444",
                    name: "notes.txt",
                    url: "https://cdn.example.test/notes.txt",
                    contentType: "text/plain",
                    size: 42,
                },
            ],
        ]),
    };
    const channel = Object.create(TextChannel.prototype);
    Object.defineProperties(channel, {
        name: { value: "general" },
        guild: { value: guild },
        messages: {
            value: {
                fetch: async () => new Map([[message.id, message]]),
            },
        },
    });

    const originalGuildFetch = discordClient.guilds.fetch;
    const originalChannelFetch = discordClient.channels.fetch;
    discordClient.guilds.fetch = async () => guild;
    discordClient.channels.fetch = async () => channel;

    const server = createMcpServer();
    try {
        const handler = server._requestHandlers.get("tools/call");
        assert.ok(handler);
        const response = await handler(
            {
                method: "tools/call",
                params: {
                    name: "read-messages",
                    arguments: {
                        server: guild.id,
                        channel: "222222222222222222",
                        limit: 1,
                    },
                },
            },
            {},
        );
        const [entry] = JSON.parse(response.content[0].text);

        assert.deepEqual(entry.attachments, [
            {
                id: "444444444444444444",
                name: "notes.txt",
                url: "https://cdn.example.test/notes.txt",
                contentType: "text/plain",
                size: 42,
            },
        ]);
    } finally {
        await server.close();
        discordClient.guilds.fetch = originalGuildFetch;
        discordClient.channels.fetch = originalChannelFetch;
    }
});
