import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workloadEnvNames = [
    "BOT_MODEL",
    "BOT_EFFORT",
    "CLAUDE_RESPONSE_MODEL",
    "CLAUDE_RESPONSE_EFFORT",
    "CLAUDE_RESPONSE_EFFORT_MODE",
    "CLAUDE_RESPONSE_SIMPLE_EFFORT",
    "CLAUDE_PROFILE_MODEL",
    "CLAUDE_PROFILE_EFFORT",
    "CLAUDE_SERVER_MEMORY_MODEL",
    "CLAUDE_SERVER_MEMORY_EFFORT",
    "CLAUDE_SUMMARY_MODEL",
    "CLAUDE_SUMMARY_EFFORT",
];

function readWorkloadConfig(overrides = {}) {
    const messagesDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-workload-config-"),
    );
    const configUrl = new URL("../build/config.js", import.meta.url).href;
    const script = [
        `const config = await import(${JSON.stringify(configUrl)});`,
        "process.stdout.write(JSON.stringify({ globalModel: config.BOT_MODEL, globalEffort: config.BOT_EFFORT, workloads: config.CLAUDE_WORKLOAD_CONFIG, responseDisplay: config.getResponseModelDisplay(), responseEffortMode: config.CLAUDE_RESPONSE_EFFORT_MODE, responseSimpleEffort: config.CLAUDE_RESPONSE_SIMPLE_EFFORT }));",
    ].join("\n");
    const env = { ...process.env };
    for (const name of workloadEnvNames) delete env[name];
    Object.assign(env, overrides, { MESSAGES_DIR: messagesDir });

    try {
        const result = spawnSync(
            process.execPath,
            ["--input-type=module", "--eval", script],
            { encoding: "utf8", env },
        );
        assert.equal(result.status, 0, result.stderr);
        return { config: JSON.parse(result.stdout), stderr: result.stderr };
    } finally {
        fs.rmSync(messagesDir, { recursive: true, force: true });
    }
}

test("all workloads inherit the legacy global model and effort", () => {
    const { config, stderr } = readWorkloadConfig({
        BOT_MODEL: "legacy-model",
        BOT_EFFORT: " HIGH ",
    });

    assert.equal(stderr, "");
    assert.equal(config.globalModel, "legacy-model");
    assert.equal(config.globalEffort, "high");
    assert.equal(config.responseDisplay, "legacy-model");
    assert.equal(config.responseEffortMode, "fixed");
    assert.equal(config.responseSimpleEffort, "low");
    assert.deepEqual(
        Object.values(config.workloads).map(({ model, effort }) => ({
            model,
            effort,
        })),
        Array.from({ length: 4 }, () => ({
            model: "legacy-model",
            effort: "high",
        })),
    );
});

test("workload model and effort overrides resolve independently", () => {
    const { config } = readWorkloadConfig({
        BOT_MODEL: "global-model",
        BOT_EFFORT: "medium",
        CLAUDE_RESPONSE_MODEL: " response-model ",
        CLAUDE_PROFILE_EFFORT: "LOW",
        CLAUDE_SERVER_MEMORY_MODEL: "inherit",
        CLAUDE_SERVER_MEMORY_EFFORT: " default ",
        CLAUDE_SUMMARY_MODEL: "summary-model",
        CLAUDE_SUMMARY_EFFORT: "max",
    });

    assert.deepEqual(config.workloads.response, {
        workload: "response",
        model: "response-model",
        effort: "medium",
    });
    assert.deepEqual(config.workloads["profile-update"], {
        workload: "profile-update",
        model: "global-model",
        effort: "low",
    });
    assert.deepEqual(config.workloads["server-memory-update"], {
        workload: "server-memory-update",
        model: "global-model",
    });
    assert.deepEqual(config.workloads["daily-summary"], {
        workload: "daily-summary",
        model: "summary-model",
        effort: "max",
    });
    assert.equal(config.responseDisplay, "response-model");
});

