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
    "MCP_HISTORY_MAX_CHARS",
];
const defaults = [35, 500, 80, 1000, 140000, 10, 2, 120000];

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

function readBotEffort(value) {
    const messagesDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-config-effort-"),
    );
    const configUrl = new URL("../build/config.js", import.meta.url).href;
    const script = [
        `const config = await import(${JSON.stringify(configUrl)});`,
        "process.stdout.write(JSON.stringify(config.BOT_EFFORT));",
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
                    BOT_EFFORT: value,
                },
            },
        );
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout);
    } finally {
        fs.rmSync(messagesDir, { recursive: true, force: true });
    }
}

function readHistory({
    recentLines,
    recapLines,
    recapChars,
    question,
    content = "[10:00:00] user: this content must be excluded\n",
    daysAgo = 0,
    searchContextLines = "2",
}) {
    const messagesDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-zero-history-"),
    );
    const historyUrl = new URL("../build/storage/history.js", import.meta.url).href;
    const script = [
        `const fs = await import("node:fs");`,
        `const history = await import(${JSON.stringify(historyUrl)});`,
        `const logDate = new Date(Date.now() - ${daysAgo} * 86400000);`,
        `fs.writeFileSync(history.getDailyLogPath("zero-limit", logDate), ${JSON.stringify(content)}, "utf8");`,
        `process.stdout.write(history.loadRecentHistory("zero-limit", ${JSON.stringify(question)}));`,
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
                    HISTORY_RECENT_LINES: recentLines,
                    HISTORY_RECAP_MAX_LINES: recapLines,
                    HISTORY_RECAP_MAX_CHARS: recapChars,
                    HISTORY_SEARCH_CONTEXT_LINES: searchContextLines,
                },
            },
        );
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
    } finally {
        fs.rmSync(messagesDir, { recursive: true, force: true });
    }
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
            "0",
        ]),
        defaults,
    );
});

test("context limits preserve valid integers including zero", () => {
    assert.deepEqual(readLimits(["0", "1", "2", "3", "4", "5", "6", "12345"]), [
        0,
        1,
        2,
        3,
        4,
        5,
        6,
        12345,
    ]);
});

test("live context character budget falls back for malformed values", () => {
    assert.deepEqual(
        readConfigValues(["LIVE_CONTEXT_MAX_CHARS"], ["not-a-number"]),
        [140000],
    );
    assert.deepEqual(
        readConfigValues(["LIVE_CONTEXT_MAX_CHARS"], ["0"]),
        [0],
    );
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

test("memory batching limits use bounded positive integers", () => {
    const names = [
        "MEMORY_UPDATE_DEBOUNCE_MS",
        "MEMORY_UPDATE_MAX_DELAY_MS",
        "MEMORY_UPDATE_BATCH_MAX_CHARS",
    ];
    assert.deepEqual(
        readConfigValues(names, ["0", "2147483648", "1000001"]),
        [120000, 600000, 20000],
    );
    assert.deepEqual(
        readConfigValues(names, ["30000", "120000", "50000"]),
        [30000, 120000, 50000],
    );
});

test("required role IDs ignore surrounding configuration whitespace", () => {
    assert.deepEqual(
        readConfigValues(["REQUIRED_ROLE_ID"], [" 123456789012345678 "]),
        ["123456789012345678"],
    );
});

test("bot effort accepts documented values and normalizes casing", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
        assert.equal(readBotEffort(effort), effort);
    }
    assert.equal(readBotEffort("  HIGH  "), "high");
});

test("bot effort falls back to the CLI default for unsupported values", () => {
    assert.equal(readBotEffort("bogus"), "");
    assert.equal(readBotEffort(""), "");
});

test("zero history budgets exclude saved history", () => {
    const zeroLines = {
        recentLines: "0",
        recapLines: "0",
        recapChars: "1000",
    };

    assert.doesNotMatch(
        readHistory({ ...zeroLines, question: "ordinary question" }),
        /this content must be excluded/,
    );
    assert.doesNotMatch(
        readHistory({ ...zeroLines, question: "excluded content" }),
        /this content must be excluded/,
    );
    assert.doesNotMatch(
        readHistory({ ...zeroLines, question: "full recap" }),
        /this content must be excluded/,
    );
    assert.doesNotMatch(
        readHistory({
            recentLines: "1",
            recapLines: "1",
            recapChars: "0",
            question: "excluded content",
        }),
        /this content must be excluded/,
    );
});

test("relevant history snippets honor the history character budget", () => {
    const result = readHistory({
        recentLines: "80",
        recapLines: "1000",
        recapChars: "100",
        question: "excluded content",
    });

    assert.doesNotMatch(result, /this content must be excluded/);
});

test("relevant snippets leave only their remaining budget for recent history", () => {
    const result = readHistory({
        recentLines: "80",
        recapLines: "1000",
        recapChars: "160",
        question: "needle",
        content: [
            "[10:00:00] user: needle detail",
            "[10:01:00] user: recent detail",
            "",
        ].join("\n"),
        searchContextLines: "0",
    });

    assert.match(result, /needle detail/);
    assert.doesNotMatch(result, /recent detail/);
});

test("yesterday search snippets honor the history character budget", () => {
    const result = readHistory({
        recentLines: "80",
        recapLines: "1000",
        recapChars: "100",
        question: "excluded content",
        daysAgo: 1,
    });

    assert.doesNotMatch(result, /this content must be excluded/);
});
