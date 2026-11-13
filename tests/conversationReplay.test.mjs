import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    buildHistoricalSearchText,
    buildConversationTurnState,
} from "../build/discord/turn.js";
import {
    enforceResponseContract,
    parseClaudeResponse,
} from "../build/discord/response.js";

test("historical search joins only contiguous recent messages from the author", () => {
    const current = new Date("2026-08-28T09:31:22.000Z");
    const searchText = buildHistoricalSearchText(
        "@Claudify do you know what article im talking about?",
        "user-1",
        current,
        [
            {
                authorId: "other-user",
                content: "unrelated older topic",
                createdAt: new Date("2026-08-28T09:20:00.000Z"),
            },
            {
                authorId: "user-1",
                content: "i cant find that article",
                createdAt: new Date("2026-08-28T09:25:31.000Z"),
            },
            {
                authorId: "user-1",
                content: "i feel like you sent it here and showed it to phage",
                createdAt: new Date("2026-08-28T09:25:41.000Z"),
            },
        ],
    );

    assert.match(searchText, /cant find that article/);
    assert.match(searchText, /showed it to phage/);
    assert.match(searchText, /do you know what article/);
    assert.doesNotMatch(searchText, /unrelated older topic/);
});

test("historical search stops at an intervening author, even when an older message matches", () => {
    const current = new Date("2026-08-28T09:31:00.000Z");
    const searchText = buildHistoricalSearchText("current question", "user-1", current, [
        { authorId: "user-1", content: "older private topic", createdAt: new Date("2026-08-28T09:28:00.000Z") },
        { authorId: "other-user", content: "topic changed", createdAt: new Date("2026-08-28T09:29:00.000Z") },
        { authorId: "user-1", content: "recent relevant topic", createdAt: new Date("2026-08-28T09:30:00.000Z") },
    ]);

    assert.equal(searchText, "recent relevant topic\ncurrent question");
});

test("historical search enforces the gap and message-count bounds", () => {
    const current = new Date("2026-08-28T09:31:00.000Z");
    const messages = Array.from({ length: 8 }, (_, index) => ({
        authorId: "user-1",
        content: `recent ${index}`,
        createdAt: new Date(current.getTime() - (8 - index) * 60_000),
    }));
    messages.unshift({
        authorId: "user-1",
        content: "too old",
        createdAt: new Date(current.getTime() - 30 * 60_000),
    });

    assert.equal(
        buildHistoricalSearchText("current", "user-1", current, messages),
        "recent 2\nrecent 3\nrecent 4\nrecent 5\nrecent 6\nrecent 7\ncurrent",
    );
    assert.equal(
        buildHistoricalSearchText("current", "user-1", current, [
            messages[0],
            { authorId: "user-1", content: "recent", createdAt: new Date(current.getTime() - 60_000) },
        ]),
        "recent\ncurrent",
    );
});

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(fs.readFileSync(
    path.join(currentDir, "fixtures", "conversation-replays.json"),
    "utf8",
));

for (const fixture of fixtures) {
    test(`replay turn framing: ${fixture.id}`, () => {
        const state = buildConversationTurnState(fixture.invocation);
        assert.equal(
            state.requiresTextResponse,
            fixture.expect.requiresTextResponse,
        );
        assert.equal(state.textRequirement, fixture.expect.textRequirement);
        assert.equal(
            state.responseTargetMessageId,
            fixture.invocation.sourceMessageId,
        );
    });
}

test("reaction-only output cannot replace an answer to the bot's question", () => {
    const fixture = fixtures.find(
        ({ id }) => id === "answer-to-bot-question-needs-text",
    );
    const state = buildConversationTurnState(fixture.invocation);
    const parsed = parseClaudeResponse(JSON.stringify({
        text: "",
        reaction: "doubt",
        reason: "skepticism",
        targetMessageId: fixture.invocation.sourceMessageId,
    }));
    const enforced = enforceResponseContract(parsed, state);

    assert.equal(enforced.text, "Got it.");
    assert.deepEqual(enforced.reactions, []);
    assert.equal(enforced.reason, "contract-fallback");
    assert.equal(enforced.contractFallback, true);
});

test("a structured response cannot react to a different message", () => {
    const state = buildConversationTurnState({
        triggerKind: "message",
        sourceMessageId: "current-message",
        messageContent: "Thanks",
    });
    const parsed = parseClaudeResponse(JSON.stringify({
        text: "You're welcome.",
        reaction: "👍",
        reason: "acknowledgement",
        targetMessageId: "other-message",
    }));

    const enforced = enforceResponseContract(parsed, state);
    assert.equal(enforced.targetMessageId, "current-message");
    assert.deepEqual(enforced.reactions, []);
    assert.equal(enforced.text, "You're welcome.");
    assert.equal(enforced.historyContent, "You're welcome.");
    assert.equal(enforced.reason, "contract-fallback");
    assert.equal(enforced.contractFallback, true);
});

test("a structured response to the active message retains its reaction", () => {
    const state = buildConversationTurnState({
        triggerKind: "message",
        sourceMessageId: "current-message",
        messageContent: "Thanks",
    });
    const parsed = parseClaudeResponse(JSON.stringify({
        text: "You're welcome.",
        reaction: "👍",
        reason: "acknowledgement",
        targetMessageId: "current-message",
    }));

    const enforced = enforceResponseContract(parsed, state);
    assert.equal(enforced.targetMessageId, "current-message");
    assert.deepEqual(enforced.reactions, ["👍"]);
    assert.equal(enforced.reason, "acknowledgement");
    assert.equal(enforced.contractFallback, false);
});
