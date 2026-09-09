import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const messagesDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudify-response-events-"),
);
process.env.MESSAGES_DIR = messagesDir;

const {
    appendResponseEvent,
    getResponseEventsPath,
    loadRecentResponseEvents,
} = await import("../build/storage/responseEvents.js");

test.after(() => fs.rmSync(messagesDir, { recursive: true, force: true }));

function makeEvent(channelId) {
    return {
        version: 1,
        createdAt: "2026-08-26T18:27:55.000Z",
        channelId,
        guildId: null,
        authorId: "user-1",
        sourceMessageId: "message-1",
        replyToMessageId: null,
        responseTargetMessageId: "message-1",
        reason: "answer",
        reaction: null,
        textRequired: true,
        textRequirement: "current-question",
        textPresent: true,
        structured: true,
        contractFallback: false,
    };
}

test("appending an event does not read or replace the existing daily log", () => {
    const event = makeEvent("channel-append-cost");
    const eventsPath = getResponseEventsPath(event.channelId, new Date(event.createdAt));
    const prefix = `${JSON.stringify(event)}\n`.repeat(1024);
    fs.writeFileSync(eventsPath, prefix);
    const before = fs.statSync(eventsPath, { bigint: true });
    const originalRead = fs.readFileSync;
    let logReads = 0;
    fs.readFileSync = (file, ...args) => {
        if (typeof file === "number") {
            const opened = fs.fstatSync(file, { bigint: true });
            if (opened.ino === before.ino && opened.dev === before.dev) logReads++;
        } else if (path.resolve(String(file)) === eventsPath) {
            logReads++;
        }
        return originalRead(file, ...args);
    };
    try {
        appendResponseEvent(event);
    } finally {
        fs.readFileSync = originalRead;
    }
    assert.equal(logReads, 0, "Appending must not reread the accumulated log");
    const after = fs.statSync(eventsPath, { bigint: true });
    assert.equal(after.ino, before.ino, "Appending must preserve the log inode");
    assert.equal(fs.readFileSync(eventsPath, "utf8"), `${prefix}${JSON.stringify(event)}\n`);
});

test("response event appends reject hard-linked destinations", () => {
    const event = makeEvent("channel-hard-link");
    const targetPath = path.join(messagesDir, "hard-link-victim.jsonl");
    const eventsPath = getResponseEventsPath(event.channelId, new Date(event.createdAt));
    fs.writeFileSync(targetPath, "DO NOT MODIFY\n");
    fs.linkSync(targetPath, eventsPath);
    assert.throws(() => appendResponseEvent(event), /Could not safely save response event/);
    assert.equal(fs.readFileSync(targetPath, "utf8"), "DO NOT MODIFY\n");
});

test("response event appends preserve another writer's first event", () => {
    const event = makeEvent("channel-create-race");
    const eventsPath = getResponseEventsPath(event.channelId, new Date(event.createdAt));
    const otherEvent = { ...event, authorId: "other-writer" };
    const originalOpen = fs.openSync;
    let raced = false;
    fs.openSync = (file, flags, ...args) => {
        if (file === eventsPath && typeof flags === "number" && (flags & fs.constants.O_EXCL)) {
            assert.equal(raced, false);
            raced = true;
            fs.writeFileSync(eventsPath, `${JSON.stringify(otherEvent)}\n`);
        }
        return originalOpen(file, flags, ...args);
    };
    try {
        appendResponseEvent(event);
    } finally {
        fs.openSync = originalOpen;
    }
    assert.equal(raced, true);
    assert.deepEqual(loadRecentResponseEvents(event.channelId, 8, new Date(event.createdAt)), [otherEvent, event]);
});

test("response event appends reject replaced file identities before writing", () => {
    const event = makeEvent("channel-file-race");
    const eventsPath = getResponseEventsPath(event.channelId, new Date(event.createdAt));
    const savedPath = `${eventsPath}.saved`;
    fs.writeFileSync(eventsPath, "ORIGINAL\n");
    const originalOpen = fs.openSync;
    let raced = false;
    fs.openSync = (file, flags, ...args) => {
        if (file === eventsPath && typeof flags === "number" && (flags & fs.constants.O_APPEND)) {
            raced = true;
            fs.renameSync(eventsPath, savedPath);
            fs.writeFileSync(eventsPath, "REPLACEMENT\n");
        }
        return originalOpen(file, flags, ...args);
    };
    try {
        assert.throws(() => appendResponseEvent(event), /Could not safely save response event/);
    } finally {
        fs.openSync = originalOpen;
    }
    assert.equal(raced, true);
    assert.equal(fs.readFileSync(eventsPath, "utf8"), "REPLACEMENT\n");
    assert.equal(fs.readFileSync(savedPath, "utf8"), "ORIGINAL\n");
});

