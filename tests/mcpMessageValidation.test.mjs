import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("MCP send-message enforces Discord's content length limits", async (t) => {
    const messagesDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-mcp-message-validation-"),
    );
    t.after(() => fs.rmSync(messagesDir, { recursive: true, force: true }));
    process.env.MESSAGES_DIR = messagesDir;

    const { DISCORD_MESSAGE_MAX_CHARS } = await import("../build/config.js");
    const { createMcpServer, SendMessageSchema } = await import(
        "../build/mcp/server.js"
    );
    const validInput = {
        channel: "general",
        message: "😀".repeat(DISCORD_MESSAGE_MAX_CHARS),
    };

    assert.deepEqual(SendMessageSchema.parse(validInput), validInput);
    assert.throws(
        () => SendMessageSchema.parse({ channel: "general", message: "" }),
        /at least 1 character/,
    );
    for (const message of [
        "x".repeat(DISCORD_MESSAGE_MAX_CHARS + 1),
        "😀".repeat(DISCORD_MESSAGE_MAX_CHARS + 1),
    ]) {
        assert.throws(
            () => SendMessageSchema.parse({ channel: "general", message }),
            /at most 2000 character/,
        );
    }

    const server = createMcpServer();
    t.after(() => server.close().catch(() => {}));
    const listToolsHandler = server._requestHandlers.get("tools/list");
    const callToolHandler = server._requestHandlers.get("tools/call");
    assert.ok(listToolsHandler);
    assert.ok(callToolHandler);

    const { tools } = await listToolsHandler(
        { method: "tools/list", params: {} },
        {},
    );
    const sendMessageTool = tools.find(({ name }) => name === "send-message");
    assert.deepEqual(sendMessageTool.inputSchema.properties.message, {
        type: "string",
        description: "Message content to send",
        minLength: 1,
        maxLength: DISCORD_MESSAGE_MAX_CHARS,
    });

    await assert.rejects(
        () =>
            callToolHandler(
                {
                    method: "tools/call",
                    params: {
                        name: "send-message",
                        arguments: {
                            channel: "general",
                            message: "x".repeat(DISCORD_MESSAGE_MAX_CHARS + 1),
                        },
                    },
                },
                {},
            ),
        /Invalid arguments: message: String must contain at most 2000 character/,
    );
});

test("MCP react-to-message rejects empty emoji", async (t) => {
    const { createMcpServer } = await import("../build/mcp/server.js");
    const server = createMcpServer();
    t.after(() => server.close().catch(() => {}));
    const listToolsHandler = server._requestHandlers.get("tools/list");
    const callToolHandler = server._requestHandlers.get("tools/call");
    assert.ok(listToolsHandler);
    assert.ok(callToolHandler);

    const { tools } = await listToolsHandler(
        { method: "tools/list", params: {} },
        {},
    );
    const reactToMessageTool = tools.find(
        ({ name }) => name === "react-to-message",
    );
    assert.equal(
        reactToMessageTool.inputSchema.properties.emoji.minLength,
        1,
    );

    for (const emoji of ["", " \t\n "]) {
        await assert.rejects(
            () =>
                callToolHandler(
                    {
                        method: "tools/call",
                        params: {
                            name: "react-to-message",
                            arguments: {
                                channel: "general",
                                messageId: "123",
                                emoji,
                            },
                        },
                    },
                    {},
                ),
            /Invalid arguments: emoji: Emoji must not be empty/,
        );
    }
});