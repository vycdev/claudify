import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TextChannel } from "discord.js";

import { client as discordClient } from "../build/discord/client.js";
import { createMcpServer } from "../build/mcp/server.js";

test("fetch-messages validates the server ID in message links", async () => {
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

    let server;
    let mcpClient;
    try {
        server = createMcpServer();
        mcpClient = new Client(
            { name: "fetch-messages-test", version: "1.0.0" },
            { capabilities: {} },
        );
        const [clientTransport, serverTransport] =
            InMemoryTransport.createLinkedPair();
        await Promise.all([
            server.connect(serverTransport),
            mcpClient.connect(clientTransport),
        ]);
        const response = await mcpClient.callTool({
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
        const cleanup = [];
        if (mcpClient) cleanup.push(mcpClient.close());
        if (server) cleanup.push(server.close());
        await Promise.allSettled(cleanup);
    }
});
