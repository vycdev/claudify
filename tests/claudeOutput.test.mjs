import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createClaudeRunner } from "../build/claude.js";

const fixturePath = fileURLToPath(
    new URL("./fixtures/fakeClaudeLargeOutput.mjs", import.meta.url),
);
const MAX_CAPTURED_OUTPUT = 64 * 1024;

test("bounds captured Claude stdout and stderr while retaining their tails", async () => {
    const previousSize = process.env.CLAUDIFY_LARGE_OUTPUT_SIZE;
    process.env.CLAUDIFY_LARGE_OUTPUT_SIZE = "70000";

    try {
        const runFakeClaude = createClaudeRunner({
            command: process.execPath,
            args: [fixturePath],
        });
        const result = await runFakeClaude([], "", { workload: "response" });

        assert.equal(result.stdout.length, MAX_CAPTURED_OUTPUT);
        assert.equal(result.stderr.length, MAX_CAPTURED_OUTPUT);
        assert.ok(result.stdout.endsWith("TAIL"));
        assert.ok(result.stderr.endsWith("ERROR_TAIL"));
    } finally {
        if (previousSize === undefined) {
            delete process.env.CLAUDIFY_LARGE_OUTPUT_SIZE;
        } else {
            process.env.CLAUDIFY_LARGE_OUTPUT_SIZE = previousSize;
        }
    }
});
