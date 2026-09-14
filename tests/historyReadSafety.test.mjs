import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudify-history-read-safety-"),
);
const messagesDir = path.join(fixtureRoot, "messages");
process.env.MESSAGES_DIR = messagesDir;

const { getDailyLogPath } = await import(
    "../build/storage/history.js"
);

test.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

// Keep the search database in a child so its handle closes before Windows cleanup.
function loadRecentHistory(channelId, question, channelName, includeLegacyNameHistory = false) {
    const moduleUrl = new URL("../build/storage/history.js", import.meta.url).href;
    const script = `import { loadRecentHistory } from ${JSON.stringify(moduleUrl)};
        process.stdout.write(loadRecentHistory(
            ...${JSON.stringify([channelId, question, channelName])},
            new Set(), ${JSON.stringify({ includeLegacyNameHistory })}
        ));`;
    return execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
        encoding: "utf8",
    });
}

test("saved context does not follow symbolic-link history files", (t) => {
    const externalPath = path.join(fixtureRoot, "outside-history.txt");
    fs.writeFileSync(
        externalPath,
        "[10:00:00 UTC] attacker: outside history secret\n",
        "utf8",
    );

    const logPath = getDailyLogPath("safety-channel", new Date(), "general");
    try {
        fs.symlinkSync(externalPath, logPath);
    } catch (error) {
        if (process.platform === "win32" && error.code === "EPERM") {
            t.skip("Creating file symbolic links requires Windows privileges");
            return;
        }
        throw error;
    }

    const history = loadRecentHistory(
        "safety-channel",
        "ordinary question",
        "general",
    );

    assert.doesNotMatch(history, /outside history secret/);
});

test("saved context does not index or read an older log through a replaced history directory", () => {
    const olderDate = new Date(Date.now() - 10 * 86400000);
    const logPath = getDailyLogPath("directory-channel", olderDate, "general");
    const directory = path.dirname(logPath);
    const savedDirectory = `${directory}-saved`;
    const outsideDirectory = path.join(fixtureRoot, "outside-history");
    fs.mkdirSync(outsideDirectory);
    fs.writeFileSync(
        path.join(outsideDirectory, path.basename(logPath)),
        "[10:00:00 UTC] attacker: external_secret must not enter the search index\n",
        "utf8",
    );
    fs.renameSync(directory, savedDirectory);
    try {
        fs.symlinkSync(outsideDirectory, directory, process.platform === "win32" ? "junction" : "dir");
        for (let attempt = 0; attempt < 2; attempt++) {
            assert.doesNotMatch(
                loadRecentHistory("directory-channel", "external_secret", "general"),
                /external_secret/,
            );
        }
        const db = new DatabaseSync(path.join(messagesDir, "history-search.sqlite"));
        try {
            assert.equal(
                db.prepare("SELECT count(*) AS count FROM history_fts WHERE content LIKE '%external_secret%'").get().count,
                0,
            );
        } finally {
            db.close();
        }
    } finally {
        if (fs.existsSync(directory)) fs.unlinkSync(directory);
        fs.renameSync(savedDirectory, directory);
    }
});

test("cached full-text matches cannot bypass verification when file size and timestamp are unchanged", () => {
    const olderDate = new Date(Date.now() - 10 * 86400000);
    const logPath = getDailyLogPath("cached-channel", olderDate, "general");
    const directory = path.dirname(logPath);
    const savedDirectory = `${directory}-saved`;
    const outsideDirectory = path.join(fixtureRoot, "outside-cached-history");
    const modificationTime = new Date("2026-01-01T00:00:00.000Z");
    fs.writeFileSync(logPath, "[10:00:00 UTC] user: needle trusted\n", "utf8");
    fs.utimesSync(logPath, modificationTime, modificationTime);
    assert.match(loadRecentHistory("cached-channel", "needle", "general"), /needle trusted/);
    fs.mkdirSync(outsideDirectory);
    const outsidePath = path.join(outsideDirectory, path.basename(logPath));
    fs.writeFileSync(outsidePath, "[10:00:00 UTC] user: needle exposed\n", "utf8");
    fs.utimesSync(outsidePath, modificationTime, modificationTime);
    assert.equal(fs.statSync(outsidePath).size, fs.statSync(logPath).size);
    assert.equal(fs.statSync(outsidePath).mtimeMs, fs.statSync(logPath).mtimeMs);
    fs.renameSync(directory, savedDirectory);
    try {
        fs.symlinkSync(outsideDirectory, directory, process.platform === "win32" ? "junction" : "dir");
        assert.doesNotMatch(loadRecentHistory("cached-channel", "needle", "general"), /needle/);
    } finally {
        if (fs.existsSync(directory)) fs.unlinkSync(directory);
        fs.renameSync(savedDirectory, directory);
    }
    assert.match(loadRecentHistory("cached-channel", "needle", "general"), /needle trusted/);
});

test("saved context verifies yesterday and today while preserving ordinary log reads", () => {
    const channelId = "recent-channel";
    for (const [daysAgo, label] of [[0, "today"], [1, "yesterday"]]) {
        fs.writeFileSync(
            getDailyLogPath(channelId, new Date(Date.now() - daysAgo * 86400000), "general"),
            `[10:00:00 UTC] user: ${label} trusted record\n`,
            "utf8",
        );
    }
    const history = loadRecentHistory(channelId, "", "general");
    assert.match(history, /today trusted record/);
    assert.match(history, /yesterday trusted record/);
});

test("legacy context refuses a replaced history directory", () => {
    const directory = path.join(messagesDir, "history");
    const savedDirectory = `${directory}-saved`;
    const outsideDirectory = path.join(fixtureRoot, "outside-legacy-history");
    fs.mkdirSync(path.join(outsideDirectory, "v2"), { recursive: true });
    fs.writeFileSync(
        path.join(outsideDirectory, "general_2026-01-01.txt"),
        "[10:00:00 UTC] attacker: legacy_secret must not enter context\n",
        "utf8",
    );
    fs.renameSync(directory, savedDirectory);
    try {
        fs.symlinkSync(outsideDirectory, directory, process.platform === "win32" ? "junction" : "dir");
        assert.doesNotMatch(
            loadRecentHistory("legacy-channel", "legacy_secret", "general", true),
            /legacy_secret/,
        );
    } finally {
        if (fs.existsSync(directory)) fs.unlinkSync(directory);
        fs.renameSync(savedDirectory, directory);
    }
});
