import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TextChannel } from "discord.js";

const RESPONSE_LIMIT = 79;
const messagesDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudify-mcp-small-response-limit-"),
);
const previousMessagesDir = process.env.MESSAGES_DIR;
const previousLimit = process.env.MCP_READ_MESSAGES_MAX_CHARS;
process.env.MESSAGES_DIR = messagesDir;
process.env.MCP_READ_MESSAGES_MAX_CHARS = String(RESPONSE_LIMIT);

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

async function createTestClient(t) {
    const server = createMcpServer();
    const client = new Client({ name: "small-limit-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(async () => {
        await Promise.allSettled([client.close(), server.close()]);
    });
    return client;
}

function assertBoundedTruncation(text) {
    assert.equal(typeof text, "string");
    assert.ok(text.length <= RESPONSE_LIMIT, `${text.length} > ${RESPONSE_LIMIT}`);
    assert.match(text, /truncated/i);
}

test("fetch-messages honors small configured response limits", async (t) => {
    const client = await createTestClient(t);
    const response = await client.callTool({
        name: "fetch-messages",
        arguments: {
            links: Array.from(
                { length: 100 },
                (_, index) => `invalid-${index}-${"x".repeat(100)}`,
            ),
        },
    });

    assertBoundedTruncation(response.content[0].text);
});

test("read-messages honors small configured response limits", async (t) => {
    const guild = {
        id: "111111111111111111",
        name: "Test Server",
    };
    const channel = Object.create(TextChannel.prototype);
    Object.defineProperties(channel, {
        name: { value: "general" },
        guild: { value: guild },
        messages: {
            value: {
                fetch: async () => new Map([["333333333333333333", {
                    id: "333333333333333333",
                    author: { tag: "user#0001" },
                    content: "x".repeat(500),
                    createdAt: new Date("2026-08-01T00:00:00.000Z"),
                    attachments: new Map(),
                }]]),
            },
        },
    });

    const originalGuildFetch = discordClient.guilds.fetch;
    const originalChannelFetch = discordClient.channels.fetch;
    discordClient.guilds.fetch = async () => guild;
    discordClient.channels.fetch = async () => channel;
    try {
        const client = await createTestClient(t);
        const response = await client.callTool({
            name: "read-messages",
            arguments: {
                server: guild.id,
                channel: "222222222222222222",
                limit: 1,
            },
        });

        assertBoundedTruncation(response.content[0].text);
    } finally {
        discordClient.guilds.fetch = originalGuildFetch;
        discordClient.channels.fetch = originalChannelFetch;
    }
});
