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
        },
    );
});
