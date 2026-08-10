import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const messagesDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudify-channel-history-"),
);
process.env.MESSAGES_DIR = messagesDir;

const {
    appendToLog,
    getDailyLogPath,
    loadRecentHistory,
} = await import("../build/storage/history.js");
const {
    ensureYesterdaySummaries,
    getSummaryPath,
    loadRecentSummaries,
} = await import("../build/storage/summaries.js");
const {
    getChannelHistoryFileName,
    parseChannelHistoryFileName,
} = await import("../build/storage/historyPaths.js");

test.after(() => fs.rmSync(messagesDir, { recursive: true, force: true }));

test("channel history filenames preserve IDs with complex display names", () => {
    const fileName = getChannelHistoryFileName(
        "111111111111111111",
        "release__2026-08-01",
        new Date("2026-08-02T00:00:00.000Z"),
    );
    assert.deepEqual(parseChannelHistoryFileName(fileName), {
        channelId: "111111111111111111",
        channelName: "release__2026-08-01",
        date: "2026-08-02",
    });
});

test("same-named channels use isolated history and summaries", async () => {
    const channelName = "general";
    const firstChannelId = "111111111111111111";
    const secondChannelId = "222222222222222222";
    const yesterday = new Date(Date.now() - 86_400_000);

    appendToLog(
        "first-user",
        "first channel secret",
        firstChannelId,
        channelName,
        yesterday,
    );
    appendToLog(
        "second-user",
        "second channel secret",
        secondChannelId,
        channelName,
        yesterday,
    );

    const firstLog = getDailyLogPath(firstChannelId, yesterday, channelName);
    const secondLog = getDailyLogPath(secondChannelId, yesterday, channelName);
    assert.notEqual(firstLog, secondLog);
    assert.match(fs.readFileSync(firstLog, "utf8"), /first channel secret/);
    assert.doesNotMatch(fs.readFileSync(firstLog, "utf8"), /second channel secret/);
    assert.match(fs.readFileSync(secondLog, "utf8"), /second channel secret/);

    assert.match(
        loadRecentHistory(firstChannelId, "ordinary question", channelName),
        /first channel secret/,
    );
    assert.doesNotMatch(
        loadRecentHistory(firstChannelId, "ordinary question", channelName),
        /second channel secret/,
    );

    await ensureYesterdaySummaries();
    const firstSummary = getSummaryPath(firstChannelId, yesterday, channelName);
    const secondSummary = getSummaryPath(secondChannelId, yesterday, channelName);
    assert.notEqual(firstSummary, secondSummary);
    assert.match(fs.readFileSync(firstSummary, "utf8"), /first channel secret/);
    assert.match(fs.readFileSync(secondSummary, "utf8"), /second channel secret/);

    assert.equal(
        getDailyLogPath(firstChannelId, yesterday, "renamed-general"),
        firstLog,
    );
    assert.match(
        loadRecentHistory(
            firstChannelId,
            "ordinary question",
            "renamed-general",
        ),
        /first channel secret/,
    );
    assert.equal(
        getSummaryPath(firstChannelId, yesterday, "renamed-general"),
        firstSummary,
    );
});

test("history search finds older messages using Unicode terms", () => {
    const channelId = "444444444444444444";
    const channelName = "international";
    const logPath = getDailyLogPath(channelId, new Date(), channelName);
    const lines = [
        "[09:00:00] user: 東京で決定した内容",
        ...Array.from(
            { length: 80 },
            (_, index) => {
                const minute = String(Math.floor(index / 60)).padStart(2, "0");
                const second = String(index % 60).padStart(2, "0");
                return `[10:${minute}:${second}] user: filler ${index}`;
            },
        ),
    ];
    fs.writeFileSync(logPath, `${lines.join("\n")}\n`, "utf8");

    const history = loadRecentHistory(
        channelId,
        "What did we decide about 東京?",
        channelName,
    );
    assert.match(history, /Today relevant snippets/);
    assert.match(history, /東京で決定した内容/);
});

test("automatic history loading does not fall back to legacy name-only files", () => {
    const date = new Date().toISOString().split("T")[0];
    const legacyPath = path.join(messagesDir, "history", `general_${date}.txt`);
    fs.writeFileSync(
        legacyPath,
        "[10:00:00] legacy-user: unattributed legacy secret\n",
        "utf8",
    );

    assert.doesNotMatch(
        loadRecentHistory(
            "333333333333333333",
            "ordinary question",
            "general",
        ),
        /unattributed legacy secret/,
    );
});

test("legacy flat filenames cannot collide with namespaced channel data", () => {
    const channelId = "333333333333333333";
    const channelName = "general";
    const today = new Date();
    const todayString = today.toISOString().split("T")[0];
    const collidingLegacyLog = path.join(
        messagesDir,
        "history",
        `v2_${channelId}__${channelName}_${todayString}.txt`,
    );
    fs.writeFileSync(
        collidingLegacyLog,
        "[10:00:00] legacy-user: colliding legacy history secret\n",
        "utf8",
    );

    appendToLog(
        "current-user",
        "current channel message",
        channelId,
        channelName,
        today,
    );
    const currentLog = getDailyLogPath(channelId, today, channelName);

    assert.notEqual(currentLog, collidingLegacyLog);
    assert.equal(path.basename(path.dirname(currentLog)), "v2");
    assert.match(fs.readFileSync(currentLog, "utf8"), /current channel message/);
    assert.doesNotMatch(
        loadRecentHistory(channelId, "ordinary question", channelName),
        /colliding legacy history secret/,
    );

    const yesterday = new Date(Date.now() - 86_400_000);
    const yesterdayString = yesterday.toISOString().split("T")[0];
    const collidingLegacySummary = path.join(
        messagesDir,
        "summaries",
        `v2_${channelId}__${channelName}_${yesterdayString}.txt`,
    );
    fs.writeFileSync(
        collidingLegacySummary,
        "colliding legacy summary secret",
        "utf8",
    );

    const currentSummary = getSummaryPath(channelId, yesterday, channelName);
    assert.notEqual(currentSummary, collidingLegacySummary);
    assert.equal(path.basename(path.dirname(currentSummary)), "v2");
    assert.doesNotMatch(
        loadRecentSummaries(channelId, 1, channelName),
        /colliding legacy summary secret/,
    );
});
