import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-history-edits-"));
process.env.MESSAGES_DIR = path.join(root, "messages");

const { HISTORY_V2_DIR } = await import("../build/config.js");
const { getChannelHistoryFileName } = await import("../build/storage/historyPaths.js");
const { searchChannelHistory } = await import("../build/storage/historySearch.js");

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("history search reindexes earlier lines when a saved log grows", () => {
    const filePath = path.join(
        HISTORY_V2_DIR,
        getChannelHistoryFileName("edited-channel", "general", new Date("2026-01-01T00:00:00Z")),
    );
    fs.writeFileSync(filePath, "[10:00:00 UTC] user: originalword\n");
    assert.equal(searchChannelHistory("edited-channel", ["originalword"]).length, 1);

    // A corrected first line plus an appended line is not a pure append.
    fs.writeFileSync(
        filePath,
        "[10:00:00 UTC] user: correctedkeyword\n[11:00:00 UTC] user: new entry\n",
    );
    assert.equal(searchChannelHistory("edited-channel", ["correctedkeyword"]).length, 1);
    assert.equal(searchChannelHistory("edited-channel", ["originalword"]).length, 0);

    fs.appendFileSync(filePath, "[12:00:00 UTC] user: appendedkeyword\n");
    assert.equal(searchChannelHistory("edited-channel", ["appendedkeyword"]).length, 1);
    assert.equal(searchChannelHistory("edited-channel", ["correctedkeyword"]).length, 1);
});
