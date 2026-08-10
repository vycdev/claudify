import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "http";
import fs from "fs";
import {
    MCP_MAX_REQUEST_BYTES,
    MCP_PORT,
    MCP_CONFIG_PATH,
} from "../config.js";
import { createMcpServer } from "./server.js";

const ALLOWED_ORIGINS = new Set([
    `http://localhost:${MCP_PORT}`,
    `http://127.0.0.1:${MCP_PORT}`,
]);

function writeJsonRpcError(
    res: http.ServerResponse,
    status: number,
    code: number,
    message: string,
): void {
    res.writeHead(status, { "Content-Type": "application/json" }).end(
        JSON.stringify({
            jsonrpc: "2.0",
            error: { code, message },
            id: null,
        }),
    );
}

type RequestBodyResult =
    | { accepted: true; body: unknown }
    | { accepted: false };

async function readBoundedRequestBody(
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<RequestBodyResult> {
    const contentLength = req.headers["content-length"];
    if (contentLength !== undefined) {
        const requestBytes = Number(contentLength);
        if (
            !Number.isSafeInteger(requestBytes) ||
            requestBytes < 0 ||
            requestBytes > MCP_MAX_REQUEST_BYTES
        ) {
            req.resume();
            writeJsonRpcError(
                res,
                413,
                -32600,
                "Request body too large",
            );
            return { accepted: false };
        }
    }

    const chunks: Buffer[] = [];
    let requestBytes = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        requestBytes += buffer.length;
        if (requestBytes > MCP_MAX_REQUEST_BYTES) {
            req.resume();
            writeJsonRpcError(
                res,
                413,
                -32600,
                "Request body too large",
            );
            return { accepted: false };
        }
        chunks.push(buffer);
    }

    try {
        return {
            accepted: true,
            body: JSON.parse(Buffer.concat(chunks, requestBytes).toString()),
        };
    } catch {
        writeJsonRpcError(res, 400, -32700, "Parse error: Invalid JSON");
        return { accepted: false };
    }
}

export function writeMcpConfig() {
    const config = {
        mcpServers: {
            discord: {
                type: "http",
                url: `http://127.0.0.1:${MCP_PORT}/mcp`,
            },
        },
    };
    fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
    console.error(`[MCP] Config written to ${MCP_CONFIG_PATH}`);
}

export function startMcpHttpServer(): http.Server {
    const httpServer = http.createServer(async (req, res) => {
        const origin = req.headers.origin;
        if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) {
            res.writeHead(403, { "Content-Type": "application/json" }).end(
                JSON.stringify({
                    jsonrpc: "2.0",
                    error: {
                        code: -32000,
                        message: "Forbidden origin",
                    },
                    id: null,
                }),
            );
            return;
        }

        let url: URL;
        try {
            url = new URL(req.url || "/", `http://localhost:${MCP_PORT}`);
        } catch {
            res.writeHead(400, { "Content-Type": "application/json" }).end(
                JSON.stringify({
                    jsonrpc: "2.0",
                    error: {
                        code: -32600,
                        message: "Invalid request URL",
                    },
                    id: null,
                }),
            );
            return;
        }

        if (url.pathname !== "/mcp") {
            res.writeHead(404).end("Not found");
            return;
        }

        if (req.method === "POST") {
            let requestBody: RequestBodyResult;
            try {
                requestBody = await readBoundedRequestBody(req, res);
            } catch (error: any) {
                console.error(`[MCP HTTP] Error reading body: ${error.message}`);
                if (!res.headersSent && !res.destroyed) {
                    writeJsonRpcError(
                        res,
                        500,
                        -32603,
                        "Internal server error",
                    );
                }
                return;
            }
            if (!requestBody.accepted) return;

            const mcpServer = createMcpServer();
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
            });
            try {
                await mcpServer.connect(transport);
                await transport.handleRequest(req, res, requestBody.body);
            } catch (error: any) {
                console.error(`[MCP HTTP] Error: ${error.message}`);
                if (!res.headersSent) {
                    res.writeHead(500).end(
                        JSON.stringify({
                            jsonrpc: "2.0",
                            error: {
                                code: -32603,
                                message: "Internal server error",
                            },
                            id: null,
                        }),
                    );
                }
            } finally {
                await transport.close().catch(() => {});
                await mcpServer.close().catch(() => {});
            }
        } else if (req.method === "GET" || req.method === "DELETE") {
            res.writeHead(405, {
                Allow: "POST",
                "Content-Type": "application/json",
            }).end(
                JSON.stringify({
                    jsonrpc: "2.0",
                    error: {
                        code: -32000,
                        message: "Method not allowed (stateless mode)",
                    },
                    id: null,
                }),
            );
        } else {
            res.writeHead(405, { Allow: "POST" }).end();
        }
    });

    httpServer.listen(MCP_PORT, "127.0.0.1", () => {
        console.error(
            `[MCP HTTP] Streamable HTTP server listening on http://127.0.0.1:${MCP_PORT}/mcp`,
        );
    });

    return httpServer;
}
