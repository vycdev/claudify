import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const messagesDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudify-morpheus-grounding-"),
);
process.env.MESSAGES_DIR = messagesDir;

const { askClaude } = await import("../build/askClaude.js");
const {
    assessMorpheusGrounding,
    canRetryMissingMorpheusCall,
    requiresMorpheusGrounding,
} = await import("../build/morpheusGrounding.js");

test.after(() => fs.rmSync(messagesDir, { recursive: true, force: true }));

function trace(toolCalls) {
    return {
        format: "stream-json",
        resultEventReceived: true,
        malformedEventCount: 0,
        toolCalls,
    };
}

function invocation(messageContent = "ask Morpheus for the top users") {
    return {
        triggerKind: "message",
        sourceMessageId: "message-1",
        messageContent,
    };
}

test("detects explicit and contextual Morpheus requests without broad false positives", () => {
    assert.equal(requiresMorpheusGrounding("ask Morpheus for top", "", ""), true);
    assert.equal(requiresMorpheusGrounding("run m!top", "", ""), true);
    assert.equal(
        requiresMorpheusGrounding(
            "try again",
            "m!top pulls the Morpheus leaderboard",
            "",
        ),
        true,
    );
    assert.equal(
        requiresMorpheusGrounding(
            "try again",
            "",
            "Morpheus previously handled this command",
        ),
        true,
    );
    assert.equal(
        requiresMorpheusGrounding(
            "show me the source code",
            "",
            "Morpheus came up earlier",
        ),
        false,
    );
});

test("requires completed Morpheus tool results", () => {
    assert.equal(assessMorpheusGrounding(undefined).reason, "missing-call");
    assert.equal(
        assessMorpheusGrounding(trace([{
            id: "discord-tool",
            name: "mcp__discord__read-messages",
            resultStatus: "success",
        }])).reason,
        "missing-call",
    );
    assert.equal(
        assessMorpheusGrounding(trace([{
            id: "morpheus-tool",
            name: "mcp__morpheus__run_command",
            resultStatus: "pending",
        }])).reason,
        "missing-result",
    );
    assert.equal(
        assessMorpheusGrounding(trace([{
            id: "morpheus-tool",
            name: "mcp__morpheus__run_command",
            resultStatus: "failure",
        }])).grounded,
        true,
    );
});

test("retries only after attempts with no potentially mutating tools", () => {
    assert.equal(canRetryMissingMorpheusCall(undefined), false);
    assert.equal(canRetryMissingMorpheusCall(trace([])), true);
    assert.equal(
        canRetryMissingMorpheusCall(trace([{
            id: "search",
            name: "WebSearch",
            resultStatus: "success",
        }])),
        true,
    );
    assert.equal(
        canRetryMissingMorpheusCall(trace([{
            id: "send",
            name: "mcp__discord__send-message",
            resultStatus: "success",
        }])),
        false,
    );
});

test("retries an explicit Morpheus request once when the model skips the tool", async () => {
    const prompts = [];
    const answer = await askClaude(
        "ask Morpheus for the top users",
        "User",
        "user-1",
        "general",
        "channel-1",
        "Guild",
        "guild-1",
        [],
        "",
        invocation(),
        async (_args, prompt) => {
            prompts.push(prompt);
            if (prompts.length === 1) {
                return { stdout: "probably Alice", stderr: "", trace: trace([]) };
            }
            return {
                stdout: "Morpheus says Bob is first.",
                stderr: "",
                trace: trace([{
                    id: "morpheus-tool",
                    name: "mcp__morpheus__run_command",
                    resultStatus: "success",
                }]),
            };
        },
    );

    assert.equal(prompts.length, 2);
    assert.doesNotMatch(prompts[0], /Harness-required retry/);
    assert.match(prompts[1], /Harness-required retry/);
    assert.equal(answer, "Morpheus says Bob is first.");
});

test("fails closed after two attempts without Morpheus evidence", async () => {
    let attempts = 0;
    const answer = await askClaude(
        "ask Morpheus to press the button",
        "User",
        "user-1",
        "general",
        "channel-1",
        "Guild",
        "guild-1",
        [],
        "",
        invocation("ask Morpheus to press the button"),
        async () => {
            attempts++;
            return { stdout: "done", stderr: "", trace: trace([]) };
        },
    );

    assert.equal(attempts, 2);
    assert.equal(
        answer,
        "I couldn't verify that through Morpheus, so I won't pretend I ran it.",
    );
});

test("does not retry after a Morpheus call with no returned result", async () => {
    let attempts = 0;
    const answer = await askClaude(
        "ask Morpheus to press the button",
        "User",
        "user-1",
        "general",
        "channel-1",
        "Guild",
        "guild-1",
        [],
        "",
        invocation("ask Morpheus to press the button"),
        async () => {
            attempts++;
            return {
                stdout: "done",
                stderr: "",
                trace: trace([{
                    id: "morpheus-tool",
                    name: "mcp__morpheus__run_command",
                    resultStatus: "pending",
                }]),
            };
        },
    );

    assert.equal(attempts, 1);
    assert.equal(
        answer,
        "Morpheus did not return a verifiable result, so I won't claim the action worked.",
    );
});

test("does not retry after another potentially mutating tool call", async () => {
    let attempts = 0;
    const answer = await askClaude(
        "ask Morpheus to press the button",
        "User",
        "user-1",
        "general",
        "channel-1",
        "Guild",
        "guild-1",
        [],
        "",
        invocation("ask Morpheus to press the button"),
        async () => {
            attempts++;
            return {
                stdout: "done",
                stderr: "",
                trace: trace([{
                    id: "send",
                    name: "mcp__discord__send-message",
                    resultStatus: "success",
                }]),
            };
        },
    );

    assert.equal(attempts, 1);
    assert.equal(
        answer,
        "I couldn't verify that through Morpheus, so I won't pretend I ran it.",
    );
});
