import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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

test("extracts a trusted OAuth URL from terminal hyperlink output", () => {
    const loginUrl = "https://claude.com/cai/oauth/authorize?code=test";
    const output =
        `\u001b]8;;${loginUrl}\u0007${loginUrl}\u001b]8;;\u0007\n`;
    assert.equal(
        extractClaudeLoginUrl(output),
        loginUrl,
    );
    assert.equal(
        extractClaudeLoginUrl("https://example.com/oauth/authorize?code=test"),
        undefined,
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
            CLAUDIFY_AUTH_TEST_REQUIRE_TTY: "1",
        },
    });

    assert.deepEqual(await manager.getStatus(), { loggedIn: false });
    const loginUrl = await manager.startLogin("owner");
    assert.equal(loginUrl, "https://claude.com/cai/oauth/authorize?test=1");
    await assert.rejects(
        () => manager.submitCode("someone-else", "valid-code"),
        /another allowed user/,
    );
    await assert.rejects(
        () => manager.submitCode("owner", "code\u001b[2J"),
        /code is not valid/,
    );
    assert.equal(manager.hasActiveLogin(), true);
    await assert.rejects(
        () => manager.submitCode("owner", "invalid-code"),
        /rejected.*try again/,
    );
    assert.equal(manager.hasActiveLogin(), true);

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

    const closedInputManager = new ClaudeAuthManager({
        command: process.execPath,
        prefixArgs: [fakeCliPath],
        commandTimeoutMs: 2_000,
        loginTimeoutMs: 2_000,
        env: {
            ...process.env,
            CLAUDIFY_AUTH_TEST_MARKER: markerPath,
            CLAUDIFY_AUTH_TEST_CLOSE_STDIN: "1",
        },
    });
    await closedInputManager.startLogin("owner");
    await assert.rejects(
        () => closedInputManager.submitCode("owner", "valid-code"),
        /could not accept|rejected/,
    );
    assert.equal(closedInputManager.hasActiveLogin(), false);
});

test("force-kills a timed-out login process that ignores SIGTERM", async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-auth-"));
    const markerPath = path.join(tempDir, "authenticated");
    const pidPath = path.join(tempDir, "pid");
    const fakeCliPath = path.join(tempDir, "fake-claude.mjs");
    const fixturePath = path.join(currentDir, "fixtures", "fakeClaudeAuth.mjs");
    fs.copyFileSync(fixturePath, fakeCliPath);
    let childPid;
    t.after(() => {
        if (childPid) {
            try {
                process.kill(childPid, "SIGKILL");
            } catch {
                // The manager should already have terminated it.
            }
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const manager = new ClaudeAuthManager({
        command: process.execPath,
        prefixArgs: [fakeCliPath],
        loginTimeoutMs: 250,
        env: {
            ...process.env,
            CLAUDIFY_AUTH_TEST_MARKER: markerPath,
            CLAUDIFY_AUTH_TEST_IGNORE_SIGTERM: "1",
            CLAUDIFY_AUTH_TEST_PID_PATH: pidPath,
        },
    });

    await manager.startLogin("owner");
    childPid = Number(fs.readFileSync(pidPath, "utf8"));
    assert.equal(manager.hasActiveLogin(), true);
    await assert.rejects(
        () => manager.submitCode("owner", "pending-code"),
        /timed out/,
    );

    if (process.platform !== "win32") {
        assert.equal(manager.hasActiveLogin(), true);
        await assert.rejects(
            () => manager.startLogin("owner"),
            /already active/,
        );
    }

    const processIsRunning = () => {
        try {
            process.kill(childPid, 0);
            return true;
        } catch (error) {
            if (error?.code === "ESRCH") return false;
            throw error;
        }
    };
    const deadline = Date.now() + 2_000;
    while (
        (manager.hasActiveLogin() || processIsRunning())
        && Date.now() < deadline
    ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(manager.hasActiveLogin(), false);
    assert.equal(processIsRunning(), false);
});

test("force-kills a timed-out auth status process that ignores SIGTERM", async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-auth-"));
    const markerPath = path.join(tempDir, "authenticated");
    const pidPath = path.join(tempDir, "pid");
    const fakeCliPath = path.join(tempDir, "fake-claude.mjs");
    const fixturePath = path.join(currentDir, "fixtures", "fakeClaudeAuth.mjs");
    fs.copyFileSync(fixturePath, fakeCliPath);
    let childPid;
    t.after(() => {
        if (childPid) {
            try {
                process.kill(childPid, "SIGKILL");
            } catch {
                // The manager should already have terminated it.
            }
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const manager = new ClaudeAuthManager({
        command: process.execPath,
        prefixArgs: [fakeCliPath],
        commandTimeoutMs: 250,
        env: {
            ...process.env,
            CLAUDIFY_AUTH_TEST_MARKER: markerPath,
            CLAUDIFY_AUTH_TEST_IGNORE_STATUS_SIGTERM: "1",
            CLAUDIFY_AUTH_TEST_PID_PATH: pidPath,
        },
    });

    const timedOut = assert.rejects(
        () => manager.getStatus(),
        /status timed out/,
    );
    const readyDeadline = Date.now() + 1_000;
    while (!fs.existsSync(pidPath) && Date.now() < readyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(pidPath), true);
    childPid = Number(fs.readFileSync(pidPath, "utf8"));
    await timedOut;

    const processIsRunning = () => {
        try {
            process.kill(childPid, 0);
            return true;
        } catch (error) {
            if (error?.code === "ESRCH") return false;
            throw error;
        }
    };
    const deadline = Date.now() + 2_000;
    while (processIsRunning() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(processIsRunning(), false);
});

test("falls back for invalid Claude login timeout environment values", () => {
    const configUrl = new URL("../build/config.js", import.meta.url).href;
    const readTimeout = (value) => {
        const result = spawnSync(
            process.execPath,
            [
                "--input-type=module",
                "--eval",
                `import { CLAUDE_AUTH_LOGIN_TIMEOUT_MS } from ${JSON.stringify(configUrl)}; process.stdout.write(String(CLAUDE_AUTH_LOGIN_TIMEOUT_MS));`,
            ],
            {
                encoding: "utf8",
                env: {
                    ...process.env,
                    CLAUDE_AUTH_LOGIN_TIMEOUT_MS: value,
                },
            },
        );
        assert.equal(result.status, 0, result.stderr);
        return Number(result.stdout);
    };

    assert.equal(readTimeout("120000"), 120_000);
    for (const value of ["", "oops", "-1", "0", "1.5", "2147483648"]) {
        assert.equal(readTimeout(value), 300_000);
    }
});
