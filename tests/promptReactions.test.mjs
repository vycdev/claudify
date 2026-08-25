import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const promptsPath = path.join(currentDir, "..", "prompts", "prompts.json");
const prompts = JSON.parse(fs.readFileSync(promptsPath, "utf8"));
const botSystem = prompts.botSystem.join("\n");

test("response prompt requires a machine-readable reaction envelope", () => {
    assert.match(botSystem, /machine-readable JSON envelope/);
    assert.match(botSystem, /requiresTextResponse=false/);
    assert.match(botSystem, /reaction is one fitting Unicode or custom server emoji name, or null/);
    assert.match(botSystem, /short audit code, not an explanation or hidden chain of thought/);
    assert.match(botSystem, /Never describe, justify, or announce your choice to react/);
    assert.match(botSystem, /react-to-message:[\s\S]*explicitly asks[\s\S]*specific message/);
});
