import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "http";
import fs from "fs";
import { MCP_PORT, MCP_CONFIG_PATH } from "../config.js";
import { createMcpServer } from "./server.js";

export function writeMcpConfig() {
    const config = {
        mcpServers: {
            discord: {
                type: "http",
                url: `http://localhost:${MCP_PORT}/mcp`,
            },
        },
    };
    fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
    console.error(`[MCP] Config written to ${MCP_CONFIG_PATH}`);
}

export function startMcpHttpServer(): http.Server {
    const httpServer = http.createServer(async (req, res) => {
        const url = new URL(req.url || "/", `http://localhost:${MCP_PORT}`);
        if (url.pathname !== "/mcp") {
            res.writeHead(404).end("Not found");
            return;
        }

        if (req.method === "POST") {
            const mcpServer = createMcpServer();
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
            });
            try {
                await mcpServer.connect(transport);
                const chunks: Buffer[] = [];
                for await (const chunk of req) chunks.push(chunk as Buffer);
                const body = JSON.parse(Buffer.concat(chunks).toString());
                await transport.handleRequest(req, res, body);
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
            res.writeHead(405).end(
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
            res.writeHead(405).end();
        }
    });

    httpServer.listen(MCP_PORT, "127.0.0.1", () => {
        console.error(
            `[MCP HTTP] Streamable HTTP server listening on http://127.0.0.1:${MCP_PORT}/mcp`,
        );
    });

    return httpServer;
}
