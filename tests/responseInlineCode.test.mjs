import assert from "node:assert/strict";
import test from "node:test";

import { parseClaudeResponse } from "../build/discord/response.js";

test("keeps reaction tags inside inline code spans as literal text", () => {
    assert.deepEqual(
        parseClaudeResponse("Use `[REACT:literal]` in docs. [REACT:thumbsup] Done."),
        {
            reactions: ["thumbsup"],
            text: "Use `[REACT:literal]` in docs. Done.",
            historyContent: "Use `[REACT:literal]` in docs. Done.",
            reason: "legacy",
            targetMessageId: null,
            structured: false,
            contractFallback: false,
        },
    );
});

test("keeps reaction tags inside multiline inline code as literal text", () => {
    const response = "Use `[REACT:literal]\nmore` in docs. [REACT:thumbsup] Done.";
    const parsed = parseClaudeResponse(response);

    assert.deepEqual(parsed.reactions, ["thumbsup"]);
    assert.equal(parsed.text, "Use `[REACT:literal]\nmore` in docs. Done.");
});

test("unmatched backtick runs do not hide legacy reaction directives", () => {
    for (const response of [
        "``[REACT:thumbsup]```",
        "`[REACT:thumbsup]``",
    ]) {
        const parsed = parseClaudeResponse(response);
        assert.deepEqual(parsed.reactions, ["thumbsup"]);
        assert.equal(parsed.text.includes("[REACT:thumbsup]"), false);
    }
});

test("matching multi-backtick delimiters keep legacy reaction syntax literal", () => {
    const response = "``[REACT:literal]`` [REACT:thumbsup]";
    const parsed = parseClaudeResponse(response);
    assert.deepEqual(parsed.reactions, ["thumbsup"]);
    assert.equal(parsed.text, "``[REACT:literal]``");
});
