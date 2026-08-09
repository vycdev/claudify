import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const messagesDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudify-summary-context-"),
);
process.env.MESSAGES_DIR = messagesDir;
process.env.HISTORY_RECAP_MAX_CHARS = "80";

const { loadRecentHistory } = await import("../build/storage/history.js");
const { getSummaryPath } = await import("../build/storage/summaries.js");

test.after(() => fs.rmSync(messagesDir, { recursive: true, force: true }));

test("loaded daily summaries stay within the configured recap character budget", () => {
    const date = new Date(Date.now() - 86400000);
    const summary = `important opening context ${"x".repeat(200)} trailing data`;
    fs.writeFileSync(
        getSummaryPath("summary-channel", date, "general"),
        summary,
        "utf8",
    );

    const history = loadRecentHistory("summary-channel", "ordinary question", "general");

    assert.match(history, /important opening context/);
    assert.doesNotMatch(history, /trailing data/);
});
