import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runClaude } from "../build/claude.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

test("force-kills a timed-out Claude process that ignores SIGTERM", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-process-"));
    const pidPath = path.join(tempDir, "pid");
    const cliPath = path.join(tempDir, "claude");
    const fixturePath = path.join(currentDir, "fixtures", "fakeClaudeProcess.mjs");
    fs.copyFileSync(fixturePath, cliPath);
    fs.chmodSync(cliPath, 0o755);

    const originalPath = process.env.PATH;
    const originalPidPath = process.env.CLAUDIFY_PROCESS_TEST_PID_PATH;
    process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.CLAUDIFY_PROCESS_TEST_PID_PATH = pidPath;

    let childPid;
    t.after(() => {
        process.env.PATH = originalPath;
        if (originalPidPath === undefined) {
            delete process.env.CLAUDIFY_PROCESS_TEST_PID_PATH;
        } else {
            process.env.CLAUDIFY_PROCESS_TEST_PID_PATH = originalPidPath;
        }
        if (childPid) {
            try {
                process.kill(childPid, "SIGKILL");
            } catch {
                // runClaude should already have terminated it.
            }
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const result = runClaude(["-p"], "test input");
    let resultSettled = false;
    void result.then(
        () => {
            resultSettled = true;
        },
        () => {
            resultSettled = true;
        },
    );

    const startupDeadline = Date.now() + 2_000;
    while (
        !fs.existsSync(pidPath)
        && !resultSettled
        && Date.now() < startupDeadline
    ) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    if (!fs.existsSync(pidPath)) {
        if (resultSettled) await result;
        assert.fail("Fake Claude CLI did not start within 2 seconds");
    }
    childPid = Number(fs.readFileSync(pidPath, "utf8"));

    t.mock.timers.tick(120_000);
    await Promise.resolve();
    assert.equal(resultSettled, false);
    assert.doesNotThrow(() => process.kill(childPid, 0));

    t.mock.timers.tick(4_999);
    await Promise.resolve();
    assert.equal(resultSettled, false);
    assert.doesNotThrow(() => process.kill(childPid, 0));

    t.mock.timers.tick(1);
    await assert.rejects(result, /timed out after 120 seconds/);
    assert.throws(
        () => process.kill(childPid, 0),
        (error) => error?.code === "ESRCH",
    );
});
