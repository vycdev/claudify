import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const messagesDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudify-summary-workload-"),
);
process.env.MESSAGES_DIR = messagesDir;
process.env.CLAUDE_SUMMARY_MODEL = "summary-test-model";
process.env.CLAUDE_SUMMARY_EFFORT = "max";
process.env.HISTORY_RECAP_MAX_LINES = "3";
process.env.HISTORY_RECAP_MAX_CHARS = "20";

const { getDailyLogPath } = await import("../build/storage/history.js");
const { generateDailySummary, getSummaryPath } = await import(
    "../build/storage/summaries.js"
);

test.after(() => fs.rmSync(messagesDir, { recursive: true, force: true }));

test("daily summaries declare the daily-summary workload", async () => {
    const date = new Date("2026-08-01T12:00:00Z");
    const logPath = getDailyLogPath("channel-1", date, "general");
    fs.writeFileSync(logPath, "one\ntwo\nthree\n", "utf8");

    let capturedOptions;
    await generateDailySummary(
        "channel-1",
        "general",
        date,
        async (_args, _input, options) => {
            capturedOptions = options;
            return { stdout: "A useful summary", stderr: "" };
        },
    );

    assert.deepEqual(capturedOptions, {
        workload: "daily-summary",
        model: "summary-test-model",
        effort: "max",
    });
    assert.equal(
        fs.readFileSync(getSummaryPath("channel-1", date, "general"), "utf8"),
        "A useful summary",
    );
});

test("daily summaries cap input to the recent history budget", async () => {
    const date = new Date("2026-08-02T12:00:00Z");
    const logPath = getDailyLogPath("channel-2", date, "general");
    fs.writeFileSync(logPath, "old\nmiddle\nrecent\nlatest\n", "utf8");

    let capturedInput;
    await generateDailySummary(
        "channel-2",
        "general",
        date,
        async (_args, input) => {
            capturedInput = input;
            return { stdout: "Capped summary", stderr: "" };
        },
    );

    assert.equal(capturedInput, "middle\nrecent\nlatest");
});
