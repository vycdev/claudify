import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const messagesDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudify-profile-display-"),
);
process.env.MESSAGES_DIR = messagesDir;

const { PROFILE_MAX_CHARS, PROFILES_DIR } = await import("../build/config.js");
const { handleProfile } = await import(
    "../build/discord/commands/profile.js"
);
const { handleGuild } = await import("../build/discord/commands/guild.js");

test.after(() => fs.rmSync(messagesDir, { recursive: true, force: true }));

function assertNoIsolatedSurrogates(text) {
    for (let index = 0; index < text.length; index++) {
        const codeUnit = text.charCodeAt(index);
        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
            const following = text.charCodeAt(index + 1);
            assert.ok(
                following >= 0xdc00 && following <= 0xdfff,
                "chunk ends with an isolated high surrogate",
            );
            index++;
        } else {
            assert.ok(
                codeUnit < 0xdc00 || codeUnit > 0xdfff,
                "chunk starts with an isolated low surrogate",
            );
        }
    }
}

function makeBoundaryContent(header) {
    return `${"x".repeat(1999 - header.length)}😀${"y".repeat(50)}`;
}

test("profile and server-memory displays preserve astral Unicode across chunks", async () => {
    const profileHeader = "**Profile for UnicodeUser:**\n";
    const profile = makeBoundaryContent(profileHeader);
    fs.writeFileSync(path.join(PROFILES_DIR, "user-1.txt"), profile, "utf8");

    const profileMessages = [];
    await handleProfile({
        mentions: { users: { first: () => undefined } },
        author: { id: "user-1", tag: "UnicodeUser" },
        reply: async (content) => profileMessages.push(content),
        channel: { send: async (content) => profileMessages.push(content) },
    });

    const guildHeader = "**Server memory for Unicode Guild:**\n";
    const memory = makeBoundaryContent(guildHeader);
    fs.writeFileSync(path.join(PROFILES_DIR, "server_guild-1.txt"), memory, "utf8");

    const guildMessages = [];
    await handleGuild({
        guild: { id: "guild-1", name: "Unicode Guild" },
        reply: async (content) => guildMessages.push(content),
        channel: { send: async (content) => guildMessages.push(content) },
    });

    for (const [messages, expected] of [
        [profileMessages, profileHeader + profile.slice(0, PROFILE_MAX_CHARS)],
        [guildMessages, guildHeader + memory],
    ]) {
        const contents = messages.map((message) =>
            typeof message === "string" ? message : message.content,
        );
        assert.ok(contents.length > 1);
        assert.ok(contents.every((content) => content.length <= 2000));
        contents.forEach(assertNoIsolatedSurrogates);
        assert.equal(contents.join(""), expected);
    }
});

test("server-memory displays disable Discord mention parsing", async () => {
    fs.writeFileSync(
        path.join(PROFILES_DIR, "server_guild-2.txt"),
        `A stored fact containing @everyone ${"x".repeat(2500)} <@123456789012345678> <@&234567890123456789>`,
        "utf8",
    );

    const messages = [];
    await handleGuild({
        guild: { id: "guild-2", name: "@everyone Guild" },
        reply: async (options) => messages.push(options),
        channel: { send: async (options) => messages.push(options) },
    });

    assert.ok(messages.length > 1);
    for (const message of messages) {
        assert.equal(typeof message.content, "string");
        assert.deepEqual(message.allowedMentions, { parse: [] });
    }
});

test("empty server-memory displays disable mentions in server names", async () => {
    const messages = [];
    await handleGuild({
        guild: { id: "guild-without-memory", name: "@here <@&234567890123456789> Guild" },
        reply: async (options) => messages.push(options),
        channel: { send: async (options) => messages.push(options) },
    });

    assert.equal(messages.length, 1);
    assert.match(messages[0].content, /^No server memory found for @here/);
    assert.deepEqual(messages[0].allowedMentions, { parse: [] });
});
