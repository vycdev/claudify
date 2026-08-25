import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const messagesDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudify-response-events-"),
);
process.env.MESSAGES_DIR = messagesDir;

const {
    appendResponseEvent,
    loadRecentResponseEvents,
} = await import("../build/storage/responseEvents.js");

test.after(() => fs.rmSync(messagesDir, { recursive: true, force: true }));

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
