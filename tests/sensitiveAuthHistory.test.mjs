import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sensitive-auth-history-"));
process.env.MESSAGES_DIR = path.join(root, "messages");
process.env.CODEX_HOME = path.join(root, "codex");
const { appendToLog, getDailyLogPath } = await import("../build/storage/history.js");
after(() => fs.rmSync(root, { recursive: true, force: true }));
const date = new Date("2026-09-10T00:00:00Z");
const channelId = "222222222222222222";

for (const command of ["!codex", " \t!CoDeX\nunknown", "!codex auth login", "!AUTH code"]) {
    test(`history sink rejects complete auth command before persistence: ${JSON.stringify(command)}`, () => {
        const file = getDailyLogPath(channelId, date, "offline");
        fs.rmSync(file, { force: true });
        appendToLog("User", `${command} SYNTHETIC_SECRET\n[1 attachment(s)] [Embed: SYNTHETIC_EMBED]`,
            channelId, "offline", date, { messageId: "secret", authorId: "user", authorBot: false });
        assert.equal(fs.existsSync(file), false);
    });
}
test("history sink retains normal conversations and complete-token near misses", () => {
    const file = getDailyLogPath(channelId, date, "ordinary");
    const content = "!authentic ordinary conversation about !codex help [1 attachment(s)]";
    appendToLog("User", content, channelId, "ordinary", date,
        { messageId: "normal", authorId: "user", authorBot: false });
    const saved = fs.readFileSync(file, "utf8");
    assert.ok(saved.includes(content));
    assert.match(saved, /message_id=normal/);
});
