import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const validPrompts = {
    botSystem: "bot",
    dailySummarySystem: "summary",
    profileUpdate: "profile",
    serverMemoryUpdate: "memory",
};

function renderPromptValue(promptName, value) {
    const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-prompt-validation-"),
    );
    const promptsPath = path.join(tempDir, "prompts.json");
    const promptsUrl = new URL("../build/prompts.js", import.meta.url).href;
    const script = [
        `const { renderPrompt } = await import(${JSON.stringify(promptsUrl)});`,
        `process.stdout.write(renderPrompt(${JSON.stringify(promptName)}));`,
    ].join("\n");

    fs.writeFileSync(
        promptsPath,
        JSON.stringify({ ...validPrompts, [promptName]: value }),
        "utf8",
    );

    try {
        return spawnSync(
            process.execPath,
            ["--input-type=module", "--eval", script],
            {
                encoding: "utf8",
                env: {
                    ...process.env,
                    MESSAGES_DIR: path.join(tempDir, "messages"),
                    PROMPTS_PATH: promptsPath,
                },
            },
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

test("required prompts reject values without content", () => {
    for (const promptName of Object.keys(validPrompts)) {
        for (const value of [[], ["", "   "], " \n\t "]) {
            const result = renderPromptValue(promptName, value);
            assert.notEqual(result.status, 0);
            assert.match(
                result.stderr,
                new RegExp(`must not have an empty "${promptName}"`),
            );
        }
    }
});

test("required prompt arrays preserve intentional blank lines", () => {
    const result = renderPromptValue("botSystem", ["first", "", "second"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "first\n\nsecond");
});