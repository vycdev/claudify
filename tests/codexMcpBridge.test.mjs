import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ListPromptsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

async function upstream({ repeatCursor = false, hang = false } = {}) {
    const calls = [], headers = [], sessions = new Set();
    const listener = http.createServer(async (req, res) => {
        if (req.method !== "POST") { res.writeHead(405).end(); return; }
        const chunks = []; for await (const c of req) chunks.push(c);
        const message = JSON.parse(Buffer.concat(chunks).toString());
        calls.push(message); headers.push(req.headers.authorization);
        if (hang) return;
        const server = new Server({ name: "trusted-fixture", version: "1" }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ["echo", "blocked"].map(name => ({ name, description: "Fixed fixture", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } })), ...(repeatCursor ? { nextCursor: "same" } : {}) }));
        server.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: "text", text: request.params.arguments.value }], isError: request.params.arguments.value === "failure" }));
        server.setRequestHandler(ReadResourceRequestSchema, async () => ({ contents: [{ uri: "fixture://canary", text: "FORBIDDEN CANARY" }] }));
        server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: "fixture://canary", name: "canary" }] }));
        server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
        server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        sessions.add(server);
        try { await server.connect(transport); await transport.handleRequest(req, res, message); }
        finally { await server.close(); sessions.delete(server); }
    });
    listener.listen(0, "127.0.0.1"); await once(listener, "listening");
    return { url: `http://127.0.0.1:${listener.address().port}/mcp`, calls, headers,
        async close() { listener.closeAllConnections(); await Promise.all([...sessions].map(s => s.close())); await new Promise(r => listener.close(r)); } };
}

test("bridge forwards only discovered authorized tools; resources/prompts never reach upstream", async () => {
    const { createCodexMcpBridge } = await import("../build/codexMcpBridge.js");
    const fixture = await upstream(); let bridge, client;
    try {
        bridge = await createCodexMcpBridge({ trusted: { url: fixture.url, http_headers: { Authorization: "Bearer SYNTHETIC-NOT-REAL" }, enabled_tools: ["echo"] } });
        const config = bridge.servers.trusted;
        assert.deepEqual(Object.keys(config).sort(), ["enabled_tools", "tools", "url"]);
        assert.deepEqual(config.enabled_tools, ["echo"]);
        assert.deepEqual(config.tools, { echo: { approval_mode: "approve" } });
        assert.ok(!JSON.stringify(config).includes("SYNTHETIC-NOT-REAL"));
        assert.notEqual(config.url, fixture.url);
        client = new Client({ name: "gateway-test", version: "1" });
        await client.connect(new StreamableHTTPClientTransport(new URL(config.url)));
        assert.deepEqual((await client.listTools()).tools.map(t => t.name), ["echo"]);
        assert.equal((await client.callTool({ name: "echo", arguments: { value: "OK" } })).content[0].text, "OK");
        assert.equal((await client.callTool({ name: "echo", arguments: { value: "failure" } })).isError, true);
        for (const request of [{ name: "blocked", arguments: { value: "NO" } }, { name: "echo", arguments: { value: 1 } }, { name: "echo", arguments: { value: "x", extra: "NO" } }]) {
            await assert.rejects(client.callTool(request));
        }
        for (const method of ["resources/list", "resources/templates/list", "resources/read", "prompts/list", "sampling/createMessage"]) {
            const response = await fetch(config.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 101, method, params: { uri: "fixture://canary" } }) });
            assert.equal((await response.json()).error.code, -32601, method);
        }
        assert.deepEqual(fixture.calls.filter(c => c.method === "tools/call").map(c => c.params.name), ["echo", "echo"]);
        assert.ok(!fixture.calls.some(c => /^(resources|prompts|sampling)\//.test(c.method)));
        assert.ok(fixture.headers.every(h => h === "Bearer SYNTHETIC-NOT-REAL"));
        await client.close(); client = undefined;
        await bridge.close(); await bridge.close();
        await assert.rejects(fetch(config.url, { signal: AbortSignal.timeout(500) }));
    } finally { await client?.close(); await bridge?.close(); await fixture.close(); }
});

test("bridge abort closes gateway and upstream; init timeout and bad discovery fail closed", async () => {
    const { createCodexMcpBridge } = await import("../build/codexMcpBridge.js");
    for (const options of [{ repeatCursor: true }, { hang: true }]) {
        const fixture = await upstream(options);
        try { await assert.rejects(createCodexMcpBridge({ trusted: { url: fixture.url } }, { requestTimeoutMs: 100 })); }
        finally { await fixture.close(); }
    }
    const fixture = await upstream(); const abort = new AbortController(); let bridge;
    try {
        bridge = await createCodexMcpBridge({ trusted: { url: fixture.url, enabled_tools: [] } }, { signal: abort.signal });
        assert.deepEqual(bridge.servers.trusted.enabled_tools, []);
        const url = bridge.servers.trusted.url;
        abort.abort(); await bridge.close();
        await assert.rejects(fetch(url, { signal: AbortSignal.timeout(500) }));
    } finally { await bridge?.close(); await fixture.close(); }
});

test("bridge refuses redirects and never forwards credentials to another endpoint", async () => {
    const { createCodexMcpBridge } = await import("../build/codexMcpBridge.js");
    const destination = await upstream();
    const redirect = http.createServer((req,res) => res.writeHead(307, { location: destination.url }).end());
    redirect.listen(0,"127.0.0.1"); await once(redirect,"listening");
    try {
        await assert.rejects(createCodexMcpBridge({ trusted: { url: `http://127.0.0.1:${redirect.address().port}/mcp`, http_headers: { Authorization: "Bearer SYNTHETIC" } } }, { requestTimeoutMs: 200 }));
        assert.deepEqual(destination.calls, []);
    } finally { redirect.closeAllConnections(); await new Promise(r=>redirect.close(r)); await destination.close(); }
});
