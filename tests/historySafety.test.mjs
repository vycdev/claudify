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

test("history appends do not follow symbolic-link destinations", () => {
    const outsidePath = path.join(messagesDir, "outside.txt");
    const logPath = getDailyLogPath("safety-channel", timestamp, "general");
    fs.writeFileSync(outsidePath, "outside content\n", "utf8");
    fs.symlinkSync(outsidePath, logPath);

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
