import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-history-budget-"));
process.env.MESSAGES_DIR = path.join(root, "messages");

const { HISTORY_V2_DIR } = await import("../build/config.js");
const { getChannelHistoryFileName } = await import("../build/storage/historyPaths.js");
const { searchChannelHistory } = await import("../build/storage/historySearch.js");

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("history search skips oversized matches and returns later matches that fit", () => {
    const channelId = "budget-channel";
    const filePath = path.join(
        HISTORY_V2_DIR,
        getChannelHistoryFileName(channelId, "general", new Date("2026-01-01T00:00:00Z")),
    );
    fs.writeFileSync(filePath, [
        "user: rarekeyword",
        "short context",
        "short context",
        "short context",
        "short context",
        "x".repeat(500),
        "user: rarekeyword",
    ].join("\n") + "\n");

    // Identical hit lines in the same file have equal rank; the later hit is
    // considered first but its surrounding context cannot fit the budget.
    const matches = searchChannelHistory(channelId, ["rarekeyword"], [], 2, 120);
    assert.equal(matches.length, 1);
    assert.match(matches[0].content, /short context/);
    assert.doesNotMatch(matches[0].content, /x{100}/);
});
