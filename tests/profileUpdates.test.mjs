import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const messagesDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudify-profile-updates-"),
);
process.env.MESSAGES_DIR = messagesDir;

const {
    backgroundProfileUpdate,
    backgroundServerMemoryUpdate,
    getServerMemory,
    getUserProfile,
} = await import("../build/storage/profiles.js");

test.after(() => fs.rmSync(messagesDir, { recursive: true, force: true }));

function deferred() {
    let resolve;
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

test("serializes overlapping profile updates before reading saved profiles", async () => {
    const firstResult = deferred();
    const prompts = [];
    const runner = async (_args, prompt) => {
        prompts.push(prompt);
        if (prompts.length === 1) return firstResult.promise;

        assert.match(prompt, /likes TypeScript/);
        return {
            stdout: "===PROFILE user-1===\nlikes TypeScript and ESM\n===END===",
            stderr: "",
        };
    };

    const firstUpdate = backgroundProfileUpdate(
        [{ tag: "User", id: "user-1" }],
        "User: I like TypeScript",
        runner,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const secondUpdate = backgroundProfileUpdate(
        [{ tag: "User", id: "user-1" }],
        "User: I also like ESM",
        runner,
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(prompts.length, 1);
    firstResult.resolve({
        stdout: "===PROFILE user-1===\nlikes TypeScript\n===END===",
        stderr: "",
    });
    await Promise.all([firstUpdate, secondUpdate]);

    assert.equal(getUserProfile("user-1"), "likes TypeScript and ESM");
});

test("serializes server memory updates for the same guild", async () => {
    const firstResult = deferred();
    const prompts = [];
    const runner = async (_args, prompt) => {
        prompts.push(prompt);
        if (prompts.length === 1) return firstResult.promise;

        assert.match(prompt, /weekly demos/);
        return { stdout: "weekly demos on Fridays", stderr: "" };
    };

    const firstUpdate = backgroundServerMemoryUpdate(
        "guild-1",
        "Guild",
        "general",
        "The server has weekly demos",
        runner,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const secondUpdate = backgroundServerMemoryUpdate(
        "guild-1",
        "Guild",
        "general",
        "Demos happen on Fridays",
        runner,
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(prompts.length, 1);
    firstResult.resolve({ stdout: "weekly demos", stderr: "" });
    await Promise.all([firstUpdate, secondUpdate]);

    assert.equal(getServerMemory("guild-1"), "weekly demos on Fridays");
});