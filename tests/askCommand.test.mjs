import assert from "node:assert/strict";
import test from "node:test";

import { parseAskCommand } from "../build/discord/commands/ask.js";

test("parses ask commands at a command boundary", () => {
    assert.equal(parseAskCommand("!ask"), "");
    assert.equal(parseAskCommand("!ask What is new?"), "What is new?");
    assert.equal(parseAskCommand("!ask\tWhat is new?"), "What is new?");
    assert.equal(parseAskCommand("  !ask   What is new?  "), "What is new?");
});

test("does not match messages that only start with the ask prefix", () => {
    assert.equal(parseAskCommand("!asking a question"), null);
    assert.equal(parseAskCommand("hello !ask a question"), null);
});
