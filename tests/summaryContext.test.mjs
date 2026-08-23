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
const { getSummaryPath, loadRecentSummaries } = await import(
    "../build/storage/summaries.js"
);

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

test("loaded daily summaries do not split surrogate pairs at the budget", () => {
    const date = new Date(Date.now() - 86400000);
    fs.writeFileSync(
        getSummaryPath("unicode-summary-channel", date, "general"),
        `${"a".repeat(79)}😀 trailing data`,
        "utf8",
    );

    const loaded = loadRecentSummaries(
        "unicode-summary-channel",
        1,
        "general",
    );

    assert.equal(loaded.endsWith("\uD83D"), false);
    assert.doesNotMatch(loaded, /trailing data/);
});
