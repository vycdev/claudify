import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-history-selection-"));
process.env.MESSAGES_DIR = root;
const [{ Client }, { InMemoryTransport }, { createMcpServer }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/inMemory.js"),
    import("../build/mcp/server.js"),
]);
after(() => fs.rmSync(root, { recursive: true, force: true }));

function writeFile(relativePath, text) {
    const filePath = path.join(root, relativePath);
    fs.writeFileSync(filePath, text, "utf8");
    return filePath;
}

async function callHistory(t, args, afterEnumeration) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: "history-selection-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(async () => {
        await client.close();
        await server.close();
    });

    const original = {
        openSync: fs.openSync,
        readFileSync: fs.readFileSync,
        readdirSync: fs.readdirSync,
    };
    const descriptors = new Map();
    const reads = [];
    fs.openSync = function (...parameters) {
        const descriptor = original.openSync.apply(this, parameters);
        descriptors.set(descriptor, path.resolve(parameters[0].toString()));
        return descriptor;
    };
    fs.readFileSync = function (target, ...parameters) {
        const file = typeof target === "number"
            ? descriptors.get(target)
            : path.resolve(target.toString());
        if (file?.endsWith(".txt")) reads.push(file);
        return original.readFileSync.call(this, target, ...parameters);
    };
    fs.readdirSync = function (...parameters) {
        const entries = original.readdirSync.apply(this, parameters);
        afterEnumeration?.(parameters[0]);
        return entries;
    };
    try {
        const result = await client.callTool({ name: "read-message-history", arguments: args });
        assert.notEqual(result.isError, true);
        return { text: result.content[0].text, reads };
    } finally {
        Object.assign(fs, original);
    }
}

test("history filters channel and date before reading only the newest requested body", async (t) => {
    writeFile("history/general_2026-09-05.txt", "wrong date");
    writeFile("history/unrelated_2026-09-06.txt", "wrong channel");
    writeFile("history/general_2026-09-06.txt", "older legacy entry");
    const newest = writeFile(
        "history/v2/v2_111111111111111111__general_2026-09-06.txt",
        "newest selected entry",
    );
    const { text, reads } = await callHistory(t, {
        channel: "general", date: "2026-09-06", limit: 1,
    });
    assert.deepEqual(reads, [newest]);
    assert.match(text, /newest selected entry/);
    assert.doesNotMatch(text, /wrong|older legacy/);
});

test("history searches newest first and stops after enough matching files", async (t) => {
    writeFile("history/search_2026-09-04.txt", "needle in older match");
    const match = writeFile("history/search_2026-09-05.txt", "needle in newest match");
    const nonmatch = writeFile("history/search_2026-09-06.txt", "no relevant text");
    const { text, reads } = await callHistory(t, { channel: "search", search: "needle", limit: 1 });
    assert.deepEqual(reads, [nonmatch, match]);
    assert.match(text, /needle in newest match/);
    assert.doesNotMatch(text, /older match/);
});

test("pending metadata and output share one verified body read", async (t) => {
    const pending = writeFile("pending/222222222222222222.txt", [
        "Author: user#0001", "Channel: #snapshot", "Channel ID: 111111111111111111",
        "Timestamp: 2026-09-06T12:00:00.000Z", "---", "    indented body",
    ].join("\n"));
    const { text, reads } = await callHistory(t, {
        type: "pending", channel: "111111111111111111", date: "2026-09-06", limit: 1,
    });
    assert.deepEqual(reads, [pending]);
    assert.match(text, /\n    indented body/);
});

test("an unsafe newest candidate does not consume the requested file limit", async (t) => {
    const older = writeFile("history/fallback_2026-09-05.txt", "safe older entry");
    const newest = writeFile("history/fallback_2026-09-06.txt", "replaced entry");
    let swapped = false;
    const { text, reads } = await callHistory(t, { channel: "fallback", limit: 1 }, (directory) => {
        if (!swapped && path.resolve(directory) === path.join(root, "history")) {
            swapped = true;
            fs.renameSync(newest, `${newest}.original`);
            fs.mkdirSync(newest);
        }
    });
    assert.equal(swapped, true);
    assert.deepEqual(reads, [older]);
    assert.match(text, /safe older entry/);
    assert.doesNotMatch(text, /replaced entry/);
});

test("a full response budget prevents reading older file bodies", async (t) => {
    writeFile("history/budget_2026-09-05.txt", "older excluded entry");
    const newest = writeFile("history/budget_2026-09-06.txt", "😀".repeat(70000) + " newest-marker");
    const { text, reads } = await callHistory(t, { channel: "budget", limit: 100 });
    assert.deepEqual(reads, [newest]);
    assert.ok(text.length <= 120000);
    assert.ok(text.isWellFormed());
    assert.match(text, /newest-marker/);
    assert.match(text, /truncated/);
    assert.doesNotMatch(text, /older excluded/);
});
