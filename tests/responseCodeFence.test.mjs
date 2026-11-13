import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudeResponse } from "../build/discord/response.js";

test("does not interpret reaction directives inside fenced code", () => {
  const response = "Here is the literal format:\n```text\n[REACT:👍]\n```";
  assert.deepEqual(parseClaudeResponse(response), {
    reactions: [],
    text: response,
    historyContent: response,
    reason: "legacy",
    targetMessageId: null,
    structured: false,
    contractFallback: false,
  });
});

test("keeps reaction directives literal in tilde, long, and unclosed fences", () => {
  const examples = [
    "Example:\n~~~text\n[REACT:🚫]\n~~~",
    "Example:\n````text\n[REACT:🚫]\n```\n[REACT:🚫]\n````",
    "Example:\n~~~text\n[REACT:🚫]",
  ];

  for (const example of examples) {
    const outsideFence = example.endsWith("[REACT:🚫]") ? "" : "\n[REACT:👍] Good";
    const response = example + outsideFence;
    const expectedText = example + (outsideFence ? "\nGood" : "");
    assert.deepEqual(parseClaudeResponse(response), {
      reactions: outsideFence ? ["👍"] : [],
      text: expectedText,
      historyContent: expectedText,
      reason: "legacy",
      targetMessageId: null,
      structured: false,
      contractFallback: false,
    }, example);
  }
});
