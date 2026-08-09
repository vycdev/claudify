import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("history reads filter date suffixes and non-regular entries", async (t) => {
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
    const historyV2Dir = path.join(historyDir, "v2");
    fs.mkdirSync(historyV2Dir, { recursive: true });
    fs.writeFileSync(
        path.join(
            historyV2Dir,
            "v2_111111111111111111__general_2026-08-01.txt",
        ),
        "[12:00:00] user: namespaced entry\n",
        "utf8",
    );
    const outsideFile = path.join(
        os.tmpdir(),
        `claudify-history-secret-${process.pid}-${Date.now()}.txt`,
    );
    t.after(() => fs.rmSync(outsideFile, { force: true }));
    fs.writeFileSync(outsideFile, "symlinked secret\n", "utf8");
    fs.symlinkSync(
        outsideFile,
        path.join(historyDir, "linked_2026-08-01.txt"),
    );
    fs.mkdirSync(path.join(historyDir, "directory_2026-08-01.txt"));
    fs.symlinkSync(
        outsideFile,
        path.join(
            historyV2Dir,
            "v2_222222222222222222__linked_2026-08-01.txt",
        ),
    );
    fs.mkdirSync(
        path.join(
            historyV2Dir,
            "v2_333333333333333333__directory_2026-08-01.txt",
        ),
    );
    const pendingDir = path.join(messagesDir, "pending");
    fs.writeFileSync(
        path.join(pendingDir, "regular.txt"),
        "ordinary pending entry\n",
        "utf8",
    );
    fs.symlinkSync(outsideFile, path.join(pendingDir, "linked.txt"));
    fs.mkdirSync(path.join(pendingDir, "directory.txt"));

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
    assert.match(
        text,
        /v2\/v2_111111111111111111__general_2026-08-01\.txt/,
    );
    assert.match(text, /namespaced entry/);
    assert.doesNotMatch(text, /release_2026-08-01_2026-08-02\.txt/);
    assert.doesNotMatch(text, /wrong-day entry/);
    assert.doesNotMatch(text, /linked_2026-08-01\.txt/);
    assert.doesNotMatch(text, /directory_2026-08-01\.txt/);
    assert.doesNotMatch(text, /symlinked secret/);

    const pendingResult = await client.callTool({
        name: "read-message-history",
        arguments: { type: "pending" },
    });
    const pendingText = pendingResult.content.find(
        (item) => item.type === "text",
    )?.text;

    assert.equal(typeof pendingText, "string");
    assert.match(pendingText, /regular\.txt/);
    assert.match(pendingText, /ordinary pending entry/);
    assert.doesNotMatch(pendingText, /linked\.txt/);
    assert.doesNotMatch(pendingText, /directory\.txt/);
    assert.doesNotMatch(pendingText, /symlinked secret/);
});
