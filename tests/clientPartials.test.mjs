import assert from "node:assert/strict";
import test from "node:test";

import { Partials } from "discord.js";
import { client } from "../build/discord/client.js";

test("enables the partials required for reactions on uncached messages", () => {
    assert.ok(client.options.partials.includes(Partials.Channel));
    assert.ok(client.options.partials.includes(Partials.Message));
    assert.ok(client.options.partials.includes(Partials.Reaction));
});
