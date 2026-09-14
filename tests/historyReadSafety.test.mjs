import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudify-history-read-safety-"),
);
const messagesDir = path.join(fixtureRoot, "messages");
process.env.MESSAGES_DIR = messagesDir;

const { getDailyLogPath, loadRecentHistory } = await import(
    "../build/storage/history.js"
);

test.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

test("saved context does not follow symbolic-link history files", () => {
    const externalPath = path.join(fixtureRoot, "outside-history.txt");
    fs.writeFileSync(
        externalPath,
        "[10:00:00 UTC] attacker: outside history secret\n",
        "utf8",
    );

    const logPath = getDailyLogPath("safety-channel", new Date(), "general");
    fs.symlinkSync(externalPath, logPath);

    const history = loadRecentHistory(
        "safety-channel",
        "ordinary question",
        "general",
    );

    assert.doesNotMatch(history, /outside history secret/);
});