test("explicit default bypasses global values for one workload", () => {
    const { config } = readWorkloadConfig({
        BOT_MODEL: "global-model",
        BOT_EFFORT: "high",
        CLAUDE_RESPONSE_MODEL: "default",
        CLAUDE_RESPONSE_EFFORT: "default",
    });

    assert.deepEqual(config.workloads.response, { workload: "response" });
    assert.equal(config.responseDisplay, "Claude CLI default");
});

test("adaptive response effort settings resolve independently", () => {
    const { config, stderr } = readWorkloadConfig({
        BOT_EFFORT: "high",
        CLAUDE_RESPONSE_EFFORT_MODE: " ADAPTIVE ",
        CLAUDE_RESPONSE_SIMPLE_EFFORT: "MEDIUM",
    });

    assert.equal(stderr, "");
    assert.equal(config.responseEffortMode, "adaptive");
    assert.equal(config.responseSimpleEffort, "medium");
    assert.equal(config.workloads.response.effort, "high");
});

test("adaptive simple effort supports inherit and CLI default", () => {
    const inherited = readWorkloadConfig({
        CLAUDE_RESPONSE_EFFORT: "max",
        CLAUDE_RESPONSE_SIMPLE_EFFORT: "inherit",
    }).config;
    const cliDefault = readWorkloadConfig({
        CLAUDE_RESPONSE_EFFORT: "high",
        CLAUDE_RESPONSE_SIMPLE_EFFORT: "default",
    }).config;

    assert.equal(inherited.responseSimpleEffort, "max");
    assert.equal(cliDefault.responseSimpleEffort, undefined);
});

test("invalid adaptive settings warn and use backward-compatible defaults", () => {
    const { config, stderr } = readWorkloadConfig({
        CLAUDE_RESPONSE_EFFORT_MODE: "automatic",
        CLAUDE_RESPONSE_SIMPLE_EFFORT: "turbo",
    });

    assert.equal(config.responseEffortMode, "fixed");
    assert.equal(config.responseSimpleEffort, "low");
    assert.match(stderr, /Invalid CLAUDE_RESPONSE_EFFORT_MODE/);
    assert.match(stderr, /Invalid CLAUDE_RESPONSE_SIMPLE_EFFORT/);
});

test("invalid workload values warn and inherit deterministic fallbacks", () => {
    const { config, stderr } = readWorkloadConfig({
        BOT_MODEL: "global-model",
        BOT_EFFORT: "medium",
        CLAUDE_PROFILE_MODEL: "invalid model",
        CLAUDE_PROFILE_EFFORT: "turbo",
    });

    assert.deepEqual(config.workloads["profile-update"], {
        workload: "profile-update",
        model: "global-model",
        effort: "medium",
    });
    assert.match(stderr, /Invalid CLAUDE_PROFILE_MODEL/);
    assert.match(stderr, /Invalid CLAUDE_PROFILE_EFFORT/);
});

test("invalid globals warn and use built-in CLI settings", () => {
    const { config, stderr } = readWorkloadConfig({
        BOT_MODEL: "invalid\tmodel",
        BOT_EFFORT: "turbo",
    });

    assert.equal(config.globalModel, "claude-haiku-4-5");
    assert.equal(config.globalEffort, "");
    assert.equal(config.workloads.response.model, "claude-haiku-4-5");
    assert.equal(config.workloads.response.effort, undefined);
    assert.match(stderr, /Invalid BOT_MODEL/);
    assert.match(stderr, /Invalid BOT_EFFORT/);
});

test("model validation rejects Unicode control characters", () => {
    const { config, stderr } = readWorkloadConfig({
        BOT_MODEL: "global-model",
        CLAUDE_SUMMARY_MODEL: "summary\u0085model",
    });

    assert.equal(config.workloads["daily-summary"].model, "global-model");
    assert.match(stderr, /Invalid CLAUDE_SUMMARY_MODEL/);
});
