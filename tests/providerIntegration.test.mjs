import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const messages = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-provider-"));
process.env.MESSAGES_DIR = messages;
process.env.BOT_PROVIDER = "codex";
process.env.BOT_MODEL = "claude-sonnet-5";
process.env.CODEX_MODEL = "gpt-5.6-luna";
process.env.CODEX_EFFORT = "medium";
process.env.CODEX_PROFILE_EFFORT = "low";
test.after(() => fs.rmSync(messages, { recursive: true, force: true }));

test("selected Codex settings reach responses, both memory workloads, and daily summaries", async () => {
    const config = await import("../build/config.js");
    assert.equal(config.BOT_PROVIDER, "codex");
    assert.equal(config.getResponseModelDisplay(), "gpt-5.6-luna");
    const { askClaude } = await import("../build/askClaude.js");
    const { backgroundProfileUpdate, backgroundServerMemoryUpdate } =
        await import("../build/storage/profiles.js");
    const calls = [];
    const runner = async (args, input, options, images) => {
        calls.push({ args, input, options, images });
        return { stdout: '{"facts":[]}', stderr: "" };
    };
    await askClaude(
        "hello",
        "User",
        "1",
        "general",
        "2",
        "Guild",
        "3",
        [],
        "",
        undefined,
        runner,
    );
    await backgroundProfileUpdate(
        [{ tag: "User", id: "1" }],
        "context",
        runner,
    );
    await backgroundServerMemoryUpdate(
        "3",
        "Guild",
        "general",
        "context",
        runner,
    );
    const { generateDailySummary } = await import(
        "../build/storage/summaries.js"
    );
    const { getChannelHistoryPath } = await import(
        "../build/storage/historyPaths.js"
    );
    const date = new Date("2026-09-09T00:00:00Z");
    fs.writeFileSync(
        getChannelHistoryPath(config.HISTORY_V2_DIR, "2", "general", date),
        "User: first message\nUser: second message",
    );
    await generateDailySummary("2", "general", date, runner);
    assert.deepEqual(
        calls.map((call) => call.options.workload),
        ["response", "profile-update", "server-memory-update", "daily-summary"],
    );
    assert.deepEqual(
        calls.map((call) => call.options.model),
        ["gpt-5.6-luna", "gpt-5.6-luna", "gpt-5.6-luna", "gpt-5.6-luna"],
    );
    assert.equal(calls[1].options.effort, "low");
});

test("Codex attachments use native image input rather than Claude Read instructions", async () => {
    const { askClaude } = await import("../build/askClaude.js");
    let captured;
    await askClaude(
        "what is pictured?",
        "User",
        "1",
        "general",
        "2",
        "Guild",
        "3",
        ["/image.png"],
        "",
        undefined,
        async (args, input, options, images) => {
            captured = { args, input, options, images };
            return { stdout: "A picture", stderr: "" };
        },
    );
    assert.deepEqual(captured.images, ["/image.png"]);
    assert.match(captured.input, /included directly/);
    assert.doesNotMatch(captured.input, /Use the Read tool/);
});
