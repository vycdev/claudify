import assert from "node:assert/strict";
import test from "node:test";

import { parseClaudeResponse } from "../build/discord/response.js";

test("records reaction-only Claude responses as history content", () => {
    assert.deepEqual(parseClaudeResponse("[REACT: pepeclap]"), {
        reactions: ["pepeclap"],
        text: "",
        historyContent: "[reacted: pepeclap]",
    });
});

test("separates reaction tags from a text response", () => {
    assert.deepEqual(
        parseClaudeResponse("[REACT:👍] Thanks! [REACT: party_parrot]"),
        {
            reactions: ["👍", "party_parrot"],
            text: "Thanks!",
            historyContent: "Thanks!",
        },
    );
});

test("ignores reaction tags without an emoji", () => {
    assert.deepEqual(parseClaudeResponse("[REACT: ]"), {
        reactions: [],
        text: "",
        historyContent: "",
    });
});
