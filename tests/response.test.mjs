import assert from "node:assert/strict";
import test from "node:test";

import { parseClaudeResponse } from "../build/discord/response.js";

test("records reaction-only Claude responses as history content", () => {
    assert.deepEqual(parseClaudeResponse("[REACT: pepeclap]"), {
        reactions: ["pepeclap"],
        text: "",
        historyContent: "[reacted: pepeclap]",
        reason: "legacy",
        targetMessageId: null,
        structured: false,
        contractFallback: false,
    });
});

test("separates reaction tags from a text response", () => {
    assert.deepEqual(
        parseClaudeResponse("[REACT:👍] Thanks! [REACT: party_parrot]"),
        {
            reactions: ["👍", "party_parrot"],
            text: "Thanks!",
            historyContent: "Thanks!",
            reason: "legacy",
            targetMessageId: null,
            structured: false,
            contractFallback: false,
        },
    );
});

test("preserves paragraph breaks around a standalone reaction tag", () => {
    const response = parseClaudeResponse(
        "First paragraph.\n[REACT: 👍]\n\nSecond paragraph.",
    );
    assert.deepEqual(response.reactions, ["👍"]);
    assert.equal(response.text, "First paragraph.\n\nSecond paragraph.");
    assert.equal(response.historyContent, response.text);
});

test("preserves a line break after an inline reaction tag", () => {
    const response = parseClaudeResponse("First [REACT: 👍]\nSecond");
    assert.deepEqual(response.reactions, ["👍"]);
    assert.equal(response.text, "First \nSecond");
});

for (const [ending, newline] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
    test(`preserves indentation before inline reaction tags with ${ending} endings`, () => {
        const response = parseClaudeResponse(
            `Example:${newline}${newline}    [REACT: 👍]print('hello')`,
        );
        assert.deepEqual(response.reactions, ["👍"]);
        assert.equal(response.text, `Example:${newline}${newline}    print('hello')`);
        assert.equal(response.historyContent, response.text);
    });
}

test("removes indented standalone reaction lines with CRLF endings", () => {
    const response = parseClaudeResponse(
        "First paragraph.\r\n  [REACT: 👍]  \r\n\r\nSecond paragraph.",
    );
    assert.deepEqual(response.reactions, ["👍"]);
    assert.equal(response.text, "First paragraph.\r\n\r\nSecond paragraph.");
});

test("ignores reaction tags without an emoji", () => {
    const expected = {
        reactions: [],
        text: "",
        historyContent: "",
        reason: "legacy",
        targetMessageId: null,
        structured: false,
        contractFallback: false,
    };

    assert.deepEqual(parseClaudeResponse("[REACT: ]"), expected);
    assert.deepEqual(parseClaudeResponse("[REACT:]"), expected);
});

test("parses the structured response envelope", () => {
    assert.deepEqual(
        parseClaudeResponse(JSON.stringify({
            text: "Got it, the wrapper changed.",
            reaction: "thumbsup",
            reason: "acknowledgement",
            targetMessageId: "message-1",
        })),
        {
            reactions: ["thumbsup"],
            text: "Got it, the wrapper changed.",
            historyContent: "Got it, the wrapper changed.",
            reason: "acknowledgement",
            targetMessageId: "message-1",
            structured: true,
            contractFallback: false,
        },
    );
});
