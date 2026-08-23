import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const messagesDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudify-memory-batcher-"),
);
process.env.MESSAGES_DIR = messagesDir;

const { MemoryUpdateBatcher } = await import(
    "../build/storage/memoryBatcher.js"
);

test.after(() => fs.rmSync(messagesDir, { recursive: true, force: true }));

test("memory updates debounce and replace overlapping channel snapshots", async () => {
    const profileCalls = [];
    const serverCalls = [];
    const batcher = new MemoryUpdateBatcher(
        60_000,
        600_000,
        20_000,
        async (users, context) => {
            profileCalls.push({ users, context });
        },
        async (guildId, guildName, channelName, context) => {
            serverCalls.push({ guildId, guildName, channelName, context });
        },
    );

    batcher.enqueue({
        scopeId: "guild:guild-1",
        guildId: "guild-1",
        guildName: "Guild",
        channelName: "general",
        users: [{ id: "user-1", tag: "First name" }],
        conversationContext: "old overlapping snapshot",
    });
    batcher.enqueue({
        scopeId: "guild:guild-1",
        guildId: "guild-1",
        guildName: "Guild",
        channelName: "general",
        users: [
            { id: "user-1", tag: "Current name" },
            { id: "user-2", tag: "Second user" },
        ],
        conversationContext: "newest channel snapshot",
    });

    assert.equal(profileCalls.length, 0);
    assert.equal(serverCalls.length, 0);
    await batcher.flush("guild:guild-1");

    assert.equal(profileCalls.length, 1);
    assert.deepEqual(profileCalls[0].users, [
        { id: "user-1", tag: "Current name" },
        { id: "user-2", tag: "Second user" },
    ]);
    assert.match(profileCalls[0].context, /newest channel snapshot/);
    assert.doesNotMatch(profileCalls[0].context, /old overlapping snapshot/);
    assert.deepEqual(serverCalls, [{
        guildId: "guild-1",
        guildName: "Guild",
        channelName: "general",
        context: profileCalls[0].context,
    }]);
});

test("memory batches bound context and skip server memory for DMs", async () => {
    const profileCalls = [];
    const serverCalls = [];
    const batcher = new MemoryUpdateBatcher(
        60_000,
        600_000,
        24,
        async (users, context) => {
            profileCalls.push({ users, context });
        },
        async (...args) => {
            serverCalls.push(args);
        },
    );

    batcher.enqueue({
        scopeId: "channel:dm-1",
        channelName: "dm",
        users: [{ id: "user-1", tag: "User" }],
        conversationContext: `discard this prefix 😀 keep this suffix`,
    });
    await batcher.flush("channel:dm-1");

    assert.equal(profileCalls.length, 1);
    assert.ok(profileCalls[0].context.length <= 24);
    assert.doesNotMatch(profileCalls[0].context, /\uFFFD/);
    assert.match(profileCalls[0].context, /keep this suffix/);
    assert.equal(serverCalls.length, 0);
});
