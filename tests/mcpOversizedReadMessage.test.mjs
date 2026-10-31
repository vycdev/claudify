import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TextChannel } from "discord.js";

const RESPONSE_LIMIT = 512;
const messagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-mcp-oversized-live-"));
const previousDir = process.env.MESSAGES_DIR;
const previousLimit = process.env.MCP_READ_MESSAGES_MAX_CHARS;
process.env.MESSAGES_DIR = messagesDir;
process.env.MCP_READ_MESSAGES_MAX_CHARS = String(RESPONSE_LIMIT);

const [{ client: discordClient }, { createMcpServer }] = await Promise.all([
    import("../build/discord/client.js"),
    import("../build/mcp/server.js"),
]);

test.after(() => {
    fs.rmSync(messagesDir, { recursive: true, force: true });
    if (previousDir === undefined) delete process.env.MESSAGES_DIR;
    else process.env.MESSAGES_DIR = previousDir;
    if (previousLimit === undefined) delete process.env.MCP_READ_MESSAGES_MAX_CHARS;
    else process.env.MCP_READ_MESSAGES_MAX_CHARS = previousLimit;
});

test("read-messages retains a bounded excerpt of the newest oversized message", async (t) => {
    const guild = { id: "111111111111111111", name: "Test Server" };
    const channel = Object.create(TextChannel.prototype);
    Object.defineProperties(channel, {
        name: { value: "general" },
        guild: { value: guild },
        messages: { value: { fetch: async () => new Map([
            ["333333333333333333", {
                id: "333333333333333333",
                author: { tag: "user#0001" },
                content: `newest-marker ${"😀".repeat(700)}`,
                createdAt: new Date("2026-08-01T00:00:00.000Z"),
                attachments: new Map(),
                embeds: [],
            }],
            ["222222222222222222", {
                id: "222222222222222222",
                author: { tag: "user#0001" },
                content: "oldest-marker",
                createdAt: new Date("2026-07-31T00:00:00.000Z"),
                attachments: new Map(),
                embeds: [],
            }],
        ]) } },
    });
    const originalGuildFetch = discordClient.guilds.fetch;
    const originalChannelFetch = discordClient.channels.fetch;
    discordClient.guilds.fetch = async () => guild;
    discordClient.channels.fetch = async () => channel;
    const server = createMcpServer();
    const client = new Client({ name: "oversized-read-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        t.after(async () => {
            await Promise.allSettled([client.close(), server.close()]);
        });
        const response = await client.callTool({
            name: "read-messages",
            arguments: { server: guild.id, channel: "222222222222222222", limit: 2 },
        });
        const text = response.content[0].text;
        assert.ok(text.length <= RESPONSE_LIMIT);
        assert.match(text, /truncated/i);
        assert.match(text, /newest-marker/);
        assert.doesNotMatch(text, /oldest-marker/);
        const data = JSON.parse(text.slice(0, text.indexOf("\n\n[Read-messages response truncated")));
        assert.equal(data.length, 1);
        assert.equal(data[0].id, "333333333333333333");
        assert.doesNotMatch(data[0].content, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    } finally {
        discordClient.guilds.fetch = originalGuildFetch;
        discordClient.channels.fetch = originalChannelFetch;
    }
});
