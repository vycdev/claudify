import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("bounds read-message-history responses while retaining the newest entries", async (t) => {
    const messagesDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-mcp-history-output-"),
    );
    const previousMessagesDir = process.env.MESSAGES_DIR;
    process.env.MESSAGES_DIR = messagesDir;

    const [{ Client }, { InMemoryTransport }, { createMcpServer }] =
        await Promise.all([
            import("@modelcontextprotocol/sdk/client/index.js"),
            import("@modelcontextprotocol/sdk/inMemory.js"),
            import("../build/mcp/server.js"),
        ]);

    const historyDir = path.join(messagesDir, "history");
    const oversizedEntry = (marker) => Array.from(
        { length: 120 },
        (_, index) => `[10:00:${String(index).padStart(2, "0")}] user: ${marker}-${"x".repeat(1600)}`,
    ).join("\n");
    fs.writeFileSync(
        path.join(historyDir, "a_2026-08-01.txt"),
        oversizedEntry("older"),
        "utf8",
    );
    fs.writeFileSync(
        path.join(historyDir, "z_2026-08-02.txt"),
        oversizedEntry("newest"),
        "utf8",
    );

    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: "history-output-test", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(async () => {
        await client.close();
        await server.close();
        fs.rmSync(messagesDir, { recursive: true, force: true });
        if (previousMessagesDir === undefined) delete process.env.MESSAGES_DIR;
        else process.env.MESSAGES_DIR = previousMessagesDir;
    });

    const result = await client.callTool({
        name: "read-message-history",
        arguments: { limit: 100, maxLines: 2000 },
    });
    const text = result.content.find((item) => item.type === "text")?.text;

    assert.equal(typeof text, "string");
    assert.ok(text.length <= 120_000);
    assert.match(text, /newest/);
    assert.match(text, /truncated/i);
});
