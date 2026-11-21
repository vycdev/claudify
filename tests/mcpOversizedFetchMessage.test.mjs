import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TextChannel } from "discord.js";

const RESPONSE_LIMIT = 512;
const messagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-mcp-oversized-fetch-"));
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

const serverId = "111111111111111111";
const channelId = "222222222222222222";
const firstId = "333333333333333333";
const secondId = "444444444444444444";
const link = (id) => `https://discord.com/channels/${serverId}/${channelId}/${id}`;

async function fetchLinkedMessages(t, links) {
    const channel = Object.create(TextChannel.prototype);
    Object.defineProperties(channel, {
        name: { value: "general" },
        guild: { value: { id: serverId, name: "Test Server" } },
        messages: { value: { fetch: async (id) => ({
            id,
            author: { tag: "user#0001" },
            content: id === firstId ? `first-marker ${"😀".repeat(900)}` : "second-marker",
            createdAt: new Date("2026-08-01T00:00:00.000Z"),
            attachments: new Map(),
            embeds: [],
        }) } },
    });
    const originalFetch = discordClient.channels.fetch;
    discordClient.channels.fetch = async () => channel;
    const server = createMcpServer();
    const client = new Client({ name: "oversized-fetch-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const response = await client.callTool({ name: "fetch-messages", arguments: { links } });
        return response.content[0].text;
    } finally {
        discordClient.channels.fetch = originalFetch;
        await Promise.allSettled([client.close(), server.close()]);
    }
}

function assertFirstMessageExcerpt(text) {
    assert.ok(text.length <= RESPONSE_LIMIT);
    assert.match(text, /truncated/i);
    const [json] = text.split("\n\n[Fetch-messages response truncated");
    const entries = JSON.parse(json);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, firstId);
    assert.match(entries[0].content, /^first-marker/);
    assert.ok(entries[0].content.length < 1800);
    assert.doesNotMatch(entries[0].content, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
}

test("fetch-messages keeps an excerpt when its only linked message exceeds the response limit", async (t) => {
    const text = await fetchLinkedMessages(t, [link(firstId)]);
    assertFirstMessageExcerpt(text);
    assert.match(text, /message content truncated/);
    assert.doesNotMatch(text, /later result/);
});

test("fetch-messages keeps the first oversized linked message before omitting later links", async (t) => {
    const text = await fetchLinkedMessages(t, [link(firstId), link(secondId)]);
    assertFirstMessageExcerpt(text);
    assert.match(text, /1 later result\(s\) omitted/);
    assert.doesNotMatch(text, /second-marker/);
});
