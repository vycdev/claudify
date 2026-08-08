import assert from "node:assert/strict";
import test from "node:test";

import {
    hasContentBesidesBotMentions,
    normalizeBotMentions,
} from "../build/discord/mentions.js";

const botUserId = "123456789012345678";

test("normalizes plain and nickname-form bot mentions", () => {
    assert.equal(
        normalizeBotMentions(
            `<@${botUserId}> hello, <@!${botUserId}>`,
            botUserId,
            "Claudify",
        ),
        "Claudify hello, Claudify",
    );
});

test("normalizes every bot mention without changing other mentions", () => {
    assert.equal(
        normalizeBotMentions(
            `<@${botUserId}> ask <@987654321098765432> then <@${botUserId}>`,
            botUserId,
            "Claudify",
        ),
        "Claudify ask <@987654321098765432> then Claudify",
    );
});

test("normalizes mentions in ask commands and treats bot names literally", () => {
    assert.equal(
        normalizeBotMentions(
            `!ask <@!${botUserId}> what does $& mean?`,
            botUserId,
            "$&",
        ),
        "!ask $& what does $& mean?",
    );
});

test("treats bare bot mentions as empty questions", () => {
    assert.equal(
        hasContentBesidesBotMentions(`<@${botUserId}>`, botUserId),
        false,
    );
    assert.equal(
        hasContentBesidesBotMentions(
            `  <@!${botUserId}>\n<@${botUserId}>  `,
            botUserId,
        ),
        false,
    );
});

test("recognizes question content alongside bot mentions", () => {
    assert.equal(
        hasContentBesidesBotMentions(
            `<@${botUserId}> how does this work?`,
            botUserId,
        ),
        true,
    );
    assert.equal(
        hasContentBesidesBotMentions(
            `<@${botUserId}> ask <@987654321098765432>`,
            botUserId,
        ),
        true,
    );
});
