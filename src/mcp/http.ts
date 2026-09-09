import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "http";
import fs from "fs";
import { randomUUID } from "crypto";
import {
    MCP_MAX_REQUEST_BYTES,
    MCP_PORT,
    MCP_CONFIG_PATH,
    MORPHEUS_MCP_API_KEY,
    MORPHEUS_MCP_URL,
} from "../config.js";
import { createMcpServer } from "./server.js";

const NO_FOLLOW_FLAG =
    typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;

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
    const mcpServers: Record<string, {
        type: "http";
        url: string;
        headers?: Record<string, string>;
    }> = {
        discord: {
            type: "http",
            url: `http://127.0.0.1:${MCP_PORT}/mcp`,
        },
    };
    if (MORPHEUS_MCP_URL && MORPHEUS_MCP_API_KEY) {
        mcpServers.morpheus = {
            type: "http",
            url: MORPHEUS_MCP_URL,
            headers: {
                Authorization: `Bearer ${MORPHEUS_MCP_API_KEY}`,
            },
        };
    }
    const config = {
        mcpServers,
    };
    try {
        const existing = fs.lstatSync(MCP_CONFIG_PATH);
        if (!existing.isFile() || existing.isSymbolicLink()) {
            throw new Error("MCP config path must be a regular file, not a symbolic link");
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    }

    // Never truncate or write through the destination itself. An exclusive
    // sibling plus rename also protects platforms without O_NOFOLLOW and
    // preserves existing data if writing the new configuration fails.
    const temporaryPath = `${MCP_CONFIG_PATH}.tmp-${process.pid}-${randomUUID()}`;
    let fileDescriptor: number | undefined;
    let created = false;
    try {
        fileDescriptor = fs.openSync(
            temporaryPath,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW_FLAG,
            0o600,
        );
        created = true;
        fs.fchmodSync(fileDescriptor, 0o600);
        fs.writeFileSync(
            fileDescriptor,
            JSON.stringify(config, null, 2),
            "utf-8",
        );
        fs.fsyncSync(fileDescriptor);
        fs.closeSync(fileDescriptor);
        fileDescriptor = undefined;
        fs.renameSync(temporaryPath, MCP_CONFIG_PATH);
        created = false;
    } finally {
        try {
            if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
        } finally {
            if (created) fs.rmSync(temporaryPath, { force: true });
        }
    }
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
