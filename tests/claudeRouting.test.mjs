import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runClaude } from "../build/claude.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

test("queued workloads keep isolated model, effort, environment, and logs", async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-routing-"));
    const capturePath = path.join(tempDir, "captures.jsonl");
    const cliPath = path.join(tempDir, "claude");
    const fixturePath = path.join(currentDir, "fixtures", "fakeClaudeRouting.mjs");
    fs.copyFileSync(fixturePath, cliPath);
    fs.chmodSync(cliPath, 0o755);

    const original = {
        path: process.env.PATH,
        capture: process.env.CLAUDIFY_ROUTING_CAPTURE_PATH,
        model: process.env.ANTHROPIC_MODEL,
        consoleError: console.error,
    };
    const logs = [];
    process.env.PATH = `${tempDir}${path.delimiter}${original.path ?? ""}`;
    process.env.CLAUDIFY_ROUTING_CAPTURE_PATH = capturePath;
    process.env.ANTHROPIC_MODEL = "ambient-model-must-not-leak";
    console.error = (...args) => logs.push(args.join(" "));

    t.after(() => {
        console.error = original.consoleError;
        for (const [name, value] of [
            ["PATH", original.path],
            ["CLAUDIFY_ROUTING_CAPTURE_PATH", original.capture],
            ["ANTHROPIC_MODEL", original.model],
        ]) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const [response, summary] = await Promise.all([
        runClaude(["-p"], "response-input", {
            workload: "response",
            model: "response-model",
            effort: "high",
        }),
        runClaude(["-p"], "summary-input", {
            workload: "daily-summary",
            effort: "low",
        }),
    ]);

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
    assert.deepEqual(byInput["summary-input"].args, ["--effort", "low", "-p"]);
    assert.equal(byInput["summary-input"].anthropicModel, null);
    assert.ok(logs.some((line) => line.includes("[Claude CLI][response]")));
    assert.ok(logs.some((line) => line.includes("[Claude CLI][daily-summary]")));
    assert.ok(logs.every((line) => !line.includes("response-input")));
    assert.ok(logs.every((line) => !line.includes("summary-input")));
});
