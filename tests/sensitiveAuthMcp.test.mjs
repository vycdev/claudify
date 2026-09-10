import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test, { after, mock } from "node:test";
import { Embed, TextChannel } from "discord.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

if (!process.execArgv.includes("--experimental-test-module-mocks")) {
    test("sensitive auth MCP regression subprocess", (t) => {
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, [
            "--experimental-test-module-mocks", "--test", fileURLToPath(import.meta.url),
        ], { encoding: "utf8", timeout: 30000, env });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /^# tests [1-9]\d*$/m, "nested regression suite must actually execute");
        t.diagnostic(result.stdout);
    });
} else {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sensitive-auth-mcp-"));
    process.env.MESSAGES_DIR = path.join(root, "messages");
    process.env.CODEX_HOME = path.join(root, "codex");
    const downloads = [];
    let waitDownload, signalDownload;
    mock.module(new URL("../build/storage/images.js", import.meta.url), { namedExports: {
        downloadAttachment: async (url, filename) => {
            downloads.push({ url, filename });
            signalDownload?.();
            if (waitDownload) await waitDownload;
            const file = path.join(root, filename);
            fs.writeFileSync(file, "offline image fixture");
            return file;
        },
    } });
    const { client: discord } = await import("../build/discord/client.js");
    const { createMcpServer } = await import("../build/mcp/server.js");
    const guild = { id: "111111111111111111", name: "Offline Guild" };
    const channel = Object.create(TextChannel.prototype);
    let messages = [];
    Object.defineProperties(channel, {
        id: { value: "222222222222222222" }, name: { value: "offline" }, guild: { value: guild },
        messages: { value: { fetch: async (query) => typeof query === "string"
            ? messages.find((msg) => msg.id === query)
            : new Map(messages.map((msg) => [msg.id, msg]).reverse()) } },
    });
    mock.method(discord.guilds, "fetch", async () => guild);
    mock.method(discord.channels, "fetch", async () => channel);
    after(() => { mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); });
    function message(id, content, marker) {
        return {
            id, content, author: { tag: "OfflineUser" }, createdAt: new Date("2026-09-10T00:00:00Z"),
            attachments: new Map([
                ["image", { id: `${marker}-image`, name: `${marker}.png`, contentType: "image/png", size: 42,
                    url: `https://example.invalid/${marker}.png` }],
                ["document", { id: `${marker}-doc`, name: `${marker}.txt`, contentType: "text/plain", size: 42,
                    url: `https://example.invalid/${marker}.txt` }],
            ]),
            embeds: [{ title: `${marker}_EMBED`, description: `${marker}_DESCRIPTION`, url: `https://example.invalid/${marker}` }],
        };
    }
    test("MCP message snapshot excludes auth embeds introduced during image download", async () => {
        downloads.length = 0;
        messages = [message("333333333333333331", "ordinary nonsecret message", "ordinary")];
        let release;
        const reached = new Promise((resolve) => { signalDownload = resolve; });
        waitDownload = new Promise((resolve) => { release = resolve; });
        const server = createMcpServer();
        const client = new Client({ name: "offline-test", version: "1.0.0" });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await server.connect(st);
        await client.connect(ct);
        try {
            const response = client.callTool({ name: "fetch-messages", arguments: {
                links: [`https://discord.com/channels/${guild.id}/${channel.id}/${messages[0].id}`],
            } });
            await reached;
            messages[0].content = "!codex auth login SYNTHETIC_EDITED_COMMAND";
            messages[0].embeds = [{ title: "SYNTHETIC_EDITED_AUTH_EMBED", description: "SYNTHETIC_AUTH_SECRET" }];
            release();
            const result = await response;
            assert.doesNotMatch(result.content[0].text, /SYNTHETIC_/);
            assert.match(result.content[0].text, /ordinary nonsecret message/);
            assert.match(result.content[0].text, /ordinary_EMBED/);
            assert.match(result.content[0].text, /ordinary\.png/);
            assert.equal(downloads.length, 1);
        } finally {
            release();
            waitDownload = undefined;
            signalDownload = undefined;
            await Promise.all([client.close(), server.close()]);
        }
    });

    for (const tool of ["read-messages", "fetch-messages"]) {
        test(`${tool} snapshots in-place embed data and all attachment entries before download`, async () => {
            downloads.length = 0;
            const first = message("333333333333333331", "ordinary content", "ordinary-first");
            first.embeds = [new Embed({ title: "ordinary title", description: "ordinary description" })];
            first.attachments.get("document").contentType = "image/png";
            messages = [first];
            let release;
            const reached = new Promise((resolve) => { signalDownload = resolve; });
            waitDownload = new Promise((resolve) => { release = resolve; });
            const server = createMcpServer();
            const handler = server._requestHandlers.get("tools/call");
            try {
                const response = handler({ method: "tools/call", params: { name: tool, arguments: tool === "read-messages"
                    ? { server: guild.id, channel: channel.id, limit: 10 }
                    : { links: [`https://discord.com/channels/${guild.id}/${channel.id}/${first.id}`] } } }, {});
                await reached;
                first.content = "!auth code SYNTHETIC_SECRET";
                first.embeds[0].data.description = "SYNTHETIC_EMBED";
                first.attachments.get("document").url = "https://example.invalid/SYNTHETIC_URL";
                first.attachments.get("document").name = "SYNTHETIC_NAME.png";
                first.attachments.set("new-image", { id: "SYNTHETIC_ID", contentType: "image/png",
                    name: "SYNTHETIC_NEW.png", url: "https://example.invalid/SYNTHETIC_NEW" });
                release();
                const result = await response;
                assert.doesNotMatch(JSON.stringify({ result, downloads }), /SYNTHETIC_/);
                assert.equal(downloads.length, 2);
                assert.match(downloads[1].url, /ordinary-first\.txt/);
                if (tool === "fetch-messages") assert.match(result.content[0].text, /ordinary description/);
            } finally {
                release(); waitDownload = undefined; signalDownload = undefined;
                await server.close();
            }
        });
    }

    test("read-messages snapshots the whole fetched batch before the first download", async () => {
        downloads.length = 0;
        const first = message("333333333333333331", "ordinary first", "ordinary-first");
        const later = message("333333333333333332", "ordinary later", "ordinary-later");
        messages = [first, later];
        let release;
        const reached = new Promise((resolve) => { signalDownload = resolve; });
        waitDownload = new Promise((resolve) => { release = resolve; });
        const server = createMcpServer();
        try {
            const response = server._requestHandlers.get("tools/call")({ method: "tools/call", params: {
                name: "read-messages", arguments: { server: guild.id, channel: channel.id, limit: 10 },
            } }, {});
            await reached;
            later.content = "!auth code SYNTHETIC_SECRET";
            later.attachments.get("image").url = "https://example.invalid/SYNTHETIC_URL";
            release();
            const result = await response;
            assert.doesNotMatch(JSON.stringify({ result, downloads }), /SYNTHETIC_/);
            assert.match(result.content[0].text, /ordinary later/);
            assert.equal(downloads.length, 2);
        } finally {
            release(); waitDownload = undefined; signalDownload = undefined;
            await server.close();
        }
    });

    for (const tool of ["read-messages", "fetch-messages"]) {
        for (const command of ["!codex auth login", " \t!CoDeX\nunknown", "!AUTH code", "!codex usage"]) {
            test(`${tool} excludes sensitive text, attachments and embeds: ${JSON.stringify(command)}`, async () => {
                downloads.length = 0;
                messages = [message("333333333333333331", `${command} SYNTHETIC_SECRET`, "SYNTHETIC_SECRET"),
                    message("333333333333333332", "!authentic ordinary message", "ordinary")];
                const server = createMcpServer();
                const client = new Client({ name: "offline-test", version: "1.0.0" });
                const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
                await server.connect(serverTransport);
                await client.connect(clientTransport);
                try {
                    const response = await client.callTool({ name: tool, arguments: tool === "read-messages"
                        ? { server: guild.id, channel: channel.id, limit: 10 }
                        : { links: messages.map((msg) => `https://discord.com/channels/${guild.id}/${channel.id}/${msg.id}`) } });
                    const text = response.content[0].text;
                    assert.doesNotMatch(text, /SYNTHETIC_SECRET/);
                    assert.match(text, /!authentic ordinary message/);
                    assert.match(text, /ordinary\.png/);
                    assert.equal(downloads.length, 1);
                    assert.match(downloads[0].filename, /ordinary/);
                    assert.ok(!fs.readdirSync(root).some((name) => name.includes("SYNTHETIC_SECRET")));
                    if (tool === "read-messages") {
                        assert.match(text, /ordinary\.txt/);
                        assert.doesNotMatch(text, /333333333333333331/);
                    } else {
                        assert.match(text, /ordinary_EMBED/);
                        assert.match(text, /Sensitive authentication message omitted/);
                    }
                } finally {
                    await Promise.all([client.close(), server.close()]);
                }
            });
        }
    }
}
