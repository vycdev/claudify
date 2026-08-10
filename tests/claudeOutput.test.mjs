import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createClaudeRunner } from "../build/claude.js";

const fixturePath = fileURLToPath(
    new URL("./fixtures/fakeClaudeLargeOutput.mjs", import.meta.url),
);
const MAX_CAPTURED_OUTPUT = 64 * 1024;

test("bounds captured Claude output without splitting astral characters", async () => {
    const previousSize = process.env.CLAUDIFY_LARGE_OUTPUT_SIZE;
    const previousUnicodeBoundary =
        process.env.CLAUDIFY_LARGE_OUTPUT_UNICODE_BOUNDARY;
    process.env.CLAUDIFY_LARGE_OUTPUT_SIZE = String(MAX_CAPTURED_OUTPUT);
    process.env.CLAUDIFY_LARGE_OUTPUT_UNICODE_BOUNDARY = "1";

    try {
        const runFakeClaude = createClaudeRunner({
            command: process.execPath,
            args: [fixturePath],
        });
        const result = await runFakeClaude([], "", { workload: "response" });

        assert.equal(result.stdout.length, MAX_CAPTURED_OUTPUT - 1);
        assert.equal(result.stderr.length, MAX_CAPTURED_OUTPUT - 1);
        assert.equal(result.stdout[0], "x");
        assert.equal(result.stderr[0], "e");
        assert.ok(result.stdout.endsWith("TAIL"));
        assert.ok(result.stderr.endsWith("ERROR_TAIL"));
    } finally {
        if (previousSize === undefined) {
            delete process.env.CLAUDIFY_LARGE_OUTPUT_SIZE;
        } else {
            process.env.CLAUDIFY_LARGE_OUTPUT_SIZE = previousSize;
        }
        if (previousUnicodeBoundary === undefined) {
            delete process.env.CLAUDIFY_LARGE_OUTPUT_UNICODE_BOUNDARY;
        } else {
            process.env.CLAUDIFY_LARGE_OUTPUT_UNICODE_BOUNDARY =
                previousUnicodeBoundary;
        }
    }
});
