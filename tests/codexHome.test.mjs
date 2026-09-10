import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("unused Codex paths do not block Claude startup but remain forbidden for Codex use", () => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-codex-home-"),
    );
    const messages = path.join(directory, "messages");
    const env = {
        ...process.env,
        MESSAGES_DIR: messages,
        CODEX_HOME: path.join(messages, "codex"),
        BOT_PROVIDER: "claude",
    };
    const config = new URL("../build/config.js", import.meta.url).href;
    try {
        const result = spawnSync(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                `import assert from "node:assert/strict"; const config=await import(${JSON.stringify(config)}); assert.equal(config.BOT_PROVIDER,"claude"); assert.throws(()=>config.assertSafeCodexHome(),/outside MESSAGES_DIR/);`,
            ],
            { env, encoding: "utf8" },
        );
        assert.equal(result.status, 0, result.stderr);
        const codex = spawnSync(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                `await import(${JSON.stringify(config)})`,
            ],
            { env: { ...env, BOT_PROVIDER: "codex" }, encoding: "utf8" },
        );
        assert.notEqual(codex.status, 0);
        assert.match(codex.stderr, /outside MESSAGES_DIR/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
