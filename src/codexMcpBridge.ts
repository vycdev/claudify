import http from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CodexMcpServer } from "./codex.js";

export interface CodexGatewayServer {
    url: string;
    enabled_tools: string[];
    tools: Record<string, { approval_mode: "approve" }>;
}
export interface CodexMcpBridge {
    servers: Record<string, CodexGatewayServer>;
    close(): Promise<void>;
}
export interface CodexMcpBridgeOptions { signal?: AbortSignal; requestTimeoutMs?: number }
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_TOOLS = 256;

/** Trusted configuration is the only source of destinations. Never proxy RPC methods. */
export async function createCodexMcpBridge(
    configured: Record<string, CodexMcpServer>,
    options: CodexMcpBridgeOptions = {},
): Promise<CodexMcpBridge> {
    const lifetime = new AbortController();
    const timeout = options.requestTimeoutMs ?? 10_000;
    const clients = new Set<Client>();
    const sessions = new Set<Server>();
    const routes = new Map<string, { client: Client; tools: Tool[]; validators: Map<string, ReturnType<AjvJsonSchemaValidator["getValidator"]>> }>();
    const servers: Record<string, CodexGatewayServer> = Object.create(null);
    let closing: Promise<void> | undefined;
    const listener = http.createServer(async (req, res) => {
        const route = routes.get(req.url ?? "");
        if (lifetime.signal.aborted || !route || req.headers.origin || req.headers.host !== `127.0.0.1:${(listener.address() as { port: number }).port}`) { res.writeHead(403).end(); return; }
        if (req.method !== "POST") { res.writeHead(405).end(); return; }
        if (sessions.size >= 16) { res.writeHead(503).end(); return; }
        const server = new Server({ name: "claudify-tools-only", version: "1" }, { capabilities: { tools: {} } });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        sessions.add(server);
        const timer = setTimeout(() => { res.destroy(); void server.close().catch(() => {}); }, timeout);
        try {
            let size = 0; const chunks: Buffer[] = [];
            for await (const chunk of req) { size += chunk.length; if (size > MAX_BYTES) throw new Error("Request too large"); chunks.push(chunk); }
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
            server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: route.tools }));
            server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
                const validate = route.validators.get(request.params.name);
                if (!validate) throw new McpError(ErrorCode.InvalidParams, "Tool is not authorized by Claudify");
                const args = request.params.arguments ?? {};
                if (!validate(args).valid) throw new McpError(ErrorCode.InvalidParams, "Invalid tool arguments");
                try {
                    // Deliberately drop client-supplied _meta, destinations, task and auth fields.
                    return await route.client.callTool({ name: request.params.name, arguments: args }, undefined, {
                        signal: AbortSignal.any([lifetime.signal, extra.signal]), timeout, maxTotalTimeout: timeout,
                    });
                } catch {
                    throw new McpError(ErrorCode.InternalError, "Upstream tool failed; an action may have started. Verify before retrying.");
                }
            });
            // No resources, prompts, sampling, roots or arbitrary forwarding handlers.
            await server.connect(transport);
            await transport.handleRequest(req, res, body);
        } catch { if (!res.headersSent) res.writeHead(400).end("Invalid MCP request"); else res.destroy(); }
        finally { clearTimeout(timer); await server.close().catch(() => {}); sessions.delete(server); }
    });
    listener.requestTimeout = timeout;
    listener.headersTimeout = timeout;
    listener.maxConnections = 32;
    listener.setTimeout(timeout);
    listener.on("timeout", socket => socket.destroy());
    const close = (): Promise<void> => {
        if (closing) return closing;
        options.signal?.removeEventListener("abort", abort);
        lifetime.abort(); routes.clear();
        const stopped = new Promise<void>(resolve => listener.close(() => resolve()));
        listener.closeAllConnections();
        closing = (async () => {
            let timer: NodeJS.Timeout | undefined;
            try {
                await Promise.race([
                    Promise.allSettled([stopped, ...[...clients, ...sessions].map(c => c.close())]),
                    new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); }),
                ]);

            } finally { clearTimeout(timer); }
        })();
        return closing;
    };
    const abort = () => { void close(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
        options.signal?.throwIfAborted();
        if (Object.keys(configured).length > 8) throw new Error("Too many MCP servers");
        for (const [name, config] of Object.entries(configured)) {
            lifetime.signal.throwIfAborted();
            if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error("Invalid MCP name");
            const url = new URL(config.url);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("Invalid MCP URL");
            const client = new Client({ name: "claudify-tools-only", version: "1" }, { capabilities: {} });
            clients.add(client);
            const transport = new StreamableHTTPClientTransport(url, {
                requestInit: { headers: config.http_headers, redirect: "error" },
                reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 100, maxReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
                fetch: async (input, init) => {
                    if (String(input) !== url.href) throw new Error("MCP destination change denied");
                    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeout), ...(init?.signal ? [init.signal] : [])]);
                    const headers = new Headers(init?.headers);
                    headers.set("connection", "close"); // Do not retain per-run sockets in the shared HTTP pool.
                    const response = await fetch(input, { ...init, headers, redirect: "error", signal });
                    // Bound both discovery schemas and tool results, including streamed responses.
                    let bytes = 0;
                    const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
                        bytes += chunk.byteLength;
                        if (bytes > MAX_BYTES) throw new Error("MCP response too large");
                        controller.enqueue(chunk);
                    } }));
                    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
                },
            });
            await client.connect(transport, { signal: lifetime.signal, timeout, maxTotalTimeout: timeout });
            const tools: Tool[] = []; const names = new Set<string>(); const cursors = new Set<string>();
            let cursor: string | undefined; let schemaBytes = 0;
            do {
                const page = await client.listTools(cursor ? { cursor } : {}, { signal: lifetime.signal, timeout, maxTotalTimeout: timeout });
                for (const tool of page.tools) {
                    schemaBytes += Buffer.byteLength(JSON.stringify(tool));
                    if (names.has(tool.name) || names.size >= MAX_TOOLS || schemaBytes > MAX_BYTES || !/^[a-zA-Z0-9_.-]{1,128}$/.test(tool.name)) throw new Error("Invalid MCP catalog");
                    names.add(tool.name);
                    // Omitted enabled_tools intentionally trusts this configured server's tool catalog.
                    // Explicit [] authorizes nothing. Freeze the discovered set for this run.
                    if (!config.enabled_tools || config.enabled_tools.includes(tool.name)) tools.push(tool);
                }
                cursor = page.nextCursor;
                if (cursor && (cursors.has(cursor) || cursors.size >= 16)) throw new Error("MCP pagination did not advance");
                if (cursor) cursors.add(cursor);
            } while (cursor);
            const validators = new Map(tools.map(tool => [tool.name, new AjvJsonSchemaValidator().getValidator(tool.inputSchema)]));
            const route = `/${randomUUID()}`;
            routes.set(route, { client, tools, validators });
            servers[name] = { url: route, enabled_tools: tools.map(t => t.name), tools: Object.fromEntries(tools.map(t => [t.name, { approval_mode: "approve" as const }])) };
        }
        lifetime.signal.throwIfAborted();
        if (routes.size) { listener.listen({ port: 0, host: "127.0.0.1", signal: lifetime.signal }); await once(listener, "listening", { signal: lifetime.signal }); }
        lifetime.signal.throwIfAborted();
        for (const server of Object.values(servers)) server.url = `http://127.0.0.1:${(listener.address() as { port: number }).port}${server.url}`;
        return { servers, close };
    } catch { await close(); throw new Error("Could not initialize the tools-only MCP bridge. Check trusted server configuration and availability."); }
}
