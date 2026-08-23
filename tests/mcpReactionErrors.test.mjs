import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TextChannel } from "discord.js";

const messagesDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudify-mcp-reaction-errors-"),
);
const previousMessagesDir = process.env.MESSAGES_DIR;
process.env.MESSAGES_DIR = messagesDir;
const [{ client: discordClient }, { createMcpServer }] = await Promise.all([
    import("../build/discord/client.js"),
    import("../build/mcp/server.js"),
]);
if (previousMessagesDir === undefined) {
    delete process.env.MESSAGES_DIR;
} else {
    process.env.MESSAGES_DIR = previousMessagesDir;
}

test.after(() => fs.rmSync(messagesDir, { recursive: true, force: true }));

test("react-to-message preserves Discord reaction failures", async (t) => {
    const reactionError = new Error("Missing Permissions");
    const guild = {
        id: "111111111111111111",
        name: "Test Server",
        emojis: { cache: { find: () => undefined } },
    };
    const channel = Object.create(TextChannel.prototype);
    Object.defineProperties(channel, {
        name: { value: "general" },
        guild: { value: guild },
        messages: {
            value: {
                fetch: async () => ({
                    react: async () => {
                        throw reactionError;
                    },
                }),
            },
        },
    });

    const originalGuildFetch = discordClient.guilds.fetch;
    const originalChannelFetch = discordClient.channels.fetch;
    discordClient.guilds.fetch = async () => guild;
    discordClient.channels.fetch = async () => channel;
    t.after(() => {
        discordClient.guilds.fetch = originalGuildFetch;
        discordClient.channels.fetch = originalChannelFetch;
    });

    const server = createMcpServer();
    t.after(() => server.close().catch(() => {}));
    const callToolHandler = server._requestHandlers.get("tools/call");
    assert.ok(callToolHandler);

    await assert.rejects(
        () =>
            callToolHandler(
                {
                    method: "tools/call",
                    params: {
                        name: "react-to-message",
                        arguments: {
                            server: guild.id,
                            channel: "222222222222222222",
                            messageId: "333333333333333333",
                            emoji: "👍",
                        },
                    },
                },
                {},
            ),
        (error) => error === reactionError,
    );
});
