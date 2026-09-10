import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test, { after, beforeEach, mock } from "node:test";
import { TextChannel } from "discord.js";

// Keep the production module graph intact except for model/network/background
// side effects. The child flag also supports direct unflagged node --test calls.
if (!process.execArgv.includes("--experimental-test-module-mocks")) {
    test("sensitive auth handler regression subprocess", (t) => {
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sensitive-auth-handler-"));
    process.env.MESSAGES_DIR = path.join(root, "messages");
    process.env.CODEX_HOME = path.join(root, "codex");
    process.env.AUTH_ADMIN_USER_IDS = "";
    process.env.REQUIRED_ROLE_ID = "";
    process.env.COOLDOWN_MS = "0";
    const calls = { models: [], downloads: [], memories: [], pending: [], logs: [] };
    let holdModel;
    let modelStarted;
    const storedFiles = (dir = process.env.MESSAGES_DIR) => fs.readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) => entry.isDirectory() ? storedFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
    mock.module(new URL("../build/askClaude.js", import.meta.url), { namedExports: {
        askClaude: async (...args) => {
            calls.models.push(args);
            modelStarted?.();
            calls.pending.push(storedFiles().map((file) => fs.readFileSync(file, "utf8")).join("\n"));
            if (holdModel) await holdModel;
            return "Offline test response";
        },
    } });
    mock.module(new URL("../build/storage/images.js", import.meta.url), { namedExports: {
        downloadAttachment: async (...args) => { calls.downloads.push(args); return path.join(root, args[1]); },
    } });
    mock.module(new URL("../build/storage/memoryBatcher.js", import.meta.url), { namedExports: {
        queueBackgroundMemoryUpdate: (input) => calls.memories.push(input),
    } });
    mock.module(new URL("../build/storage/summaries.js", import.meta.url), { namedExports: {
        ensureYesterdaySummaries: async () => {}, getSummaryPath: () => "", loadRecentSummaries: () => "",
    } });
    const { client } = await import("../build/discord/client.js");
    const { registerHandler, buildReactionQuestion } = await import("../build/discord/handler.js");
    client.user = { id: "bot", username: "OfflineBot" };
    registerHandler();
    const onMessage = client.listeners("messageCreate").at(-1);
    const onReaction = client.listeners("messageReactionAdd").at(-1);
    mock.method(console, "error", (...args) => calls.logs.push(args.join(" ")));
    after(() => { mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); });
    beforeEach(() => {
        holdModel = undefined;
        modelStarted = undefined;
        for (const values of Object.values(calls)) values.length = 0;
        for (const file of storedFiles()) fs.unlinkSync(file);
    });

    let sequence = 0;
    function fixture(content, { reference, attachments = true, live = [] } = {}) {
        const guild = { id: "111111111111111111", name: "Offline Guild" };
        const channel = Object.create(TextChannel.prototype);
        Object.defineProperties(channel, {
            id: { value: "222222222222222222" }, name: { value: "offline" }, guild: { value: guild },
            messages: { value: { fetch: async (query) => typeof query === "string"
                ? [reference, ...live].find((msg) => msg?.id === query) ?? null
                : new Map(live.map((msg) => [msg.id, msg])) } },
            sendTyping: { value: async () => {} }, send: { value: async () => {} },
        });
        const id = String(++sequence);
        return {
            id, content, channel, channelId: channel.id, guild, guildId: guild.id,
            createdAt: new Date("2026-09-10T00:02:00Z"), createdTimestamp: Date.parse("2026-09-10T00:02:00Z"),
            author: { id: `user-${id}`, bot: false, username: "User", tag: "User" },
            mentions: { has: () => true }, reference: reference ? { messageId: reference.id } : undefined,
            attachments: new Map(attachments ? [["image", { id: "image", name: "SYNTHETIC_IMAGE.png",
                url: "https://example.invalid/SYNTHETIC_IMAGE.png", size: 42, contentType: "image/png" }]] : []),
            embeds: attachments ? [{ title: "SYNTHETIC_EMBED", description: "SYNTHETIC_SECRET" }] : [],
            reply: async () => {}, react: async () => {},
        };
    }
    const assertNoSecret = () => {
        assert.doesNotMatch(JSON.stringify(calls), /SYNTHETIC_/);
        for (const file of storedFiles()) assert.doesNotMatch(fs.readFileSync(file, "utf8"), /SYNTHETIC_/);
    };

    for (const command of ["!codex auth login SYNTHETIC_SECRET", "!AUTH code SYNTHETIC_SECRET"]) {
        test(`guild rejection never reaches storage or model: ${command.split(" ")[0]}`, async () => {
            await onMessage(fixture(command));
            assert.equal(calls.models.length, 0);
            assert.equal(calls.downloads.length, 0);
            assert.deepEqual(storedFiles(), []);
            assertNoSecret();
        });
        test(`sensitive reaction target stops before downloads, model and persistence: ${command.split(" ")[0]}`, async () => {
            const msg = fixture(command);
            await onReaction({ message: msg, emoji: { name: "🤖" } }, { id: `reactor-${msg.id}`, username: "Reactor", bot: false });
            assert.equal(calls.models.length, 0);
            assert.equal(calls.downloads.length, 0);
            assert.deepEqual(storedFiles(), []);
            assertNoSecret();
            assert.doesNotMatch(buildReactionQuestion("User", "Reactor", msg), /SYNTHETIC_|attachment\(s\)/);
        });
        test(`reply to sensitive message keeps only current turn: ${command.split(" ")[0]}`, async () => {
            const secret = fixture(command);
            const current = fixture("!ask explain this safely", { reference: secret, attachments: false, live: [secret] });
            await onMessage(current);
            assert.equal(calls.models.length, 1);
            assert.equal(calls.downloads.length, 0);
            assert.equal(calls.models[0][9].replyTarget, undefined);
            assert.equal(calls.models[0][9].replyChain, undefined);
            assert.equal(calls.models[0][0], "explain this safely");
            assertNoSecret();
        });
    }

    test("partial sensitive reaction target is checked after hydration", async () => {
        const msg = fixture("");
        msg.partial = true;
        msg.fetch = async () => { msg.content = "!codex auth login SYNTHETIC_SECRET"; msg.partial = false; };
        const reaction = { partial: true, message: msg, emoji: { name: "🤖" }, fetch: async () => {} };
        await onReaction(reaction, { id: `reactor-${msg.id}`, username: "Reactor", bot: false });
        assert.equal(calls.models.length, 0);
        assert.equal(calls.downloads.length, 0);
        assert.deepEqual(storedFiles(), []);
        assertNoSecret();
    });

    test("queued messages are rechecked before logging, pending persistence or downloads", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        let release;
        holdModel = new Promise((resolve) => { release = resolve; });
        const started = new Promise((resolve) => { modelStarted = resolve; });
        const first = fixture("!ask ordinary first turn", { attachments: false });
        const running = onMessage(first);
        await started;
        const queued = fixture("!ask ordinary queued turn", { attachments: false });
        queued.author = first.author;
        await onMessage(queued);
        // Discord's cached Message can change while it waits in the per-user queue.
        const secret = fixture("!codex auth login SYNTHETIC_SECRET");
        queued.content = secret.content;
        queued.attachments = secret.attachments;
        queued.embeds = secret.embeds;
        release();
        await running;
        t.mock.timers.tick(100);
        await new Promise(setImmediate);
        assert.equal(calls.models.length, 1);
        assert.equal(calls.downloads.length, 0);
        assertNoSecret();
    });

    test("sensitive-only live participants cannot enter background memory batches", async () => {
        const secret = fixture("!codex auth login SYNTHETIC_SECRET");
        const current = fixture("!ask find the article I sent earlier", { attachments: false, live: [secret] });
        await onMessage(current);
        assert.equal(calls.models.length, 1);
        assert.equal(calls.memories.length, 1);
        assert.deepEqual(calls.memories[0].users.map((user) => user.id), [current.author.id]);
        assertNoSecret();
    });

    test("ordinary direct replies preserve content, embeds and image downloads", async () => {
        const target = fixture("!authentic ordinary target");
        const current = fixture("!ask explain this", { reference: target, attachments: false });
        await onMessage(current);
        assert.equal(calls.models.length, 1);
        assert.equal(calls.downloads.length, 1);
        assert.match(calls.models[0][9].replyTarget.content, /!authentic ordinary target.*\n\[Embeds\]/);
        assert.match(calls.models[0][9].replyTarget.content, /SYNTHETIC_EMBED/);
        assert.equal(calls.models[0][9].replyTarget.messageId, target.id);
        assert.equal(calls.models[0][7].length, 1);
    });

    // Reviewer edit-during-await probes, inverted to require non-exposure.
    test("direct reply snapshot survives an auth edit during ancestor fetch", async () => {
        const older = fixture("ordinary older ancestor", { attachments: false });
        const direct = fixture("ordinary direct target", { reference: older, attachments: false });
        const current = fixture("!ask ordinary question", { reference: direct, attachments: false });
        let release, reached;
        const blocked = new Promise((resolve) => { reached = resolve; });
        current.channel.messages.fetch = async (query) => {
            if (typeof query !== "string") return new Map();
            if (query === direct.id) return direct;
            if (query === older.id) {
                reached();
                return new Promise((resolve) => { release = () => resolve(older); });
            }
            return null;
        };
        const running = onMessage(current);
        await blocked;
        const edited = fixture("!codex auth login SYNTHETIC_EDITED_DIRECT");
        direct.content = edited.content;
        direct.attachments = edited.attachments;
        direct.embeds = edited.embeds;
        release();
        await running;
        assert.equal(calls.models.length, 1);
        assertNoSecret();
        assert.equal(calls.models[0][9].replyTarget.content, "ordinary direct target");
        assert.equal(calls.downloads.length, 0);
    });

    test("current message snapshot survives an auth edit during reference fetch", async () => {
        const reference = fixture("ordinary reference", { attachments: false });
        const current = fixture("!ask ordinary question", { reference, attachments: false });
        let count = 0, release, reached;
        const blocked = new Promise((resolve) => { reached = resolve; });
        current.channel.messages.fetch = async (query) => {
            if (typeof query !== "string") return new Map();
            // First fetch is trigger detection; second is inside processMessage.
            if (++count === 1) return reference;
            reached();
            return new Promise((resolve) => { release = () => resolve(reference); });
        };
        const running = onMessage(current);
        await blocked;
        const edited = fixture("!codex auth login SYNTHETIC_EDITED_CURRENT");
        current.content = edited.content;
        current.attachments = edited.attachments;
        current.embeds = edited.embeds;
        current.reference.messageId = "SYNTHETIC_EDITED_REFERENCE";
        release();
        await running;
        assert.equal(calls.models.length, 1);
        assertNoSecret();
        assert.equal(calls.models[0][9].messageContent, "!ask ordinary question");
        assert.equal(calls.models[0][9].replyToMessageId, reference.id);
        assert.match(calls.pending.join("\n"), /!ask ordinary question/);
        assert.equal(calls.downloads.length, 0);
    });

    test("reaction snapshot survives an auth edit during live context fetch", async () => {
        const msg = fixture("ordinary reaction target", { attachments: false });
        let reached, release;
        const blocked = new Promise((resolve) => { reached = resolve; });
        msg.channel.messages.fetch = async () => {
            reached();
            return new Promise((resolve) => { release = () => resolve(new Map()); });
        };
        const running = onReaction({ message: msg, emoji: { name: "🤖" } }, { id: `reactor-${msg.id}`, username: "Reactor", bot: false });
        await blocked;
        const edited = fixture("!codex auth login SYNTHETIC_EDITED_REACTION");
        msg.content = edited.content;
        msg.attachments = edited.attachments;
        msg.embeds = edited.embeds;
        release();
        await running;
        assert.equal(calls.models.length, 1);
        assertNoSecret();
        assert.equal(calls.downloads.length, 0);
        assert.deepEqual(calls.models[0][7], []);
        assert.match(calls.models[0][0], /ordinary reaction target/);
    });

    test("live context snapshots each fetched batch before fetching the next", async () => {
        const live = Array.from({ length: 100 }, (_, index) =>
            fixture(`ordinary live ${index}`, { attachments: false }));
        const current = fixture("!ask give me a recap", { attachments: false });
        let fetched = 0, release, reached;
        const blocked = new Promise((resolve) => { reached = resolve; });
        current.channel.messages.fetch = async () => {
            if (++fetched === 1) return new Map(live.map((msg) => [msg.id, msg]));
            reached();
            return new Promise((resolve) => { release = () => resolve(new Map()); });
        };
        const running = onMessage(current);
        await blocked;
        live[0].content = "!codex auth login SYNTHETIC_SECRET";
        release();
        await running;
        assert.equal(calls.models.length, 1);
        assertNoSecret();
        assert.match(calls.models[0][8], /ordinary live 0\n/);
        assert.equal(fetched, 2);
    });

    test("ordinary reactions still run the model and persist their response", async () => {
        const msg = fixture("!codexish ordinary reaction");
        await onReaction({ message: msg, emoji: { name: "🤖" } }, { id: `reactor-${msg.id}`, username: "Reactor", bot: false });
        assert.equal(calls.models.length, 1);
        assert.equal(calls.downloads.length, 1);
        assert.match(calls.models[0][0], /!codexish ordinary reaction/);
        assert.ok(storedFiles().some((file) => fs.readFileSync(file, "utf8").includes("Offline test response")));
    });
}
