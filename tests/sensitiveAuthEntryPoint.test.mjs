import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// A failed assertion inside either nested suite must fail its unflagged wrapper.
// This catches inherited NODE_TEST_CONTEXT silently skipping the child suite.
for (const name of ["sensitiveAuthHandler.test.mjs", "sensitiveAuthMcp.test.mjs"]) {
    test(`${name} unflagged entrypoint propagates a failing regression`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-test-entrypoint-"));
        try {
            fs.symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
            const source = fs.readFileSync(new URL(name, import.meta.url), "utf8").replace(/\r\n/g, "\n");
            const branch = "\n} else {\n";
            assert.equal(source.split(branch).length, 2, "fixture must target the actual nested-suite branch");
            const fixture = path.join(root, name);
            const marker = "SYNTHETIC_ENTRYPOINT_FAILURE_MUST_EXECUTE";
            fs.writeFileSync(fixture, source.replace(branch, `${branch}\n    throw new Error("${marker}");`));
            const result = spawnSync(process.execPath, ["--test", fixture], {
                encoding: "utf8", timeout: 30000,
                // Bootstrap a fresh outer runner; its test worker will set its own context.
                env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT },
            });
            assert.notEqual(result.status, 0, "a deliberately broken nested suite must not report success");
            assert.match(result.stdout + result.stderr, new RegExp(marker));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}
