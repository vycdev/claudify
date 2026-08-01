import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const limitNames = [
    "LIVE_CONTEXT_LIMIT",
    "DEEP_LIVE_CONTEXT_LIMIT",
    "HISTORY_RECENT_LINES",
    "HISTORY_RECAP_MAX_LINES",
    "HISTORY_RECAP_MAX_CHARS",
    "HISTORY_SEARCH_MAX_BLOCKS",
    "HISTORY_SEARCH_CONTEXT_LINES",
];
const defaults = [35, 500, 80, 1000, 140000, 10, 2];

function readConfigValues(names, values) {
    const messagesDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-config-limits-"),
    );
    const configUrl = new URL("../build/config.js", import.meta.url).href;
    const script = [
        `const config = await import(${JSON.stringify(configUrl)});`,
        `process.stdout.write(JSON.stringify(${JSON.stringify(names)}.map((name) => config[name])));`,
    ].join("\n");

    try {
        const result = spawnSync(
            process.execPath,
            ["--input-type=module", "--eval", script],
            {
                encoding: "utf8",
                env: {
                    ...process.env,
                    MESSAGES_DIR: messagesDir,
                    ...Object.fromEntries(
                        names.map((name, index) => [
                            name,
                            values[index],
                        ]),
                    ),
                },
            },
        );
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout);
    } finally {
        fs.rmSync(messagesDir, { recursive: true, force: true });
    }
}

function readLimits(values) {
    return readConfigValues(limitNames, values);
}

test("context limits fall back for malformed values", () => {
    assert.deepEqual(
        readLimits([
            "oops",
            "-1",
            "1.5",
            "12junk",
            "9007199254740992",
            "",
            "NaN",
        ]),
        defaults,
    );
});

test("context limits preserve valid integers including zero", () => {
    assert.deepEqual(readLimits(["0", "1", "2", "3", "4", "5", "6"]), [
        0,
        1,
        2,
        3,
        4,
        5,
        6,
    ]);
});

test("cooldown stays within Node's supported timer range", () => {
    assert.deepEqual(
        readConfigValues(["COOLDOWN_MS"], ["2147483647"]),
        [2147483647],
    );
    assert.deepEqual(
        readConfigValues(["COOLDOWN_MS"], ["2147483648"]),
        [10000],
    );
});

test("zero history line limits exclude saved history", async (t) => {
    const messagesDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-zero-history-"),
    );
    t.after(() => fs.rmSync(messagesDir, { recursive: true, force: true }));

    process.env.MESSAGES_DIR = messagesDir;
    process.env.HISTORY_RECENT_LINES = "0";
    process.env.HISTORY_RECAP_MAX_LINES = "0";
    process.env.HISTORY_RECAP_MAX_CHARS = "1000";

    const { getDailyLogPath, loadRecentHistory } = await import(
        "../build/storage/history.js"
    );
    fs.writeFileSync(
        getDailyLogPath("zero-limit"),
        "[10:00:00] user: this content must be excluded\n",
        "utf8",
    );

    assert.doesNotMatch(
        loadRecentHistory("zero-limit", "ordinary question"),
        /this content must be excluded/,
    );
    assert.doesNotMatch(
        loadRecentHistory("zero-limit", "full recap"),
        /this content must be excluded/,
    );
});
