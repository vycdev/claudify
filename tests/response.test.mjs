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

test("ignores reaction tags without an emoji", () => {
    assert.deepEqual(parseClaudeResponse("[REACT: ]"), {
        reactions: [],
        text: "",
        historyContent: "",
        reason: "legacy",
        targetMessageId: null,
        structured: false,
        contractFallback: false,
    });
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
