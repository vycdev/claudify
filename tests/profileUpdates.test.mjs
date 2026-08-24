import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const messagesDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudify-profile-updates-"),
);
process.env.MESSAGES_DIR = messagesDir;
process.env.CLAUDE_PROFILE_MODEL = "profile-test-model";
process.env.CLAUDE_PROFILE_EFFORT = "HIGH";
process.env.CLAUDE_SERVER_MEMORY_MODEL = "server-memory-test-model";
process.env.CLAUDE_SERVER_MEMORY_EFFORT = "medium";

const {
    backgroundProfileUpdate,
    backgroundServerMemoryUpdate,
    getServerMemory,
    getUserProfile,
} = await import("../build/storage/profiles.js");
const {
    getMemoryFacts,
    mergeMemoryFacts,
} = await import("../build/storage/memoryFacts.js");
const {
    MEMORY_FACT_MAX_CHARS,
    PROFILE_FACTS_DIR,
    PROFILES_DIR,
    SERVER_FACTS_DIR,
} = await import("../build/config.js");

test.after(() => fs.rmSync(messagesDir, { recursive: true, force: true }));

function deferred() {
    let resolve;
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function factOutput(facts) {
    return JSON.stringify({ facts });
}

test("serializes overlapping source-backed profile updates", async () => {
    const firstResult = deferred();
    const prompts = [];
    const options = [];
    const runner = async (_args, prompt, runOptions) => {
        prompts.push(prompt);
        options.push(runOptions);
        if (prompts.length === 1) return firstResult.promise;

        assert.match(prompt, /likes TypeScript/);
        assert.match(prompt, /source_message_id=msg-1/);
        return {
            stdout: factOutput([{
                userId: "user-1",
                text: "likes ESM",
                sourceMessageId: "msg-2",
                attribution: "explicit",
                supersedesFactIds: [],
            }]),
            stderr: "",
        };
    };

    const firstUpdate = backgroundProfileUpdate(
        [{ tag: "User", id: "user-1" }],
        "User [message_id=msg-1; author_id=user-1; author_bot=false; created_at=2026-08-24T00:00:00.000Z]: I like TypeScript",
        runner,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const secondUpdate = backgroundProfileUpdate(
        [{ tag: "User", id: "user-1" }],
        "User [message_id=msg-2; author_id=user-1; author_bot=false; created_at=2026-08-24T00:01:00.000Z]: I also like ESM",
        runner,
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(prompts.length, 1);
    firstResult.resolve({
        stdout: factOutput([{
            userId: "user-1",
            text: "likes TypeScript",
            sourceMessageId: "msg-1",
            attribution: "explicit",
            supersedesFactIds: [],
        }]),
        stderr: "",
    });
    await Promise.all([firstUpdate, secondUpdate]);

    const profile = getUserProfile("user-1");
    assert.match(profile, /likes TypeScript/);
    assert.match(profile, /likes ESM/);
    assert.match(profile, /source_message_id=msg-1/);
    assert.match(profile, /source_message_id=msg-2/);
    const facts = getMemoryFacts("user", "user-1");
    assert.equal(facts.length, 2);
    assert.equal(facts[0].observedAt, "2026-08-24T00:00:00.000Z");
    assert.equal(facts[1].observedAt, "2026-08-24T00:01:00.000Z");
    assert.deepEqual(options, Array.from({ length: 2 }, () => ({
        workload: "profile-update",
        model: "profile-test-model",
        effort: "high",
    })));
});

test("serializes source-backed server memory updates for the same guild", async () => {
    const firstResult = deferred();
    const prompts = [];
    const options = [];
    const runner = async (_args, prompt, runOptions) => {
        prompts.push(prompt);
        options.push(runOptions);
        if (prompts.length === 1) return firstResult.promise;

        assert.match(prompt, /weekly demos/);
        assert.match(prompt, /source_message_id=server-msg-1/);
        return {
            stdout: factOutput([{
                text: "weekly demos happen on Fridays",
                sourceMessageId: "server-msg-2",
                attribution: "explicit",
                supersedesFactIds: [],
            }]),
            stderr: "",
        };
    };

    const firstUpdate = backgroundServerMemoryUpdate(
        "guild-1",
        "Guild",
        "general",
        "User [message_id=server-msg-1; author_id=user-1; author_bot=false; created_at=2026-08-24T00:00:00.000Z]: The server has weekly demos",
        runner,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const secondUpdate = backgroundServerMemoryUpdate(
        "guild-1",
        "Guild",
        "general",
        "User [message_id=server-msg-2; author_id=user-1; author_bot=false; created_at=2026-08-24T00:01:00.000Z]: Demos happen on Fridays",
        runner,
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(prompts.length, 1);
    firstResult.resolve({
        stdout: factOutput([{
            text: "the server has weekly demos",
            sourceMessageId: "server-msg-1",
            attribution: "explicit",
            supersedesFactIds: [],
        }]),
        stderr: "",
    });
    await Promise.all([firstUpdate, secondUpdate]);

    const memory = getServerMemory("guild-1");
    assert.match(memory, /the server has weekly demos/);
    assert.match(memory, /weekly demos happen on Fridays/);
    assert.equal(getMemoryFacts("server", "guild-1").length, 2);
    assert.deepEqual(options, Array.from({ length: 2 }, () => ({
        workload: "server-memory-update",
        model: "server-memory-test-model",
        effort: "medium",
    })));
});

test("caps fact text without splitting astral Unicode", async () => {
    const prefix = "p".repeat(MEMORY_FACT_MAX_CHARS - 1);
    await backgroundProfileUpdate(
        [{ tag: "UnicodeUser", id: "unicode-user" }],
        "UnicodeUser [message_id=unicode-msg; author_id=unicode-user; author_bot=false; created_at=2026-08-24T00:00:00.000Z]: durable Unicode fact",
        async () => ({
            stdout: factOutput([{
                userId: "unicode-user",
                text: `${prefix}😀`,
                sourceMessageId: "unicode-msg",
                attribution: "explicit",
                supersedesFactIds: [],
            }]),
            stderr: "",
        }),
    );

    const [fact] = getMemoryFacts("user", "unicode-user");
    assert.equal(fact.text, prefix);
    assert.doesNotMatch(fact.text, /�/);
});

test("rejects invented and cross-attributed sources while preserving legacy memory", async () => {
    fs.writeFileSync(
        path.join(PROFILES_DIR, "legacy-user.txt"),
        "legacy profile remains",
        "utf8",
    );
    await backgroundProfileUpdate(
        [
            { tag: "Legacy", id: "legacy-user" },
            { tag: "Other", id: "other-user" },
        ],
        "Legacy [message_id=real-msg; author_id=legacy-user; author_bot=false; created_at=2026-08-24T00:00:00.000Z]: I maintain this project",
        async () => ({
            stdout: factOutput([
                {
                    userId: "legacy-user",
                    text: "invented provenance",
                    sourceMessageId: "invented-msg",
                    attribution: "explicit",
                    supersedesFactIds: [],
                },
                {
                    userId: "other-user",
                    text: "misattributed fact",
                    sourceMessageId: "real-msg",
                    attribution: "explicit",
                    supersedesFactIds: [],
                },
            ]),
            stderr: "",
        }),
    );

    assert.equal(getUserProfile("legacy-user"), "legacy profile remains");
    assert.equal(
        fs.readFileSync(path.join(PROFILES_DIR, "legacy-user.txt"), "utf8"),
        "legacy profile remains",
    );
    assert.equal(getMemoryFacts("user", "legacy-user").length, 0);
    assert.equal(getMemoryFacts("user", "other-user").length, 0);
    assert.equal(
        fs.existsSync(path.join(PROFILE_FACTS_DIR, "legacy-user.json")),
        false,
    );
    assert.equal(
        fs.existsSync(path.join(PROFILE_FACTS_DIR, "other-user.json")),
        false,
    );

    await backgroundProfileUpdate(
        [{ tag: "Legacy", id: "legacy-user" }],
        "Legacy [message_id=real-msg-2; author_id=legacy-user; author_bot=false; created_at=2026-08-24T01:00:00.000Z]: I maintain this project",
        async () => ({
            stdout: factOutput([{
                userId: "legacy-user",
                text: "maintains this project",
                sourceMessageId: "real-msg-2",
                attribution: "explicit",
                supersedesFactIds: [],
            }]),
            stderr: "",
        }),
    );
    assert.match(getUserProfile("legacy-user"), /maintains this project/);
    assert.match(getUserProfile("legacy-user"), /Legacy memory \(read-only\):/);
    assert.match(getUserProfile("legacy-user"), /legacy profile remains/);
    assert.equal(
        fs.readFileSync(path.join(PROFILES_DIR, "legacy-user.txt"), "utf8"),
        "legacy profile remains",
    );
});

test("rejects bot messages as server-memory sources", async () => {
    await backgroundServerMemoryUpdate(
        "bot-source-guild",
        "Guild",
        "general",
        "Claudify [message_id=bot-msg-1; author_id=bot-user; author_bot=true; created_at=2026-08-24T00:00:00.000Z]: invented server lore",
        async () => ({
            stdout: factOutput([{
                text: "invented server lore",
                sourceMessageId: "bot-msg-1",
                attribution: "explicit",
                supersedesFactIds: [],
            }]),
            stderr: "",
        }),
    );
    assert.equal(getMemoryFacts("server", "bot-source-guild").length, 0);
});

test("replaces contradicted facts only through explicit supersedes IDs", () => {
    mergeMemoryFacts(
        "server",
        "supersedes-guild",
        [{
            text: "demos happen on Thursdays",
            sourceMessageId: "change-msg-1",
            attribution: "explicit",
        }],
        new Set(["change-msg-1"]),
        new Map([["change-msg-1", "2026-08-24T00:00:00.000Z"]]),
    );
    const [oldFact] = getMemoryFacts("server", "supersedes-guild");

    mergeMemoryFacts(
        "server",
        "supersedes-guild",
        [{
            text: "demos happen on Fridays",
            sourceMessageId: "change-msg-2",
            attribution: "explicit",
            supersedesFactIds: [oldFact.id],
        }],
        new Set(["change-msg-2"]),
        new Map([["change-msg-2", "2026-08-24T01:00:00.000Z"]]),
    );

    const facts = getMemoryFacts("server", "supersedes-guild");
    assert.equal(facts.length, 1);
    assert.equal(facts[0].text, "demos happen on Fridays");
    assert.ok(fs.readdirSync(SERVER_FACTS_DIR).length >= 2);
});
