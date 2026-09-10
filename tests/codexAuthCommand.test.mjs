import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_ADMIN_USER_IDS = "owner";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function loginTransport(loginId) {
    const listeners = new Set();
    const calls = [];
    let account = null;
    return {
        calls,
        closed: false,
        close() { this.closed = true; },
        onNotification(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        complete() {
            account = { type: "chatgpt", email: "private@example.invalid" };
            for (const fn of listeners)
                fn("account/login/completed", { loginId, success: true });
        },
        async request(method, params) {
            calls.push({ method, params });
            if (method === "account/login/start")
                return {
                    type: "chatgptDeviceCode", loginId,
                    verificationUrl: "https://auth.openai.com/codex/device",
                    userCode: "TEST-1234",
                };
            if (method === "account/login/cancel") return { status: "canceled" };
            if (method === "account/read") return { account };
            return {};
        },
    };
}
function loginMessage(reply, send = async () => {}) {
    return {
        content: "!codex auth login",
        author: { id: "owner", send },
        guildId: null,
        channel: { type: 1 },
        reply,
    };
}

test("text login completion sends directly to the initiating author after origin deletion", async () => {
    const { CodexAuthManager } = await import("../build/codexAuth.js");
    const { createCodexAuthHandlers } = await import("../build/discord/commands/codexAuth.js");
    const client = loginTransport("deleted-origin");
    const manager = new CodexAuthManager({ clientFactory: async () => client, loginTimeoutMs: 1000 });
    const handlers = createCodexAuthHandlers(manager, new Set(["owner"]));
    let deleted = false;
    const attempts = [], delivered = [], directSends = [];
    const msg = loginMessage(async (text) => {
        attempts.push(text);
        if (deleted) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
        delivered.push(text);
    }, async function (text) {
        assert.equal(this, msg.author);
        directSends.push(text);
    });
    msg.channel.send = async () => assert.fail("Completion must go to the initiating author");
    try {
        await handlers.handleText(msg);
        deleted = true;
        client.complete();
        await tick();
        assert.equal(directSends.length, 1, "completion must survive deletion of the command");
        assert.match(directSends[0], /authenticated with a ChatGPT subscription/);
        assert.equal(attempts.length, 1);
        assert.equal(delivered.length, 1);
        assert.doesNotMatch(directSends.join(""), /private@example|deleted-origin|TEST-1234/);
        assert.equal(client.closed, true);
        assert.equal(await manager.cancelLogin("owner"), "not-pending");
    } finally {
        await manager.cancelLogin("owner");
    }
});

for (const kind of ["text", "slash"]) {
    test(`${kind} delayed old instruction rejection leaves the same owner's new login active`, async () => {
        const { CodexAuthManager } = await import("../build/codexAuth.js");
        const { createCodexAuthHandlers } = await import("../build/discord/commands/codexAuth.js");
        const clients = [loginTransport("old-login"), loginTransport("new-login")];
        let next = 0;
        const manager = new CodexAuthManager({ clientFactory: async () => clients[next++], loginTimeoutMs: 1000 });
        const handlers = createCodexAuthHandlers(manager, new Set(["owner"]));
        let rejectOldDelivery;
        const replies = [], completions = [];
        const reply = async (text) => {
            if (text.startsWith("Open <"))
                return new Promise((_, reject) => { rejectOldDelivery = reject; });
            replies.push(text);
        };
        const oldRequest = kind === "text"
            ? handlers.handleText(loginMessage(reply))
            : handlers.handleInteraction({
                user: { id: "owner", send: async () => {} },
                guildId: null, context: 1,
                deferReply: async () => {}, editReply: reply,
                options: { getSubcommand: () => "login" },
            });
        try {
            await tick();
            assert.equal(typeof rejectOldDelivery, "function");
            await handlers.handleText({
                ...loginMessage(async (text) => replies.push(text)),
                content: "!codex auth cancel",
            });
            assert.equal(clients[0].closed, true);
            assert.match(replies[0], /login cancelled/);
            await handlers.handleText(loginMessage(async () => {}, async (text) => completions.push(text)));
            assert.equal(clients[1].closed, false);
            rejectOldDelivery(new Error("SYNTHETIC_SECRET delayed Discord failure"));
            await oldRequest;
            assert.equal(clients[1].closed, false, "stale delivery cleanup must not close replacement");
            assert.equal(clients[1].calls.some(({ method }) => method === "account/login/cancel"), false);
            assert.match(replies.at(-1), /authentication could not complete/);
            assert.doesNotMatch(replies.join(""), /SYNTHETIC_SECRET|old-login|new-login|TEST-1234/);
            await assert.rejects(manager.cancelLogin("other"), /owner/);
            clients[1].complete();
            await tick();
            assert.match(completions[0], /authenticated/);
            assert.equal(clients[1].closed, true);
        } finally {
            rejectOldDelivery?.(new Error("test cleanup"));
            await oldRequest;
            await manager.cancelLogin("owner");
        }
    });

    test(`${kind} failed instruction delivery cancels its active session and sanitizes errors`, async () => {
        const { CodexAuthManager } = await import("../build/codexAuth.js");
        const { createCodexAuthHandlers } = await import("../build/discord/commands/codexAuth.js");
        const client = loginTransport("active-login");
        const original = client.request.bind(client);
        client.request = async (method, params) => {
            const result = await original(method, params);
            if (method === "account/login/cancel") throw new Error("SYNTHETIC_SECRET cancellation failure");
            return result;
        };
        const manager = new CodexAuthManager({ clientFactory: async () => client, loginTimeoutMs: 1000 });
        const handlers = createCodexAuthHandlers(manager, new Set(["owner"]));
        const replies = [];
        const reply = async (text) => {
            if (text.startsWith("Open <")) throw new Error("SYNTHETIC_SECRET delivery failure");
            replies.push(text);
        };
        try {
            if (kind === "text") await handlers.handleText(loginMessage(reply));
            else await handlers.handleInteraction({
                user: { id: "owner", send: async () => {} },
                guildId: null, context: 1,
                deferReply: async () => {}, editReply: reply,
                options: { getSubcommand: () => "login" },
            });
            assert.equal(client.closed, true);
            assert.deepEqual(client.calls.filter(({ method }) => method === "account/login/cancel"), [
                { method: "account/login/cancel", params: { loginId: "active-login" } },
            ]);
            assert.equal(await manager.cancelLogin("owner"), "not-pending");
            assert.equal(replies.length, 1);
            assert.match(replies[0], /authentication could not complete/);
            assert.doesNotMatch(replies[0], /SYNTHETIC_SECRET|active-login|TEST-1234/);
        } finally {
            await manager.cancelLogin("owner");
        }
    });
}

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
