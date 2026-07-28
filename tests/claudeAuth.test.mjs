import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    ClaudeAuthManager,
    extractClaudeLoginUrl,
    parseClaudeAuthStatus,
} from "../build/claudeAuth.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

test("parses only non-sensitive Claude auth status fields", () => {
    const status = parseClaudeAuthStatus(
        JSON.stringify({
            loggedIn: true,
            authMethod: "claude.ai",
            apiProvider: "firstParty",
            email: "private@example.com",
            token: "secret",
        }),
        0,
    );

    assert.deepEqual(status, {
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
    });
    assert.equal("email" in status, false);
    assert.equal("token" in status, false);
});

test("extracts an OAuth URL across ANSI-decorated output", () => {
    const output =
        "\u001b[32mOpen https://claude.ai/oauth/authorize?code=test\u001b[0m\n";
    assert.equal(
        extractClaudeLoginUrl(output),
        "https://claude.ai/oauth/authorize?code=test",
    );
});

test("runs a private login session and verifies its final status", async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-auth-"));
    const markerPath = path.join(tempDir, "authenticated");
    const fakeCliPath = path.join(tempDir, "fake-claude.mjs");
    const fixturePath = path.join(currentDir, "fixtures", "fakeClaudeAuth.mjs");
    fs.copyFileSync(fixturePath, fakeCliPath);
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    const manager = new ClaudeAuthManager({
        command: process.execPath,
        prefixArgs: [fakeCliPath],
        commandTimeoutMs: 2_000,
        loginTimeoutMs: 2_000,
        env: {
            ...process.env,
            CLAUDIFY_AUTH_TEST_MARKER: markerPath,
        },
    });

    assert.deepEqual(await manager.getStatus(), { loggedIn: false });
    const loginUrl = await manager.startLogin("owner");
    assert.equal(loginUrl, "https://claude.ai/oauth/authorize?test=1");
    await assert.rejects(
        () => manager.submitCode("someone-else", "valid-code"),
        /another administrator/,
    );

    const submission = manager.submitCode("owner", "valid-code");
    await assert.rejects(
        () => manager.submitCode("owner", "valid-code"),
        /already being verified/,
    );
    const status = await submission;
    assert.equal(status.loggedIn, true);
    assert.equal(manager.hasActiveLogin(), false);

    fs.unlinkSync(markerPath);
    await manager.startLogin("owner");
    manager.cancelLogin("owner");
    assert.equal(manager.hasActiveLogin(), false);
});
