import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { compareHistoryFilenames } from "../build/mcp/historyFiles.js";

test("history files are ordered by date suffix before channel name", () => {
    const files = [
        "zeta_2024-01-01.txt",
        "alpha_2024-02-01.txt",
        "beta_2024-01-01.txt",
    ];

    files.sort(compareHistoryFilenames);

    assert.deepEqual(files, [
        "beta_2024-01-01.txt",
        "zeta_2024-01-01.txt",
        "alpha_2024-02-01.txt",
    ]);
    assert.equal(files.slice(-1)[0], "alpha_2024-02-01.txt");
});

test("dated history files sort after undated or invalid text files", () => {
    const files = [
        "alpha_2024-02-01.txt",
        "notes.txt",
        "legacy_2024-99-99.txt",
    ];

    assert.deepEqual(files.sort(compareHistoryFilenames), [
        "legacy_2024-99-99.txt",
        "notes.txt",
        "alpha_2024-02-01.txt",
    ]);
});

test("read-message-history limits results by date across channels", async (t) => {
    const messagesDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-history-order-"),
    );
    const historyDir = path.join(messagesDir, "history");
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(
        path.join(historyDir, "alpha_2024-02-01.txt"),
        "newer history\n",
    );
    fs.writeFileSync(
        path.join(historyDir, "zeta_2024-01-01.txt"),
        "older history\n",
    );

    process.env.MESSAGES_DIR = messagesDir;
    const { createMcpServer } = await import("../build/mcp/server.js");
    const mcpServer = createMcpServer();
    const mcpClient = new Client({ name: "history-order-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();

    t.after(async () => {
        await mcpClient.close();
        await mcpServer.close();
        delete process.env.MESSAGES_DIR;
        fs.rmSync(messagesDir, { recursive: true, force: true });
    });

    await mcpServer.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    const result = await mcpClient.callTool({
        name: "read-message-history",
        arguments: { limit: 1 },
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /alpha_2024-02-01\.txt/);
    assert.doesNotMatch(result.content[0].text, /zeta_2024-01-01\.txt/);
});