test("response event appends reject a directory swap before writing", () => {
    const event = makeEvent("channel-directory-race");
    const eventsPath = getResponseEventsPath(event.channelId, new Date(event.createdAt));
    const directory = path.dirname(eventsPath);
    const movedDirectory = `${directory}-original`;
    const outsideDirectory = path.join(messagesDir, "outside-events");
    const targetPath = path.join(outsideDirectory, path.basename(eventsPath));
    fs.mkdirSync(outsideDirectory);
    fs.writeFileSync(targetPath, "DO NOT MODIFY\n");
    fs.writeFileSync(eventsPath, "ORIGINAL\n");
    const originalOpen = fs.openSync;
    let moved = false;
    let linked = false;
    fs.openSync = (file, flags, ...args) => {
        if (file === eventsPath && typeof flags === "number" && (flags & fs.constants.O_APPEND)) {
            fs.renameSync(directory, movedDirectory);
            moved = true;
            fs.symlinkSync(outsideDirectory, directory, "junction");
            linked = true;
        }
        return originalOpen(file, flags, ...args);
    };
    try {
        assert.throws(() => appendResponseEvent(event), /Could not safely save response event/);
        assert.equal(linked, true);
        assert.equal(fs.readFileSync(targetPath, "utf8"), "DO NOT MODIFY\n");
    } finally {
        fs.openSync = originalOpen;
        if (linked) fs.unlinkSync(directory);
        if (moved) fs.renameSync(movedDirectory, directory);
    }
    assert.equal(fs.readFileSync(eventsPath, "utf8"), "ORIGINAL\n");
});

test("concurrent response event writers retain every complete record", { timeout: 30_000 }, async () => {
    const event = makeEvent("channel-concurrent");
    const moduleUrl = new URL("../build/storage/responseEvents.js", import.meta.url).href;
    const runners = Array.from({ length: 4 }, (_, writer) => {
        const script = `
            const { appendResponseEvent } = await import(${JSON.stringify(moduleUrl)});
            const event = ${JSON.stringify(event)};
            process.once("message", () => {
                for (let index = 0; index < 50; index++) {
                    appendResponseEvent({ ...event, sourceMessageId: ${JSON.stringify(`${writer}-`)} + index });
                }
                process.disconnect();
            });
            process.send("ready");
        `;
        const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
            env: { ...process.env, MESSAGES_DIR: messagesDir },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        let stderr = "";
        child.stderr.on("data", chunk => { stderr += chunk; });
        const ready = new Promise((resolve, reject) => {
            child.once("message", message => {
                if (message === "ready") resolve();
                else reject(new Error(`Unexpected child message: ${message}`));
            });
            child.once("error", reject);
            child.once("exit", () => reject(new Error(`Writer exited before ready: ${stderr}`)));
        });
        const finished = new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("close", code => {
                if (code === 0) resolve();
                else reject(new Error(`Writer failed (${code}): ${stderr}`));
            });
        });
        return { child, ready, finished };
    });
    try {
        await Promise.all([
            Promise.all(runners.map(runner => runner.ready)).then(() => {
                for (const { child } of runners) child.send("go");
            }),
            Promise.all(runners.map(runner => runner.finished)),
        ]);
        const eventsPath = getResponseEventsPath(event.channelId, new Date(event.createdAt));
        const records = fs.readFileSync(eventsPath, "utf8").trimEnd().split("\n").map(JSON.parse);
        assert.equal(records.length, 200);
        assert.equal(new Set(records.map(record => record.sourceMessageId)).size, 200);
        assert.ok(records.every(record => record.channelId === event.channelId));
    } finally {
        for (const { child } of runners) {
            if (child.exitCode === null) child.kill();
        }
    }
});

test("stores auditable response metadata separately from conversation text", () => {
    const event = {
        version: 1,
        createdAt: "2026-08-25T18:27:55.000Z",
        channelId: "channel-1",
        guildId: "guild-1",
        authorId: "user-1",
        sourceMessageId: "message-1",
        replyToMessageId: "bot-question-1",
        responseTargetMessageId: "message-1",
        reason: "acknowledgement",
        reaction: null,
        textRequired: true,
        textRequirement: "answer-to-bot-question",
        textPresent: true,
        structured: true,
        contractFallback: false,
    };

    appendResponseEvent(event);

    assert.deepEqual(
        loadRecentResponseEvents(
            "channel-1",
            8,
            new Date("2026-08-25T19:00:00.000Z"),
        ),
        [event],
    );
});

test("response event writes and reads do not follow symbolic links", (t) => {
    const event = {
        version: 1,
        createdAt: "2026-08-26T18:27:55.000Z",
        channelId: "channel-symlink",
        guildId: null,
        authorId: "user-1",
        sourceMessageId: "message-1",
        replyToMessageId: null,
        responseTargetMessageId: "message-1",
        reason: "answer",
        reaction: null,
        textRequired: true,
        textRequirement: "current-question",
        textPresent: true,
        structured: true,
        contractFallback: false,
    };
    const targetPath = path.join(messagesDir, "outside-events.jsonl");
    fs.writeFileSync(targetPath, `${JSON.stringify(event)}\n`, "utf8");
    const eventsPath = path.join(
        messagesDir,
        "response-events",
        "channel-symlink_2026-08-26.jsonl",
    );
    try {
        fs.symlinkSync(targetPath, eventsPath);
    } catch (error) {
        if (process.platform === "win32" && error.code === "EPERM") {
            t.skip("Creating file symlinks requires Windows Developer Mode or elevation");
            return;
        }
        throw error;
    }

    assert.throws(
        () => appendResponseEvent(event),
        /Could not safely save response event/,
    );
    assert.deepEqual(
        loadRecentResponseEvents(
            "channel-symlink",
            8,
            new Date("2026-08-26T19:00:00.000Z"),
        ),
        [],
    );
    assert.equal(
        fs.readFileSync(targetPath, "utf8"),
        `${JSON.stringify(event)}\n`,
    );
});
