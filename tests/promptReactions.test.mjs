import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const promptsPath = path.join(currentDir, "..", "prompts", "prompts.json");
const prompts = JSON.parse(fs.readFileSync(promptsPath, "utf8"));
const botSystem = prompts.botSystem.join("\n");

test("reaction prompt preserves mixed replies without exposing decision rationale", () => {
    assert.match(botSystem, /1\. Text only/);
    assert.match(botSystem, /2\. Reaction only/);
    assert.match(botSystem, /3\. Reaction plus reply/);
    assert.match(botSystem, /must make sense after the reaction tag is removed/);
    assert.match(botSystem, /Never describe, justify, or announce the reaction/);
    assert.match(botSystem, /Never reveal your decision process/);
    assert.match(botSystem, /asks a direct question[\s\S]*answer it normally/);
    assert.match(botSystem, /react-to-message:[\s\S]*explicitly asks[\s\S]*specific message/);
});
