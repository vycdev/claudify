import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudeResponse } from "../build/discord/response.js";

test("does not interpret reaction directives inside fenced code", () => {
  const response = "Here is the literal format:\n```text\n[REACT:👍]\n```";
  assert.deepEqual(parseClaudeResponse(response), {
    reactions: [],
    text: response,
    historyContent: response,
  });
});
