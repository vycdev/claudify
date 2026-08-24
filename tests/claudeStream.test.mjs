import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeStreamCollector } from "../build/claudeStream.js";
import { createClaudeRunner } from "../build/claude.js";

function event(value) {
    return `${JSON.stringify(value)}\n`;
}

test("collects bounded tool evidence and the final stream result", () => {
    const collector = new ClaudeStreamCollector();
    const source = [
        event({
            type: "assistant",
            message: {
                content: [{
                    type: "tool_use",
                    id: "tool-1",
                    name: "mcp__morpheus__run_command",
                    input: { invocation: { command: "top", mode: "validate" } },
                }],
            },
        }),
        event({
            type: "user",
            message: {
                content: [{
                    type: "tool_result",
                    tool_use_id: "tool-1",
                    content: JSON.stringify({ success: false, status: "invalid" }),
                }],
            },
        }),
        event({
            type: "assistant",
            message: {
                content: [{
                    type: "tool_use",
                    id: "tool-2",
                    name: "mcp__morpheus__describe_command",
                    input: { alias: "top" },
                }],
            },
        }),
        event({
            type: "user",
            message: {
                content: [{
                    type: "tool_result",
                    tool_use_id: "tool-2",
                    content: "description",
                }],
            },
        }),
        "not-json\n",
        event({ type: "result", subtype: "success", result: "Grounded answer" }),
    ].join("");

    for (let index = 0; index < source.length; index += 17) {
        collector.consume(source.slice(index, index + 17));
    }
    const result = collector.finish();

    assert.equal(result.result, "Grounded answer");
    assert.equal(result.trace.resultEventReceived, true);
    assert.equal(result.trace.malformedEventCount, 1);
    assert.deepEqual(result.trace.toolCalls, [
        {
            id: "tool-1",
            name: "mcp__morpheus__run_command",
            resultStatus: "failure",
        },
        {
            id: "tool-2",
            name: "mcp__morpheus__describe_command",
            resultStatus: "success",
        },
    ]);
});

test("records transport errors and missing tool results", () => {
    const collector = new ClaudeStreamCollector();
    collector.consume(event({
        type: "assistant",
        message: {
            content: [
                { type: "tool_use", id: "failed", name: "mcp__morpheus__list_commands" },
                { type: "tool_use", id: "pending", name: "mcp__morpheus__describe_command" },
            ],
        },
    }));
    collector.consume(event({
        type: "user",
        message: {
            content: [{
                type: "tool_result",
                tool_use_id: "failed",
                is_error: true,
                content: "connection failed",
            }],
        },
    }));

    assert.deepEqual(collector.finish().trace.toolCalls, [
        {
            id: "failed",
            name: "mcp__morpheus__list_commands",
            resultStatus: "failure",
        },
        {
            id: "pending",
            name: "mcp__morpheus__describe_command",
            resultStatus: "pending",
        },
    ]);
});

test("Claude runner returns the final text and evidence instead of raw JSONL", async () => {
    const output = [
        event({
            type: "assistant",
            message: {
                content: [{
                    type: "tool_use",
                    id: "tool-1",
                    name: "mcp__morpheus__describe_command",
                }],
            },
        }),
        event({
            type: "user",
            message: {
                content: [{
                    type: "tool_result",
                    tool_use_id: "tool-1",
                    content: "description",
                }],
            },
        }),
        event({ type: "result", result: "Only this reaches Discord" }),
    ].join("");
    const runner = createClaudeRunner({
        command: process.execPath,
        args: [
            "--input-type=module",
            "--eval",
            `process.stdout.write(${JSON.stringify(output)})`,
            "--",
        ],
    });

    const result = await runner(
        ["-p", "--output-format", "stream-json", "--verbose"],
        "prompt",
        { workload: "response" },
    );

    assert.equal(result.stdout, "Only this reaches Discord");
    assert.deepEqual(result.trace?.toolCalls, [{
        id: "tool-1",
        name: "mcp__morpheus__describe_command",
        resultStatus: "success",
    }]);
});
