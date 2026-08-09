import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";

async function reservePort() {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const port = address.port;

    await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
    return port;
}

function sendRequest(port, requestPath, method = "GET") {
    return new Promise((resolve, reject) => {
        const request = http.request(
            {
                host: "127.0.0.1",
                port,
                method,
                path: requestPath,
            },
            (response) => {
                let body = "";
                response.setEncoding("utf8");
                response.on("data", (chunk) => {
                    body += chunk;
                });
                response.on("end", () =>
                    resolve({
                        statusCode: response.statusCode,
                        allow: response.headers.allow,
                        contentType: response.headers["content-type"],
                        body,
                    }),
                );
            },
        );
        request.setTimeout(2_000, () => {
            request.destroy(new Error("Timed out waiting for HTTP response"));
        });
        request.on("error", reject);
        request.end();
    });
}

test("MCP HTTP server rejects invalid URLs and unsupported methods", async (t) => {
    const messagesDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-mcp-http-"),
    );
    const port = await reservePort();
    const previousMessagesDir = process.env.MESSAGES_DIR;
    const previousMcpPort = process.env.MCP_PORT;
    process.env.MESSAGES_DIR = messagesDir;
    process.env.MCP_PORT = String(port);

    const { startMcpHttpServer } = await import("../build/mcp/http.js");
    const server = startMcpHttpServer();
    t.after(async () => {
        await new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
        fs.rmSync(messagesDir, { recursive: true, force: true });
        if (previousMessagesDir === undefined) delete process.env.MESSAGES_DIR;
        else process.env.MESSAGES_DIR = previousMessagesDir;
        if (previousMcpPort === undefined) delete process.env.MCP_PORT;
        else process.env.MCP_PORT = previousMcpPort;
    });
    await once(server, "listening");

    const malformedResponse = await sendRequest(port, "http://[");
    assert.equal(malformedResponse.statusCode, 400);
    assert.equal(malformedResponse.contentType, "application/json");
    assert.deepEqual(JSON.parse(malformedResponse.body), {
        jsonrpc: "2.0",
        error: {
            code: -32600,
            message: "Invalid request URL",
        },
        id: null,
    });

    const followUpResponse = await sendRequest(port, "/not-mcp");
    assert.equal(followUpResponse.statusCode, 404);

    const getResponse = await sendRequest(port, "/mcp");
    assert.equal(getResponse.statusCode, 405);
    assert.equal(getResponse.allow, "POST");
    assert.equal(getResponse.contentType, "application/json");
    assert.equal(
        JSON.parse(getResponse.body).error.message,
        "Method not allowed (stateless mode)",
    );

    const putResponse = await sendRequest(port, "/mcp", "PUT");
    assert.equal(putResponse.statusCode, 405);
    assert.equal(putResponse.allow, "POST");
});
