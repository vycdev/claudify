import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createClaudeRunner } from "../build/claude.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

test("terminates a timed-out Claude process", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-process-"));
    const pidPath = path.join(tempDir, "pid");
    const fixturePath = path.join(currentDir, "fixtures", "fakeClaudeProcess.mjs");
    const runFakeClaude = createClaudeRunner({
        command: process.execPath,
        args: [fixturePath],
    });

    const originalPidPath = process.env.CLAUDIFY_PROCESS_TEST_PID_PATH;
    process.env.CLAUDIFY_PROCESS_TEST_PID_PATH = pidPath;

    let childPid;
    t.after(() => {
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

    const result = runFakeClaude(["-p"], "test input", {
        workload: "response",
    });
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

    if (process.platform === "win32") {
        // Windows terminates the child on the initial kill; POSIX gives the
        // fixture a grace period before escalating to SIGKILL.
        const terminationDeadline = Date.now() + 2_000;
        while (!resultSettled && Date.now() < terminationDeadline) {
            await new Promise((resolve) => setImmediate(resolve));
        }
        assert.equal(resultSettled, true, "Timed-out child did not exit within 2 seconds");
        await assert.rejects(result, /timed out after 120 seconds/);
        assert.throws(
            () => process.kill(childPid, 0),
            (error) => error?.code === "ESRCH",
        );
        return;
    }

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

test("decodes multibyte Claude output split across stream chunks", async () => {
    const script = `
        const character = Buffer.from("😀");
        process.stdout.write(character.subarray(0, 1));
        process.stderr.write(character.subarray(0, 2));
        setTimeout(() => {
            process.stdout.write(character.subarray(1));
            process.stderr.write(character.subarray(2));
        }, 25);
    `;
    const runFakeClaude = createClaudeRunner({
        command: process.execPath,
        args: ["--input-type=module", "--eval", script],
    });

    const result = await runFakeClaude([], "", { workload: "response" });

    assert.equal(result.stdout, "😀");
    assert.equal(result.stderr, "😀");
});
