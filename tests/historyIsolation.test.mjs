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
    extractSearchTerms,
    getDailyLogPath,
    isDeepHistoryRequest,
    isHistoricalLookupRequest,
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
    uniquelyIdentifiesHistoryChannel,
} = await import("../build/storage/historyPaths.js");

test.after(() => fs.rmSync(messagesDir, { recursive: true, force: true }));

test("expanded history requires explicit recap intent", () => {
    for (const request of [
        "give me a recap",
        "summarize what happened",
        "catch me up",
        "what did I miss?",
        "tl;dr please",
        "can you answer what Alexa said earlier?",
        "look up 50 messages or more",
        "read the last 100 Discord messages",
        "scroll back and check",
        "search the channel",
    ]) {
        assert.equal(isDeepHistoryRequest(request), true, request);
    }

    for (const request of [
        "try again",
        "what about all time?",
        "do everything",
        "earlier you said this",
        "look up the exchange rate",
        "check 50 users",
        "today works",
        "full send",
    ]) {
        assert.equal(isDeepHistoryRequest(request), false, request);
    }
});

test("recognizes historical artifact lookups without treating them as recaps", () => {
    const question = "it was a pretty technical article that got pasted once when we were arguing with phage about AI hitting a ceiling and becoming unsustainable or unprofitable";

    assert.equal(isDeepHistoryRequest(question), false);
    assert.equal(isHistoricalLookupRequest(question), true);
    assert.equal(
        isHistoricalLookupRequest("find a new technical article about AI"),
        false,
    );
});

test("search-term ranking retains distinctive words late in a long request", () => {
    const terms = extractSearchTerms(
        "well thi sisnt the one i was looking for, it was a pretty technical article, i think it got pasted once when we were arguing with phage about ai hitting a ceiling/becoming unsustainable/unprofitable",
    );

    for (const expected of [
        "technical",
        "article",
        "pasted",
        "arguing",
        "phage",
        "ceiling",
        "unsustainable",
        "unprofitable",
    ]) {
        assert.ok(terms.includes(expected), `${expected}: ${terms.join(", ")}`);
    }
    assert.equal(terms.length <= 16, true);
    assert.equal(terms.includes("well"), false);
});

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

test("legacy history requires an unambiguous live channel-name mapping", () => {
    assert.equal(
        uniquelyIdentifiesHistoryChannel(
            "channel-1",
            "coding-table",
            [{ id: "channel-1", name: "coding-table" }],
        ),
        true,
    );
    assert.equal(
        uniquelyIdentifiesHistoryChannel(
            "channel-1",
            "coding-table",
            [
                { id: "channel-1", name: "coding-table" },
                { id: "channel-2", name: "coding-table" },
            ],
        ),
        false,
    );
    assert.equal(
        uniquelyIdentifiesHistoryChannel(
            "channel-1",
            "coding-table",
            [{ id: "channel-2", name: "coding-table" }],
        ),
        false,
    );
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

test("active turn message IDs are excluded from saved background context", () => {
    const channelId = "777777777777777777";
    const channelName = "conversation";
    appendToLog(
        "User",
        "background detail to retain",
        channelId,
        channelName,
        new Date(),
        {
            messageId: "background-message",
            authorId: "user-1",
            authorBot: false,
        },
    );
    appendToLog(
        "User",
        "current turn must appear only once",
        channelId,
        channelName,
        new Date(),
        {
            messageId: "current-message",
            authorId: "user-1",
            authorBot: false,
        },
    );

    const history = loadRecentHistory(
        channelId,
        "ordinary message",
        channelName,
        new Set(["current-message"]),
    );

    assert.match(history, /background detail to retain/);
    assert.doesNotMatch(history, /current turn must appear only once/);
    assert.match(history, /created_at=/);
});

test("ranked full-text search finds and incrementally indexes older channel history", () => {
    const channelId = "555555555555555555";
    const otherChannelId = "666666666666666666";
    const channelName = "research";
    const oldDate = new Date(Date.now() - 10 * 86_400_000);

    appendToLog(
        "researcher",
        "the orbital marmalade launch uses the copper checklist",
        channelId,
        channelName,
        oldDate,
    );
    appendToLog(
        "other-user",
        "orbital marmalade belongs to another isolated channel",
        otherChannelId,
        channelName,
        oldDate,
    );

    const firstSearch = loadRecentHistory(
        channelId,
        "what was the orbital marmalade decision?",
        channelName,
    );
    assert.match(firstSearch, /Ranked full-text matches/);
    assert.match(firstSearch, /copper checklist/);
    assert.doesNotMatch(firstSearch, /another isolated channel/);

    appendToLog(
        "researcher",
        "the new heliotrope protocol supersedes that checklist",
        channelId,
        channelName,
        oldDate,
    );
    const incrementalSearch = loadRecentHistory(
        channelId,
        "find the heliotrope protocol",
        channelName,
    );
    assert.match(incrementalSearch, /new heliotrope protocol/);
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

test("explicitly authorized historical lookups search bounded legacy channel files", () => {
    const legacyPath = path.join(
        messagesDir,
        "history",
        "research_2026-02-03.txt",
    );
    fs.writeFileSync(
        legacyPath,
        [
            "[10:00:00] user: unrelated setup",
            "[10:01:00] user: https://example.com/technical-scaling-paper",
            "[10:02:00] user: this is the article I showed phage",
            "[10:03:00] user: it argues that AI scaling becomes unsustainable",
        ].join("\n") + "\n",
        "utf8",
    );

    const question =
        "find the technical article I showed phage when arguing about unsustainable AI scaling";
    const isolated = loadRecentHistory(
        "unique-channel-id",
        question,
        "research",
    );
    const authorized = loadRecentHistory(
        "unique-channel-id",
        question,
        "research",
        new Set(),
        { includeLegacyNameHistory: true },
    );

    assert.doesNotMatch(isolated, /technical-scaling-paper/);
    assert.match(authorized, /uniquely resolved legacy #research history/);
    assert.match(authorized, /technical-scaling-paper/);
    assert.match(authorized, /showed phage/);
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
