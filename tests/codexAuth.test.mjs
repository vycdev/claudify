import assert from "node:assert/strict";
import test from "node:test";

function transport(cancelStatus = "canceled") {
    const listeners = new Set();
    let account = null;
    const calls = [];
    return {
        calls,
        closed: false,
        emitClose() {
            for (const fn of listeners) fn("$closed", {});
        },
        emitCompletion(params) {
            for (const fn of listeners) fn("account/login/completed", params);
        },
        onNotification(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        close() {
            this.closed = true;
        },
        async request(method, params) {
            calls.push({ method, params });
            if (method === "account/login/start")
                return {
                    type: "chatgptDeviceCode",
                    loginId: "login-1",
                    verificationUrl: "https://auth.openai.com/codex/device",
                    userCode: "ABCD-1234",
                };
            if (method === "account/login/cancel")
                return { status: cancelStatus };
            if (method === "account/read") return { account };
            if (method === "account/logout") account = null;
            return {};
        },
        complete(type = "chatgpt") {
            account = { type, email: "private@example.invalid" };
            for (const fn of listeners)
                fn("account/login/completed", {
                    loginId: "login-1",
                    success: true,
                });
        },
    };
}

test("cancellation distinguishes provider notFound from an actual cancellation", async () => {
    const { CodexAuthManager } = await import("../build/codexAuth.js");
    for (const status of ["canceled", "notFound"]) {
        const client = transport(status);
        const manager = new CodexAuthManager({
            clientFactory: async () => client,
            loginTimeoutMs: 1000,
        });
        await manager.startLogin("owner", () => {});
        assert.equal(
            await manager.cancelLogin("owner"),
            status === "canceled" ? "canceled" : "not-pending",
        );
        assert.equal(client.closed, true);
        assert.equal(await manager.cancelLogin("owner"), "not-pending");
    }
});

test("completion rechecks saved auth with a fresh client after stale state or transport failure", async () => {
    const { CodexAuthManager } = await import("../build/codexAuth.js");
    for (const mode of ["stale", "closed"]) {
        const login = transport();
        const fresh = transport();
        fresh.complete();
        if (mode === "closed") {
            const original = login.request.bind(login);
            login.request = async (method, params) => {
                if (method === "account/read") {
                    login.emitClose();
                    throw new Error("secret raw transport payload");
                }
                return original(method, params);
            };
        }
        let factories = 0;
        const notices = [], outcomes = [];
        const manager = new CodexAuthManager({
            clientFactory: async () => factories++ === 0 ? login : fresh,
            loginTimeoutMs: 1000,
            onOutcome: outcome => outcomes.push(outcome),
        });
        await manager.startLogin("owner", message => notices.push(message));
        login.emitCompletion({ loginId: "unrelated", success: true });
        login.emitCompletion({ loginId: "login-1", success: true });
        login.emitCompletion({ loginId: "login-1", success: true });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(factories, 2);
        assert.equal(notices.length, 1);
        assert.match(notices[0], /authenticated/);
        assert.deepEqual(outcomes, ["verified-fresh"]);
        assert.ok(login.closed && fresh.closed);
        assert.doesNotMatch(JSON.stringify({ notices, outcomes }), /secret|private@example|ABCD|login-1/);
    }
});

test("failed provider completion cannot be credited to an existing subscription", async () => {
    const { CodexAuthManager } = await import("../build/codexAuth.js");
    const client = transport();
    client.complete();
    const notices = [], outcomes = [];
    let factories = 0;
    const manager = new CodexAuthManager({
        clientFactory: async () => { factories++; return client; },
        loginTimeoutMs: 1000,
        onOutcome: outcome => outcomes.push(outcome),
    });
    await manager.startLogin("owner", message => notices.push(message));
    client.emitCompletion({ loginId: "login-1", success: false, error: "secret token" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(factories, 1);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /OpenAI reported.*did not complete/);
    assert.doesNotMatch(notices[0], /secret|authenticated/);
    assert.deepEqual(outcomes, ["provider-failed"]);
    assert.ok(client.closed);
});

test("missing, unsupported, or unreadable persisted auth is inconclusive, never success", async () => {
    const { CodexAuthManager } = await import("../build/codexAuth.js");
    for (const mode of ["missing", "apiKey", "read-error", "factory-error"]) {
        const login = transport(), fresh = transport();
        if (mode === "apiKey") fresh.complete("apiKey");
        if (mode === "read-error") fresh.request = async () => { throw new Error("secret"); };
        let factories = 0;
        const notices = [], outcomes = [];
        const manager = new CodexAuthManager({
            clientFactory: async () => {
                if (factories++ === 0) return login;
                if (mode === "factory-error") throw new Error("secret");
                return fresh;
            },
            loginTimeoutMs: 1000,
            onOutcome: outcome => outcomes.push(outcome),
        });
        await manager.startLogin("owner", message => notices.push(message));
        login.emitCompletion({ loginId: "login-1", success: true });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(notices.length, 1);
        assert.match(notices[0], /could not verify.*Check !codex auth status/);
        assert.doesNotMatch(notices[0], /secret|is authenticated|Retry !codex auth login/);
        assert.deepEqual(outcomes, ["verification-unavailable"]);
        assert.ok(login.closed);
        if (mode !== "factory-error") assert.ok(fresh.closed);
    }
});

test("cancel or deadline during fresh-client creation/read suppresses late completion and closes clients", async (t) => {
    const { CodexAuthManager } = await import("../build/codexAuth.js");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const stage of ["factory", "read"]) {
        for (const ending of ["cancel", "timeout"]) {
            const login = transport(), fresh = transport(), replacement = transport();
            const notices = [], outcomes = [];
            let release, factories = 0;
            const waiting = new Promise(resolve => { release = resolve; });
            if (stage === "read") fresh.request = async () => waiting;
            const manager = new CodexAuthManager({
                clientFactory: async () => {
                    factories++;
                    if (factories === 1) return login;
                    if (factories === 2) return stage === "factory" ? waiting : fresh;
                    return replacement;
                },
                loginTimeoutMs: 1000,
                onOutcome: outcome => outcomes.push(outcome),
            });
            await manager.startLogin("owner", message => notices.push(message));
            login.emitCompletion({ loginId: "login-1", success: true });
            await new Promise(resolve => setImmediate(resolve));
            if (ending === "cancel") await manager.cancelLogin("owner");
            else t.mock.timers.tick(1000);
            await manager.startLogin("owner", () => {});
            release(stage === "factory" ? fresh : { account: { type: "chatgpt" } });
            await new Promise(resolve => setImmediate(resolve));
            assert.ok(login.closed && fresh.closed);
            assert.equal(replacement.closed, false);
            assert.equal(notices.length, ending === "cancel" ? 0 : 1);
            if (ending === "timeout") {
                assert.match(notices[0], /verification timed out.*Check !codex auth status/);
                assert.deepEqual(outcomes, ["verification-timeout"]);
            } else assert.deepEqual(outcomes, []);
            await manager.cancelLogin("owner");
        }
    }
});

test("device login returns only the official code/link and verifies subscription completion", async () => {
    const { CodexAuthManager } = await import("../build/codexAuth.js");
    const client = transport();
    const notifications = [];
    const manager = new CodexAuthManager({
        clientFactory: async () => client,
        loginTimeoutMs: 1000,
    });
    const login = await manager.startLogin("owner", (message) => {
        notifications.push(message);
    });
    assert.equal(login.userCode, "ABCD-1234");
    assert.equal(login.verificationUrl, "https://auth.openai.com/codex/device");
    await assert.rejects(
        manager.startLogin("other", () => {}),
        /active/,
    );
    await assert.rejects(manager.cancelLogin("other"), /owner/);
    client.complete();
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(notifications[0], /authenticated/);
    assert.doesNotMatch(notifications.join(""), /private@example/);
    assert.ok(client.closed);
    assert.deepEqual(client.calls[0], {
        method: "account/login/start",
        params: { type: "chatgptDeviceCode" },
    });
});

test("private usage reads provider limits without exposing account identity or API-cost estimates", async () => {
    const { CodexAuthManager } = await import("../build/codexAuth.js");
    const client = transport();
    const original = client.request.bind(client);
    client.request = async (method, params) =>
        method === "account/rateLimits/read"
            ? {
                  rateLimits: {
                      primary: {
                          usedPercent: 25,
                          windowDurationMins: 300,
                          resetsAt: 1789012800,
                      },
                      secondary: null,
                      credits: { balance: "secret-balance" },
                  },
              }
            : original(method, params);
    client.complete();
    const manager = new CodexAuthManager({
        clientFactory: async () => client,
        loginTimeoutMs: 1000,
    });
    const usage = await manager.getUsage();
    assert.match(usage, /75% remaining/);
    assert.doesNotMatch(usage, /secret-balance|private@example|\$/);
    assert.ok(client.closed);
});

test("private usage labels every quota bucket and does not duplicate the legacy view", async () => {
    const { CodexAuthManager } = await import("../build/codexAuth.js");
    const client = transport();
    const original = client.request.bind(client);
    const window = (usedPercent) => ({ usedPercent, windowDurationMins: 300 });
    client.request = async (method, params) => method === "account/rateLimits/read"
        ? {
            rateLimits: { primary: window(10) },
            rateLimitsByLimitId: {
                codex: { limitName: "Standard", primary: window(10), secondary: window(25) },
                extra: { limitId: "codex_extra", primary: window(100) },
                unknown: { primary: null, secondary: { usedPercent: null } },
            },
        }
        : original(method, params);
    client.complete();
    const manager = new CodexAuthManager({ clientFactory: async () => client, loginTimeoutMs: 1000 });
    const usage = await manager.getUsage();
    assert.match(usage, /Standard: 300-minute window: 90% remaining/);
    assert.match(usage, /Standard: 300-minute window: 75% remaining/);
    assert.match(usage, /codex_extra: 300-minute window: 0% remaining/);
    assert.match(usage, /unknown: OpenAI did not report allowance windows/);
    assert.equal(usage.match(/90% remaining/g)?.length, 1);
    assert.ok(client.closed);
});

test("private usage falls back when the multi-bucket view is unavailable", async () => {
    const { CodexAuthManager } = await import("../build/codexAuth.js");
    for (const byId of [undefined, null, {}, []]) {
        const client = transport();
        const original = client.request.bind(client);
        client.request = async (method, params) => method === "account/rateLimits/read"
            ? { rateLimitsByLimitId: byId, rateLimits: { primary: { usedPercent: 25 } } }
            : original(method, params);
        client.complete();
        const manager = new CodexAuthManager({ clientFactory: async () => client, loginTimeoutMs: 1000 });
        assert.match(await manager.getUsage(), /primary: 75% remaining/);
        assert.ok(client.closed);
    }
});

test("auth failures, expiry, and cancellation clean up without relaying secrets", async () => {
    const { CodexAuthManager } = await import("../build/codexAuth.js");
    for (const mode of [
        "unsupported",
        "expired",
        "cancelled",
        "malformed",
        "disconnected",
    ]) {
        const client = transport();
        const notices = [];
        const manager = new CodexAuthManager({
            clientFactory: async () => client,
            loginTimeoutMs: 25,
        });
        if (mode === "malformed") {
            client.request = async () => ({
                type: "chatgptDeviceCode",
                loginId: "login-1",
                verificationUrl: "https://evil.invalid/?token=secret",
                userCode: "secret",
            });
            await assert.rejects(
                manager.startLogin("owner", (m) => notices.push(m)),
                /Could not start/,
            );
        } else {
            await manager.startLogin("owner", (m) => notices.push(m));
            if (mode === "unsupported") client.complete("apiKey");
            if (mode === "cancelled") await manager.cancelLogin("owner");
            if (mode === "disconnected") client.emitClose?.();
            await new Promise((resolve) => setTimeout(resolve, 40));
        }
        assert.ok(client.closed, mode);
        assert.doesNotMatch(notices.join(""), /secret|private@example/);
    }
});

test("a pending logout blocks new login attempts", async () => {
    const { CodexAuthManager } = await import("../build/codexAuth.js");
    const client = transport();
    let release;
    const original = client.request.bind(client);
    client.request = async (method, params) =>
        method === "account/logout"
            ? await new Promise((resolve) => {
                  release = resolve;
              })
            : original(method, params);
    const manager = new CodexAuthManager({
        clientFactory: async () => client,
        loginTimeoutMs: 1000,
    });
    const logout = manager.logout("owner");
    await new Promise((resolve) => setImmediate(resolve));
    try {
        await assert.rejects(
            manager.startLogin("other", () => {}),
            /active|progress/,
        );
    } finally {
        release({});
        await logout;
        await manager.cancelLogin("other");
    }
});

test("delivery cancellation is opaque, owner-protected, and cleans up its active session", async (t) => {
    const { CodexAuthManager } = await import("../build/codexAuth.js");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const status of ["canceled", "notFound"]) {
        const client = transport(status);
        const notices = [];
        const manager = new CodexAuthManager({
            clientFactory: async () => client,
            loginTimeoutMs: 1000,
        });
        try {
            const login = await manager.startLogin("owner", (m) => notices.push(m));
            assert.deepEqual(Object.keys(login).sort(), [
                "cancelDelivery", "userCode", "verificationUrl",
            ]);
            assert.equal(typeof login.cancelDelivery, "function");
            await assert.rejects(manager.cancelLogin("other"), /owner/);
            assert.equal(client.closed, false);
            await login.cancelDelivery();
            await login.cancelDelivery();
            assert.equal(client.closed, true);
            assert.deepEqual(
                client.calls.filter(({ method }) => method === "account/login/cancel"),
                [{ method: "account/login/cancel", params: { loginId: "login-1" } }],
            );
            assert.equal(await manager.cancelLogin("owner"), "not-pending");
            t.mock.timers.tick(1000);
            client.complete();
            await new Promise((resolve) => setImmediate(resolve));
            assert.deepEqual(notices, []);
        } finally {
            await manager.cancelLogin("owner");
        }
    }
});

