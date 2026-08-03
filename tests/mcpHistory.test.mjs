import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("history date filters match only the log date suffix", async (t) => {
    const messagesDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-mcp-history-"),
    );
    t.after(() => fs.rmSync(messagesDir, { recursive: true, force: true }));
    process.env.MESSAGES_DIR = messagesDir;

    const [{ Client }, { InMemoryTransport }, { createMcpServer }] =
        await Promise.all([
            import("@modelcontextprotocol/sdk/client/index.js"),
            import("@modelcontextprotocol/sdk/inMemory.js"),
            import("../build/mcp/server.js"),
        ]);

    const historyDir = path.join(messagesDir, "history");
    fs.writeFileSync(
        path.join(historyDir, "general_2026-08-01.txt"),
        "[10:00:00] user: expected entry\n",
        "utf8",
    );
    fs.writeFileSync(
        path.join(historyDir, "release_2026-08-01_2026-08-02.txt"),
        "[11:00:00] user: wrong-day entry\n",
        "utf8",
    );

    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: "history-test", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(async () => {
        await client.close();
        await server.close();
    });

    const result = await client.callTool({
        name: "read-message-history",
        arguments: { date: "2026-08-01" },
    });
    const text = result.content.find((item) => item.type === "text")?.text;

    assert.equal(typeof text, "string");
    assert.match(text, /general_2026-08-01\.txt/);
    assert.match(text, /expected entry/);
    assert.doesNotMatch(text, /release_2026-08-01_2026-08-02\.txt/);
    assert.doesNotMatch(text, /wrong-day entry/);
});
