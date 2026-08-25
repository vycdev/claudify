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
process.env.CLAUDE_RESPONSE_EFFORT_MODE = "adaptive";
process.env.CLAUDE_RESPONSE_SIMPLE_EFFORT = "low";

const { askClaude } = await import("../build/askClaude.js");
const { handleHelp } = await import("../build/discord/commands/help.js");

test.after(() => fs.rmSync(messagesDir, { recursive: true, force: true }));

test("responses route through response settings and report the response model", async () => {
    let captured;
    let invocationCount = 0;
    const answer = await askClaude(
        "try again",
        "User",
        "user-1",
        "general",
        "channel-1",
        "Guild",
        "guild-1",
        [],
        "",
        {
            triggerKind: "message",
            sourceMessageId: "message-1",
            messageContent: "try again",
            replyToMessageId: "message-0",
            replyTarget: {
                messageId: "message-0",
                author: "Claudify (bot)",
                content: "m!top pulls all-time levels",
            },
            replyChain: [
                {
                    messageId: "message-old",
                    author: "User",
                    content: "run the top command",
                },
                {
                    messageId: "message-0",
                    author: "Claudify (bot)",
                    content: "m!top pulls all-time levels",
                },
            ],
        },
        async (args, input, options) => {
            invocationCount++;
            captured = { args, input, options };
            return {
                stdout: "The answer",
                stderr: "",
                trace: {
                    format: "stream-json",
                    resultEventReceived: true,
                    malformedEventCount: 0,
                    toolCalls: [{
                        id: "tool-1",
                        name: "mcp__morpheus__run_command",
                        resultStatus: "success",
                    }],
                },
            };
        },
    );

    assert.equal(answer, "The answer");
    assert.equal(invocationCount, 1);
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
    assert.deepEqual(
        captured.args.slice(captured.args.indexOf("--output-format"), -1),
        ["--output-format", "stream-json"],
    );
    assert.equal(captured.args.at(-1), "--verbose");
    assert.match(captured.input, /Morpheus MCP invocation context/);
    assert.match(captured.input, /"userId": "user-1"/);
    assert.match(captured.input, /"channelId": "channel-1"/);
    assert.match(captured.input, /"guildId": "guild-1"/);
    assert.match(captured.input, /"sourceMessageId": "message-1"/);
    assert.match(
        captured.input,
        /Reply chain \(oldest ancestor to direct parent; highest-priority context for resolving this message\)/,
    );
    assert.match(captured.input, /m!top pulls all-time levels/);
    assert.ok(
        captured.input.indexOf("Reply chain")
            < captured.input.indexOf("=== Current message from User"),
    );
    assert.match(
        captured.input,
        /authoritative for what to respond to now/,
    );
    assert.match(
        captured.input,
        /earlier sections only as supporting context; they do not choose the topic/,
    );
    assert.match(
        captured.args[systemPromptIndex + 1],
        /Use run_command in validate mode first/,
    );
    assert.match(
        captured.args[systemPromptIndex + 1],
        /never tell the user that they must wire up or run a tool you have/,
    );
    assert.match(
        captured.args[systemPromptIndex + 1],
        /current message controls what the user is doing now/,
    );
    assert.match(
        captured.args[systemPromptIndex + 1],
        /its topic is not automatically the current topic/,
    );
    assert.match(
        captured.args[systemPromptIndex + 1],
        /Statements that you were updated, reconfigured, reprompted, or given new context/,
    );
    assert.match(
        captured.args[systemPromptIndex + 1],
        /Never invent a Discord delivery or threading problem/,
    );
    assert.match(
        captured.args[systemPromptIndex + 1],
        /Do not defend the old answer, blame the user/,
    );
    assert.match(
        captured.args[systemPromptIndex + 1],
        /Never become hostile, defensive, contemptuous, or insulting/,
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

test("adaptive routing keeps Sonnet while lowering a simple response effort", async () => {
    let capturedOptions;
    const answer = await askClaude(
        "sup",
        "User",
        "user-1",
        "general",
        "channel-1",
        "Guild",
        "guild-1",
        [],
        "",
        {
            triggerKind: "message",
            sourceMessageId: "message-2",
            messageContent: "sup",
        },
        async (_args, _input, options) => {
            capturedOptions = options;
            return {
                stdout: "not much",
                stderr: "",
                trace: {
                    format: "stream-json",
                    resultEventReceived: true,
                    malformedEventCount: 0,
                    toolCalls: [],
                },
            };
        },
    );

    assert.equal(answer, "not much");
    assert.deepEqual(capturedOptions, {
        workload: "response",
        model: "response-model",
        effort: "low",
    });
});
