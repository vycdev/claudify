import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudify-image-symlink-"),
);
const messagesDir = path.join(tempRoot, "messages");
const previousMessagesDir = process.env.MESSAGES_DIR;
process.env.MESSAGES_DIR = messagesDir;

const { downloadAttachment } = await import("../build/storage/images.js");

test.after(() => {
    if (previousMessagesDir === undefined) {
        delete process.env.MESSAGES_DIR;
    } else {
        process.env.MESSAGES_DIR = previousMessagesDir;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("attachment downloads do not follow symbolic-link destinations", async (t) => {
    const outsidePath = path.join(tempRoot, "outside.txt");
    const symlinkPath = path.join(messagesDir, "images", "escape.txt");
    fs.writeFileSync(outsidePath, "original", "utf8");
    fs.symlinkSync(outsidePath, symlinkPath);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode("overwritten"),
    });
    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    await assert.rejects(
        () => downloadAttachment("https://example.com/attachment", "escape.txt"),
        /must not be a symbolic link/,
    );
    assert.equal(fs.readFileSync(outsidePath, "utf8"), "original");

    const regularPath = await downloadAttachment(
        "https://example.com/attachment",
        "regular.txt",
    );
    assert.equal(fs.readFileSync(regularPath, "utf8"), "overwritten");
});

test("attachment filenames cannot traverse symbolic-link directories", async () => {
    const outsideDir = path.join(tempRoot, "outside");
    const linkedDir = path.join(messagesDir, "images", "linked");
    fs.mkdirSync(outsideDir);
    fs.symlinkSync(outsideDir, linkedDir, "dir");

    await assert.rejects(
        () => downloadAttachment(
            "https://example.com/attachment",
            path.join("linked", "escape.txt"),
        ),
        /must not include a directory path/,
    );
    assert.equal(fs.existsSync(path.join(outsideDir, "escape.txt")), false);
});