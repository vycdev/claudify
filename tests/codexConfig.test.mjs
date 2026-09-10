import assert from "node:assert/strict";
import test from "node:test";

test("Codex defaults to Luna and never inherits legacy Claude models", async () => {
    const { resolveCodexConfig, parseBotProvider } = await import(
        "../build/codexConfig.js"
    );
    assert.equal(parseBotProvider(undefined), "claude");
    assert.equal(parseBotProvider("codex"), "codex");
    assert.throws(() => parseBotProvider("other"), /BOT_PROVIDER/);
    const config = resolveCodexConfig({
        BOT_MODEL: "claude-sonnet-5",
        BOT_EFFORT: "max",
    });
    for (const entry of Object.values(config.workloads)) {
        assert.equal(entry.model, "gpt-5.6-luna");
        assert.equal(entry.effort, "medium");
    }
    assert.ok(Object.isFrozen(config.workloads.response));
    const custom = resolveCodexConfig({
        CODEX_MODEL: "gpt-5.6-sol",
        CODEX_EFFORT: "high",
        CODEX_PROFILE_MODEL: "gpt-5.6-luna",
        CODEX_PROFILE_EFFORT: "low",
    });
    assert.equal(custom.workloads.response.model, "gpt-5.6-sol");
    assert.equal(custom.workloads["profile-update"].effort, "low");
    const adaptive = resolveCodexConfig({
        CODEX_EFFORT: "high",
        CODEX_RESPONSE_SIMPLE_EFFORT: "inherit",
        CODEX_RESPONSE_EFFORT_MODE: "adaptive",
    });
    assert.equal(adaptive.simpleEffort, "high");
    assert.throws(
        () => resolveCodexConfig({ CODEX_MODEL: "bad model" }),
        /CODEX_MODEL/,
    );
    assert.throws(
        () => resolveCodexConfig({ CODEX_EFFORT: "invalid" }),
        /CODEX_EFFORT/,
    );
});
