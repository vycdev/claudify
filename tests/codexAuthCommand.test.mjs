import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_ADMIN_USER_IDS = "owner";

test("Codex commands reject guild/unauthorized contexts before any account request", async () => {
    const { createCodexAuthHandlers } = await import(
        "../build/discord/commands/codexAuth.js"
    );
    let calls = 0;
    const manager = {
        getStatus: async () => {
            calls++;
            return "subscription";
        },
    };
    const { handleText } = createCodexAuthHandlers(manager, new Set(["owner"]));
    const replies = [];
    for (const [id, guildId] of [
        ["owner", "guild"],
        ["stranger", null],
    ]) {
        assert.equal(
            await handleText({
                content: "!codex auth status",
                guildId,
                author: { id },
                reply: async (text) => replies.push(text),
            }),
            true,
        );
    }
    assert.equal(calls, 0);
    await handleText({
        content: "!codex auth status",
        author: { id: "owner" },
        channel: { type: 1 },
        guildId: null,
        reply: async (text) => replies.push(text),
    });
    assert.equal(calls, 1);
    assert.match(replies.at(-1), /subscription/);
    assert.equal(
        await handleText({
            content: "hello",
            guildId: null,
            author: { id: "owner" },
        }),
        false,
    );
});

test("Codex auth rejects group DMs and non-bot-DM slash contexts", async () => {
    const { createCodexAuthHandlers } = await import(
        "../build/discord/commands/codexAuth.js"
    );
    let calls = 0;
    const handlers = createCodexAuthHandlers(
        {
            getStatus: async () => {
                calls++;
                return "subscription";
            },
        },
        new Set(["owner"]),
    );
    await handlers.handleText({
        content: "!codex auth status",
        author: { id: "owner" },
        guildId: null,
        channel: { type: 3 },
        reply: async () => {},
    });
    assert.equal(calls, 0);
    await handlers.handleInteraction({
        user: { id: "owner" },
        guildId: null,
        context: 2,
        reply: async () => {},
        deferReply: async () => {},
        editReply: async () => {},
        options: { getSubcommand: () => "status" },
    });
    assert.equal(calls, 0);
});
