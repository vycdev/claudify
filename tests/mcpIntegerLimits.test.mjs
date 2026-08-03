import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("MCP limit fields require integers", async (t) => {
    const messagesDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-mcp-limits-"),
    );
    t.after(() => fs.rmSync(messagesDir, { recursive: true, force: true }));
    process.env.MESSAGES_DIR = messagesDir;

    const [{ Client }, { InMemoryTransport }, { createMcpServer }] =
        await Promise.all([
            import("@modelcontextprotocol/sdk/client/index.js"),
            import("@modelcontextprotocol/sdk/inMemory.js"),
            import("../build/mcp/server.js"),
        ]);
    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: "mcp-limit-test", version: "1.0.0" });
    await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(() => client.close());

    const tools = await client.listTools();
    const historySchema = tools.tools.find(
        ({ name }) => name === "read-message-history",
    )?.inputSchema;
    const liveSchema = tools.tools.find(
        ({ name }) => name === "read-messages",
    )?.inputSchema;
    assert.equal(historySchema?.properties?.limit?.type, "integer");
    assert.equal(historySchema?.properties?.maxLines?.type, "integer");
    assert.equal(liveSchema?.properties?.limit?.type, "integer");

    const fractionalCalls = [
        {
            name: "read-messages",
            arguments: { channel: "general", limit: 1.5 },
        },
        {
            name: "read-message-history",
            arguments: { limit: 1.5 },
        },
        {
            name: "read-message-history",
            arguments: { maxLines: 1.5 },
        },
    ];

    for (const request of fractionalCalls) {
        await assert.rejects(
            client.callTool(request),
            /Invalid arguments: (limit|maxLines): Expected integer/,
        );
    }
});