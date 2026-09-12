import assert from "node:assert/strict";
import test from "node:test";

test("Claude routing refuses Codex-only effort values before invoking a provider", async t => {
    let claudeCalls = 0;
    t.mock.module("../build/config.js", { namedExports: {
        BOT_PROVIDER: "claude", CODEX_HOME: "unused", MESSAGES_DIR: "unused",
        MCP_PORT: 3100, MORPHEUS_MCP_URL: "", MORPHEUS_MCP_API_KEY: "",
    } });
    t.mock.module("../build/claude.js", { namedExports: {
        runClaude: () => { claudeCalls++; return Promise.resolve({ stdout: "ok" }); },
    } });
    t.mock.module("../build/codex.js", { namedExports: {
        createCodexRunner: () => () => { throw new Error("Must not invoke Codex"); },
    } });
    const { runModel } = await import("../build/model.js");
    for (const effort of ["none", "minimal", "ultra"]) {
        assert.throws(() => runModel([], "fixture", { workload: "response", effort }), /Unsupported Claude effort/);
    }
    assert.equal(claudeCalls, 0);
    await runModel([], "fixture", { workload: "response", effort: "max" });
    assert.equal(claudeCalls, 1);
});
