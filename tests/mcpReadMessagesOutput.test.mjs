import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TextChannel } from "discord.js";

const messagesDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudify-mcp-read-output-"),
);
const previousMessagesDir = process.env.MESSAGES_DIR;
const previousLimit = process.env.MCP_READ_MESSAGES_MAX_CHARS;
process.env.MESSAGES_DIR = messagesDir;
process.env.MCP_READ_MESSAGES_MAX_CHARS = "120000";

const [{ client: discordClient }, { createMcpServer }] = await Promise.all([
    import("../build/discord/client.js"),
    import("../build/mcp/server.js"),
]);

test.after(() => {
    fs.rmSync(messagesDir, { recursive: true, force: true });
    if (previousMessagesDir === undefined) delete process.env.MESSAGES_DIR;
    else process.env.MESSAGES_DIR = previousMessagesDir;
    if (previousLimit === undefined) delete process.env.MCP_READ_MESSAGES_MAX_CHARS;
    else process.env.MCP_READ_MESSAGES_MAX_CHARS = previousLimit;
});

test("bounds read-messages responses while retaining the newest messages", async (t) => {
    const guild = {
        id: "111111111111111111",
        name: "Test Server",
    };
    const messages = new Map(
        Array.from({ length: 100 }, (_, index) => {
            const id = String(200000000000000000n + BigInt(index));
            return [id, {
                id,
                author: { tag: "user#0001" },
                content: `${index === 0 ? "oldest-marker" : index === 99 ? "newest-marker" : "message"}-${"x".repeat(1800)}`,
                createdAt: new Date(Date.UTC(2026, 7, 1, index, 0)),
                attachments: new Map(),
            }];
        }).reverse(),
    );
    const channel = Object.create(TextChannel.prototype);
    Object.defineProperties(channel, {
        name: { value: "general" },
        guild: { value: guild },
        messages: {
            value: {
                fetch: async () => messages,
            },
        },
    });

    const originalGuildFetch = discordClient.guilds.fetch;
    const originalChannelFetch = discordClient.channels.fetch;
    discordClient.guilds.fetch = async () => guild;
    discordClient.channels.fetch = async () => channel;

    const server = createMcpServer();
    const client = new Client({ name: "read-output-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
    try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        t.after(async () => {
            await Promise.allSettled([client.close(), server.close()]);
        });

        const response = await client.callTool({
            name: "read-messages",
            arguments: {
                server: guild.id,
                channel: "222222222222222222",
                limit: 100,
            },
        });
        const text = response.content.find((item) => item.type === "text")?.text;

        assert.equal(typeof text, "string");
        assert.ok(text.length <= 120000);
        assert.match(text, /newest-marker/);
        assert.doesNotMatch(text, /oldest-marker/);
        assert.match(text, /truncated/i);
    } finally {
        discordClient.guilds.fetch = originalGuildFetch;
        discordClient.channels.fetch = originalChannelFetch;
    }
});
