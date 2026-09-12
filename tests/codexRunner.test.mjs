import assert from "node:assert/strict";
import test from "node:test";

export function fakeClient({
    account = { type: "chatgpt" },
    failed = false,
    pending = false,
    rerouted = false,
    efforts = ["medium"],
} = {}) {
    const listeners = new Set();
    const calls = [];
    const emit = (method, params) => {
        for (const listener of listeners) listener(method, params);
    };
    return {
        calls,
        closed: false,
        emit,
        onNotification(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        close() {
            this.closed = true;
        },
        async request(method, params) {
            calls.push({ method, params });
            if (method === "account/read") return { account };
            if (method === "model/list")
                return {
                    data: [
                        {
                            model: "gpt-5.6-luna",
                            supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })),
                        },
                    ],
                    nextCursor: null,
                };
            if (method === "thread/start")
                return {
                    thread: { id: "thread-1", environments: [] },
                    model: "gpt-5.6-luna",
                    modelProvider: "openai",
                    sandbox: { type: "readOnly" },
                    approvalPolicy: "never",
                };
            if (method === "turn/start") {
                if (!pending)
                    setImmediate(() => {
                        if (rerouted)
                            emit("model/rerouted", {
                                threadId: "thread-1",
                                turnId: "turn-1",
                                fromModel: "gpt-5.6-luna",
                                toModel: "another-model",
                                reason: "safety",
                            });
                        emit("item/started", {
                            threadId: "thread-1",
                            turnId: "turn-1",
                            item: {
                                type: "mcpToolCall",
                                id: "call-1",
                                server: "morpheus",
                                tool: "run_command",
                                status: "inProgress",
                            },
                        });
                        emit("item/completed", {
                            threadId: "thread-1",
                            turnId: "turn-1",
                            item: {
                                type: "mcpToolCall",
                                id: "call-1",
                                server: "morpheus",
                                tool: "run_command",
                                status: "completed",
                                result: {
                                    content: [],
                                    structuredContent: { success: !failed },
                                },
                            },
                        });
                        emit("item/completed", {
                            threadId: "thread-1",
                            turnId: "turn-1",
                            item: {
                                type: "agentMessage",
                                id: "answer",
                                phase: "final_answer",
                                text: '{"text":"Done"}',
                            },
                        });
                        emit("turn/completed", {
                            threadId: "thread-1",
                            turn: { id: "turn-1", status: "completed" },
                        });
                    });
                return { turn: { id: "turn-1" } };
            }
            return {};
        },
    };
}

test("Codex sends ultra unchanged only when the selected model advertises it", async () => {
    const { createCodexRunner } = await import("../build/codex.js");
    for (const supported of [true, false]) {
        const client = fakeClient({ efforts: supported ? ["medium", "ultra"] : ["medium"] });
        const run = createCodexRunner({
            home: "/tmp/unused-test-home",
            clientFactory: async () => client,
        });
        const operation = run([], "hello", {
            workload: "response", model: "gpt-5.6-luna", effort: "ultra",
        });
        if (supported) {
            await operation;
            assert.equal(client.calls.find(call => call.method === "turn/start").params.effort, "ultra");
        } else {
            await assert.rejects(operation, /does not support the configured reasoning effort/);
            assert.ok(!client.calls.some(call => call.method === "thread/start" || call.method === "turn/start"));
        }
        assert.equal(client.closed, true);
    }
});

test("Codex rejects provider model rerouting without retrying or bypassing it", async () => {
    const { createCodexRunner } = await import("../build/codex.js");
    const client = fakeClient({ rerouted: true });
    const run = createCodexRunner({
        home: "/tmp/unused",
        clientFactory: async () => client,
    });
    await assert.rejects(
        run([], "hello", {
            workload: "response",
            model: "gpt-5.6-luna",
            effort: "medium",
        }),
        /rerout/i,
    );
    assert.equal(client.closed, true);
    assert.equal(
        client.calls.filter((call) => call.method === "turn/start").length,
        1,
    );
});

test("Codex runner uses a subscription, explicit model, isolated read-only thread, and MCP evidence", async () => {
    const { createCodexRunner } = await import("../build/codex.js");
    const client = fakeClient();
    const run = createCodexRunner({
        home: "/tmp/unused-test-home",
        clientFactory: async () => client,
        mcpServers: { discord: { url: "http://127.0.0.1:3100/mcp" } },
        bridgeFactory: async () => ({ servers: {}, close: async () => {} }),
    });
    const result = await run(
        ["-p", "--system-prompt", "You are a Discord bot."],
        "hello",
        { workload: "response", model: "gpt-5.6-luna", effort: "medium" },
    );
    assert.equal(result.stdout, '{"text":"Done"}');
    assert.equal(result.trace.toolCalls[0].name, "mcp__morpheus__run_command");
    assert.equal(result.trace.toolCalls[0].resultStatus, "success");
    const thread = client.calls.find(
        (call) => call.method === "thread/start",
    ).params;
    assert.equal(thread.sandbox, "read-only");
    assert.equal(thread.approvalPolicy, "never");
    assert.equal(thread.ephemeral, true);
    assert.deepEqual(thread.environments, []);
    assert.deepEqual(client.calls.find(c => c.method === "turn/start").params.environments, []);
    assert.equal(thread.config["orchestrator.skills.enabled"], false);
    assert.equal(thread.config["features.shell_tool"], false);
    assert.equal(thread.config["features.view_image"], false);
    assert.equal(thread.model, "gpt-5.6-luna");
    assert.equal(client.closed, true);
});

