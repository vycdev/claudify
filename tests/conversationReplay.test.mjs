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
