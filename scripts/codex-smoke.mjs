// Real Codex app-server and MCP transport smoke test. No login or inference.
// Run after npm run build; CODEX_BIN may select an installed pinned CLI.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createCodexClient } from "../build/codexClient.js";
import { codexThreadConfig } from "../build/codex.js";
import { CODEX_NO_ENVIRONMENT, requireNoEnvironment } from "../build/codexPolicy.js";
import { createCodexMcpBridge } from "../build/codexMcpBridge.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-codex-smoke-"));
let client;
let bridge;
const httpServer = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
    }
    const server = new Server(
        { name: "claudify-smoke", version: "1.0.0" },
        { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "smoke",
                description:
                    "Return a fixed smoke-test marker; no external effects.",
                inputSchema: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                },
            },
        ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({
        content: [{ type: "text", text: "claudify-mcp-smoke-ok" }],
    }));
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
    });
    try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
    } catch {
        if (!res.headersSent) res.writeHead(500).end();
    } finally {
        await transport.close();
        await server.close();
    }
});
try {
    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    client = await createCodexClient({
        home,
        executable: { command: process.env.CODEX_BIN || "codex" },
    });
    const account = await client.request("account/read", {
        refreshToken: false,
    });
    assert.equal(
        account.account,
        null,
        "Smoke test must use an empty, isolated auth home",
    );
    bridge = await createCodexMcpBridge({ smoke: {
        url: `http://127.0.0.1:${httpServer.address().port}/mcp`, enabled_tools: ["smoke"],
    } });
    const thread = await client.request("thread/start", {
        model: "gpt-5.6-luna",
        modelProvider: "openai",
        ephemeral: true,
        ...CODEX_NO_ENVIRONMENT,
        cwd: home,
        sandbox: "read-only",
        approvalPolicy: "never",
        config: codexThreadConfig(bridge.servers, true),
    });
    assert.equal(thread.model, "gpt-5.6-luna");
    assert.equal(thread.modelProvider, "openai");
    assert.equal(thread.sandbox.type, "readOnly");
    assert.equal(thread.approvalPolicy, "never");
    requireNoEnvironment(thread);
    const tools = await client.request("mcpServerStatus/list", {
        threadId: thread.thread.id,
        detail: "toolsAndAuthOnly",
        limit: 100,
    });
    assert.ok(tools.data.some((server) => server.name === "smoke"));
    const called = await client.request("mcpServer/tool/call", {
        threadId: thread.thread.id,
        server: "smoke",
        tool: "smoke",
        arguments: {},
    });
    assert.match(JSON.stringify(called), /claudify-mcp-smoke-ok/);
    console.log(
        JSON.stringify({
            authenticated: false,
            inferencePerformed: false,
            model: thread.model,
            sandbox: thread.sandbox.type,
            mcpRoundTrip: "passed",
            toolsOnlyBridge: true,
            environments: thread.thread.environments,
        }),
    );
} finally {
    client?.close();
    await bridge?.close();
    httpServer.closeAllConnections();
    await new Promise((resolve) => httpServer.close(resolve));
    // Give the app-server its bounded shutdown grace before removing its DBs.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    fs.rmSync(home, { recursive: true, force: true });
}