test("Codex rejects authentication, model, effort, and sandbox fallbacks", async () => {
    const { createCodexRunner } = await import("../build/codex.js");
    for (const mode of ["api", "model", "effort", "sandbox", "environment", "missing-environment"]) {
        const client = fakeClient({
            account: mode === "api" ? { type: "apiKey" } : { type: "chatgpt" },
        });
        const original = client.request.bind(client);
        client.request = async (method, params) => {
            const result = await original(method, params);
            if (method === "thread/start" && mode === "sandbox")
                result.sandbox = { type: "dangerFullAccess" };
            if (method === "thread/start" && mode === "environment") result.thread.environments = [{ type: "local" }];
            if (method === "thread/start" && mode === "missing-environment") delete result.thread.environments;
            return result;
        };
        const run = createCodexRunner({
            home: "/tmp/unused-test-home",
            clientFactory: async () => client,
        });
        await assert.rejects(
            run(["-p"], "hello", {
                workload: "response",
                model: mode === "model" ? "not-in-catalog" : "gpt-5.6-luna",
                effort: mode === "effort" ? "max" : "medium",
            }),
        );
        assert.ok(
            !client.calls.some((call) => call.method === "turn/start"),
            mode,
        );
        assert.ok(client.closed);
    }
});

test("Codex background work has no MCP or web access and retains failed-action evidence", async () => {
    const { createCodexRunner } = await import("../build/codex.js");
    const client = fakeClient({ failed: true });
    const run = createCodexRunner({
        home: "/tmp/unused-test-home",
        clientFactory: async () => client,
        bridgeFactory: async () => { throw new Error("Background must not connect to an upstream server"); },
        mcpServers: { discord: { url: "http://127.0.0.1:3100/mcp" } },
    });
    const result = await run(["-p"], "extract facts", {
        workload: "profile-update",
        model: "gpt-5.6-luna",
        effort: "medium",
    });
    const config = client.calls.find((call) => call.method === "thread/start")
        .params.config;
    assert.deepEqual(config.mcp_servers, {});
    assert.equal(config.web_search, "disabled");
    assert.equal(result.trace.toolCalls[0].resultStatus, "failure");
});

test("Codex timeouts free the queue and never report success", async () => {
    const { createCodexRunner } = await import("../build/codex.js");
    const client = fakeClient({ pending: true });
    const run = createCodexRunner({
        home: "/tmp/unused-test-home",
        clientFactory: async () => client,
        timeoutMs: 25,
    });
    await assert.rejects(
        run(["-p"], "hello", {
            workload: "response",
            model: "gpt-5.6-luna",
            effort: "medium",
        }),
        (error) => error.code === "CODEX_TIMEOUT",
    );
    assert.ok(client.closed);
});

test("Codex runner owns bridge lifecycle and exposes only the gateway, including errors and timeout", async () => {
    const { createCodexRunner } = await import("../build/codex.js");
    for (const mode of ["success", "thread-error", "turn-timeout", "init-error", "late-init"]) {
        const client = fakeClient({ pending: mode === "turn-timeout" });
        const request = client.request.bind(client);
        client.request = async (method, params) => {
            if (mode === "thread-error" && method === "thread/start") throw new Error("Fixture thread error");
            return request(method, params);
        };
        let closed = 0, signal, release;
        const delayed = new Promise(resolve => { release = resolve; });
        const upstream = { discord: { url: "http://trusted.invalid/mcp", http_headers: { Authorization: "SYNTHETIC-UPSTREAM-ONLY" }, enabled_tools: ["echo"] } };
        const gateways = { discord: { url: "http://127.0.0.1:1234/opaque-fixture", enabled_tools: ["echo"], tools: { echo: { approval_mode: "approve" } } } };
        const run = createCodexRunner({ home: "/tmp/unused", clientFactory: async () => client, mcpServers: upstream,
            timeoutMs: 100, bridgeFactory: async (config, options) => {
                assert.equal(config, upstream); signal = options.signal;
                if (mode === "init-error") throw new Error("Fixture bridge init error");
                if (mode === "late-init") await delayed;
                return { servers: gateways, async close() { closed++; } };
            } });
        const operation = run([], "fixture", { workload: "response", model: "gpt-5.6-luna", effort: "medium" });
        if (mode === "success") await operation;
        else await assert.rejects(operation, /Fixture|timed out/i);
        if (mode === "late-init") { release(); await new Promise(resolve => setImmediate(resolve)); }
        assert.ok(signal.aborted); assert.ok(client.closed);
        assert.equal(closed, mode === "init-error" ? 0 : 1, mode);
        const thread = client.calls.find(c => c.method === "thread/start");
        if (thread) {
            assert.equal(thread.params.config.mcp_servers.discord.url, gateways.discord.url);
            assert.deepEqual(thread.params.config.mcp_servers.discord.tools, gateways.discord.tools);
            assert.ok(!JSON.stringify(thread).includes("SYNTHETIC-UPSTREAM-ONLY"));
            assert.ok(!JSON.stringify(thread).includes("trusted.invalid"));
        }
        if (mode === "late-init" || mode === "init-error") assert.ok(!thread);
    }
});
