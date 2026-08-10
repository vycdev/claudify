import assert from "node:assert/strict";
import test from "node:test";

import {
    authCommand,
    isPrivateAuthContext,
    parseAuthTextCommand,
} from "../build/discord/commands/auth.js";

test("slash auth is available only in private contexts", () => {
    assert.equal(isPrivateAuthContext(null), true);
    assert.equal(isPrivateAuthContext("guild-id"), false);
    assert.equal(authCommand.toJSON().dm_permission, true);
});

test("parses private auth text commands", () => {
    assert.deepEqual(parseAuthTextCommand("!auth"), {
        subcommand: "help",
    });
    assert.deepEqual(parseAuthTextCommand("  !AUTH status  "), {
        subcommand: "status",
    });
    assert.deepEqual(parseAuthTextCommand("!auth login"), {
        subcommand: "login",
        method: "subscription",
    });
    assert.deepEqual(parseAuthTextCommand("!auth login console"), {
        subcommand: "login",
        method: "console",
    });
    assert.deepEqual(parseAuthTextCommand("!auth code short-lived-code"), {
        subcommand: "code",
        code: "short-lived-code",
    });
    assert.deepEqual(parseAuthTextCommand("!auth cancel"), {
        subcommand: "cancel",
    });
});

test("rejects malformed auth text commands without matching other messages", () => {
    assert.equal(parseAuthTextCommand("!authentication status"), null);
    assert.equal(parseAuthTextCommand("hello !auth status"), null);
    assert.deepEqual(parseAuthTextCommand("!auth login api-key"), {
        subcommand: "invalid",
        error: "Use `!auth login subscription` or `!auth login console`.",
    });
    assert.deepEqual(parseAuthTextCommand("!auth code"), {
        subcommand: "invalid",
        error: "Use `!auth code <one-time-code>`.",
    });
});