test("stale delivery cancellation cannot affect a replacement session after cancel, completion, or timeout", async (t) => {
    const { CodexAuthManager } = await import("../build/codexAuth.js");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const ending of ["cancel", "completion", "timeout"]) {
        const clients = [transport(), transport()];
        let next = 0;
        const notices = [];
        const manager = new CodexAuthManager({
            clientFactory: async () => clients[next++],
            loginTimeoutMs: 1000,
        });
        try {
            const oldLogin = await manager.startLogin("owner", (m) => notices.push(m));
            if (ending === "cancel") await manager.cancelLogin("owner");
            if (ending === "completion") clients[0].complete();
            if (ending === "timeout") t.mock.timers.tick(1000);
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(clients[0].closed, true);
            await manager.startLogin("owner", () => {});
            await oldLogin.cancelDelivery();
            await oldLogin.cancelDelivery();
            assert.equal(clients[1].closed, false, ending);
            assert.equal(clients[1].calls.some(({ method }) => method === "account/login/cancel"), false);
            await assert.rejects(manager.cancelLogin("other"), /owner/);
            assert.equal(await manager.cancelLogin("owner"), "canceled");
            t.mock.timers.tick(1000);
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(notices.length, ending === "cancel" ? 0 : 1);
            assert.doesNotMatch(notices.join(""), /private@example|login-1|ABCD-1234/);
        } finally {
            await manager.cancelLogin("owner");
        }
    }
});

export { transport };
