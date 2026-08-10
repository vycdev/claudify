import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createClaudeRunner } from "../build/claude.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

test("queued workloads keep isolated model, effort, environment, and logs", async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-routing-"));
    const capturePath = path.join(tempDir, "captures.jsonl");
    const fixturePath = path.join(currentDir, "fixtures", "fakeClaudeRouting.mjs");
    const runFakeClaude = createClaudeRunner({
        command: process.execPath,
        args: [fixturePath],
    });

    const original = {
        capture: process.env.CLAUDIFY_ROUTING_CAPTURE_PATH,
        model: process.env.ANTHROPIC_MODEL,
        claudeCode: process.env.CLAUDECODE,
        mixedClaudeCode: process.env.ClAuDeCoDe,
        consoleError: console.error,
    };
    const logs = [];
    process.env.CLAUDIFY_ROUTING_CAPTURE_PATH = capturePath;
    process.env.ANTHROPIC_MODEL = "ambient-model-must-not-leak";
    process.env.CLAUDECODE = "1";
    process.env.ClAuDeCoDe = "mixed-case-must-not-leak";
    console.error = (...args) => logs.push(args.join(" "));

    t.after(() => {
        console.error = original.consoleError;
        for (const [name, value] of [
            ["CLAUDIFY_ROUTING_CAPTURE_PATH", original.capture],
            ["ANTHROPIC_MODEL", original.model],
            ["CLAUDECODE", original.claudeCode],
            ["ClAuDeCoDe", original.mixedClaudeCode],
        ]) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const results = await Promise.allSettled([
        runFakeClaude(["-p"], "response-input", {
            workload: "response",
            model: "response-model",
            effort: "high",
        }),
        runFakeClaude(["-p"], "summary-input", {
            workload: "daily-summary",
            effort: "low",
        }),
    ]);
    for (const result of results) {
        assert.equal(result.status, "fulfilled", result.reason?.message);
    }
    const [response, summary] = results.map((result) => result.value);

    assert.equal(response.stdout, "response:response-input");
    assert.equal(summary.stdout, "response:summary-input");

    const records = fs.readFileSync(capturePath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const byInput = Object.fromEntries(records.map((record) => [record.input, record]));
    assert.deepEqual(byInput["response-input"].args, [
        "--effort",
        "high",
        "--model",
        "response-model",
        "-p",
    ]);
    assert.equal(byInput["response-input"].anthropicModel, "response-model");
    assert.equal(byInput["response-input"].claudeCode, null);
    assert.deepEqual(byInput["summary-input"].args, ["--effort", "low", "-p"]);
    assert.equal(byInput["summary-input"].anthropicModel, null);
    assert.equal(byInput["summary-input"].claudeCode, null);
    assert.ok(logs.some((line) => line.includes("[Claude CLI][response]")));
    assert.ok(logs.some((line) => line.includes("[Claude CLI][daily-summary]")));
    assert.ok(logs.every((line) => !line.includes("response-input")));
    assert.ok(logs.every((line) => !line.includes("summary-input")));
});
