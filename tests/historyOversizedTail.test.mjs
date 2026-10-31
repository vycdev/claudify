import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const messagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-history-tail-"));
process.env.MESSAGES_DIR = messagesDir;
process.env.HISTORY_RECAP_MAX_CHARS = "400";

const { appendToLog, loadRecentHistory } = await import("../build/storage/history.js");

test.after(() => fs.rmSync(messagesDir, { recursive: true, force: true }));

test("recent history retains a bounded excerpt of an oversized newest message", () => {
    const channelId = "oversized-tail-channel";
    appendToLog("Alice", "older context", channelId, "general");
    appendToLog("Bob", `important opening ${"x".repeat(400)} trailing marker`, channelId, "general");

    const history = loadRecentHistory(channelId, "", "general");
    assert.match(history, /important opening/);
    assert.doesNotMatch(history, /trailing marker/);
    assert.doesNotMatch(history, /no saved messages yet/);
    assert.ok(history.length < 250, `unexpectedly large excerpt: ${history.length}`);
});

test("oversized saved-history excerpts do not split Unicode surrogate pairs", () => {
    const channelId = "unicode-tail-channel";
    const timestamp = new Date();
    const header = `[${timestamp.toISOString().slice(11, 19)} UTC] Bob: opening `;
    // A 100-character tail budget reserves one character for the ellipsis;
    // place the high surrogate at the last position of the raw excerpt.
    appendToLog("Bob", `opening ${"x".repeat(98 - header.length)}😀${"y".repeat(200)}`, channelId, "general", timestamp);

    const history = loadRecentHistory(channelId, "", "general");
    assert.match(history, /opening/);
    assert.match(history, /…/);
    assert.doesNotMatch(history, /😀/);
    assert.doesNotMatch(history, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
});
