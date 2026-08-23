import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("formats Claude response prompt times in UTC", () => {
    const messagesDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-prompt-time-"),
    );
    try {
        const script = `
            import { askClaude } from "./build/askClaude.js";
            let prompt = "";
            await askClaude(
                "Question", "User", "user-1", "general", "channel-1",
                "Guild", "guild-1", [], "",
                async (_args, input) => {
                    prompt = input;
                    return { stdout: "Answer", stderr: "" };
                },
            );
            process.stdout.write(prompt.split("\\n", 1)[0]);
        `;
        const result = spawnSync(
            process.execPath,
            ["--input-type=module", "--eval", script],
            {
                cwd: repoDir,
                encoding: "utf8",
                env: {
                    ...process.env,
                    MESSAGES_DIR: messagesDir,
                    TZ: "America/Los_Angeles",
                },
            },
        );

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /^=== Current time: .* UTC ===$/);
    } finally {
        fs.rmSync(messagesDir, { recursive: true, force: true });
    }
});