import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const helpUrl = new URL("../build/discord/commands/help.js", import.meta.url).href;

test("Codex help describes !usage as guidance and points admins to the DM limits command", () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
        const { handleHelp } = await import(${JSON.stringify(helpUrl)});
        await handleHelp({ author: { id: "ordinary-user" }, reply: async ({ content }) => {
            console.log(content.split("\\n").find((line) => line.includes("!usage")));
        } });
    `], {
        encoding: "utf8",
        env: { ...process.env, BOT_PROVIDER: "codex", AUTH_ADMIN_USER_IDS: "" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /`!usage`.*(?:how to|instructions|guidance)/i);
    assert.match(result.stdout, /!codex usage/);
});
