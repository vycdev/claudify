import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("pending writes refuse symlinks and removals reject traversal", async (t) => {
    const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-pending-symlink-"),
    );
    t.after(() => fs.rmSync(testDir, { recursive: true, force: true }));

    const messagesDir = path.join(testDir, "messages");
    process.env.MESSAGES_DIR = messagesDir;
    const { savePending, removePending } = await import("../build/storage/pending.js");

    const outsideFile = path.join(testDir, "outside.txt");
    const pendingPath = path.join(
        messagesDir,
        "pending",
        "222222222222222222.txt",
    );
    fs.writeFileSync(outsideFile, "must not be overwritten", "utf8");
    const unrelatedFile = path.join(messagesDir, "unrelated.txt");
    fs.writeFileSync(unrelatedFile, "keep this file", "utf8");
    assert.throws(
        () => removePending("../unrelated"),
        /invalid pending message ID/i,
    );
    assert.equal(fs.readFileSync(unrelatedFile, "utf8"), "keep this file");
    try {
        fs.symlinkSync(outsideFile, pendingPath);
    } catch (error) {
        if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
        t.skip("symbolic-link assertions require host permission");
        return;
    }

    assert.throws(
        () => savePending({
            id: "222222222222222222",
            author: { tag: "user#0001" },
            channel: { name: "general" },
            channelId: "111111111111111111",
            createdAt: new Date("2026-08-31T12:30:00.000Z"),
            content: "pending entry",
        }),
        /safely save pending message/u,
    );
    assert.equal(fs.readFileSync(outsideFile, "utf8"), "must not be overwritten");
});
