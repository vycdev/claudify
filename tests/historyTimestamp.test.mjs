import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.TZ = "America/Los_Angeles";
const messagesDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudify-history-timestamp-"),
);
process.env.MESSAGES_DIR = messagesDir;

const { appendToLog, getDailyLogPath } = await import(
    "../build/storage/history.js"
);

test.after(() => fs.rmSync(messagesDir, { recursive: true, force: true }));

test("history timestamps use UTC consistently with daily filenames", () => {
    const timestamp = new Date("2026-01-02T00:30:00.000Z");

    appendToLog("user", "boundary message", "123", "general", timestamp);

    const filePath = getDailyLogPath("123", timestamp, "general");
    assert.match(path.basename(filePath), /_2026-01-02\.txt$/);
    assert.equal(
        fs.readFileSync(filePath, "utf8"),
        "[00:30:00 UTC] user: boundary message\n",
    );
});
