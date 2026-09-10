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

export { transport };
