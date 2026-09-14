import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const messagesDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudify-history-safety-"),
);
process.env.MESSAGES_DIR = messagesDir;

const { appendToLog, getDailyLogPath } = await import(
    "../build/storage/history.js"
);

const timestamp = new Date("2026-09-12T12:00:00.000Z");

test.after(() => fs.rmSync(messagesDir, { recursive: true, force: true }));

test("history appends do not follow symbolic-link destinations", (t) => {
    const outsidePath = path.join(messagesDir, "outside.txt");
    const logPath = getDailyLogPath("safety-channel", timestamp, "general");
    fs.writeFileSync(outsidePath, "outside content\n", "utf8");
    try {
        fs.symlinkSync(outsidePath, logPath);
    } catch (error) {
        if (process.platform === "win32" && error.code === "EPERM") {
            t.skip("Creating file symbolic links requires Windows privileges");
            return;
        }
        throw error;
    }

    assert.throws(
        () => appendToLog(
            "user",
            "must not escape the history directory",
            "safety-channel",
            "general",
            timestamp,
        ),
        /Could not safely append history/,
    );
    assert.equal(fs.readFileSync(outsidePath, "utf8"), "outside content\n");
});

test("history appends preserve existing records and source metadata", () => {
    const logPath = getDailyLogPath("normal-channel", timestamp, "general");
    fs.writeFileSync(logPath, "existing record\n", "utf8");
    appendToLog("user", " new\n message ", "normal-channel", "general", timestamp, {
        messageId: "123",
        authorId: "456",
        authorBot: false,
    });
    assert.equal(
        fs.readFileSync(logPath, "utf8"),
        "existing record\n[12:00:00 UTC] user [message_id=123; author_id=456; author_bot=false; created_at=2026-09-12T12:00:00.000Z]: new message\n",
    );
});

test("history appends refuse hard-linked destinations", () => {
    const outsidePath = path.join(messagesDir, "hard-link-target.txt");
    const logPath = getDailyLogPath("hard-link-channel", timestamp, "general");
    fs.writeFileSync(outsidePath, "outside content\n", "utf8");
    fs.linkSync(outsidePath, logPath);
    assert.throws(
        () => appendToLog("user", "must not be written", "hard-link-channel", "general", timestamp),
        /Could not safely append history/,
    );
    assert.equal(fs.readFileSync(outsidePath, "utf8"), "outside content\n");
});

test("history appends refuse a symbolic-link storage directory", () => {
    const logPath = getDailyLogPath("directory-channel", timestamp, "general");
    const directory = path.dirname(logPath);
    const savedDirectory = `${directory}-saved`;
    const outsideDirectory = path.join(messagesDir, "outside-history");
    fs.mkdirSync(outsideDirectory);
    fs.renameSync(directory, savedDirectory);
    try {
        fs.symlinkSync(outsideDirectory, directory, process.platform === "win32" ? "junction" : "dir");
        assert.throws(
            () => appendToLog("user", "must not escape", "directory-channel", "general", timestamp),
            /Could not safely append history/,
        );
        assert.deepEqual(fs.readdirSync(outsideDirectory), []);
    } finally {
        if (fs.existsSync(directory)) fs.unlinkSync(directory);
        fs.renameSync(savedDirectory, directory);
    }
});
