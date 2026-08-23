import assert from "node:assert/strict";
import test from "node:test";
import { TextChannel, ThreadChannel } from "discord.js";

import { isBotMessageChannel } from "../build/discord/channel.js";

test("accepts guild text channels and threads for bot request routing", () => {
    const textChannel = Object.create(TextChannel.prototype);
    const threadChannel = Object.create(ThreadChannel.prototype);

    assert.equal(isBotMessageChannel(textChannel), true);
    assert.equal(isBotMessageChannel(threadChannel), true);
});

test("rejects non-message channels for bot request routing", () => {
    assert.equal(isBotMessageChannel(null), false);
    assert.equal(isBotMessageChannel({ isTextBased: () => true }), false);
});
