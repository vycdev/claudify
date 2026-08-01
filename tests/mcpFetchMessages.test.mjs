import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const messagesDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudify-mcp-fetch-messages-"),
);
const previousMessagesDir = process.env.MESSAGES_DIR;
process.env.MESSAGES_DIR = messagesDir;
const { createMcpServer } = await import("../build/mcp/server.js");
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
        await client.close();
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
