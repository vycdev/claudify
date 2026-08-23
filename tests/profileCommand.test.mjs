import assert from "node:assert/strict";
import test from "node:test";

import {
    createProfileMessageOptions,
} from "../build/discord/commands/profile.js";

test("profile replies disable Discord mention parsing", () => {
    assert.deepEqual(
        createProfileMessageOptions("**Profile:** @everyone"),
        {
            content: "**Profile:** @everyone",
            allowedMentions: { parse: [] },
        },
    );
});
