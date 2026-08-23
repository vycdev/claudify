import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const messagesDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudify-response-workload-"),
);
process.env.MESSAGES_DIR = messagesDir;
process.env.BOT_MODEL = "global-model";
process.env.BOT_EFFORT = "low";
process.env.CLAUDE_RESPONSE_MODEL = "response-model";
process.env.CLAUDE_RESPONSE_EFFORT = "high";

const { askClaude } = await import("../build/askClaude.js");
const { handleHelp } = await import("../build/discord/commands/help.js");

test.after(() => fs.rmSync(messagesDir, { recursive: true, force: true }));

test("responses route through response settings and report the response model", async () => {
    let captured;
    const answer = await askClaude(
        "What changed?",
        "User",
        "user-1",
        "general",
        "channel-1",
        "Guild",
        "guild-1",
        [],
        "",
        async (args, input, options) => {
            captured = { args, input, options };
            return { stdout: "The answer", stderr: "" };
        },
    );

    assert.equal(answer, "The answer");
    assert.deepEqual(captured.options, {
        workload: "response",
        model: "response-model",
        effort: "high",
    });
    const systemPromptIndex = captured.args.indexOf("--system-prompt");
    assert.notEqual(systemPromptIndex, -1);
    assert.match(captured.args[systemPromptIndex + 1], /response-model/);
    assert.doesNotMatch(captured.args[systemPromptIndex + 1], /global-model/);
    const allowedToolsIndex = captured.args.indexOf("--allowedTools");
    assert.notEqual(allowedToolsIndex, -1);
    assert.ok(
        captured.args[allowedToolsIndex + 1]
            .split(",")
            .includes("mcp__morpheus__*"),
    );

    let helpReply = "";
    await handleHelp({
        author: { id: "user-1" },
        reply: async (content) => {
            helpReply = content;
        },
    });
    assert.match(helpReply, /powered by `response-model`/);
    assert.doesNotMatch(helpReply, /global-model/);
});
