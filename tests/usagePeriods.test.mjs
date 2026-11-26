import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.BOT_PROVIDER = "claude";

const {
    buildCurrentPeriodUsageEmbed,
    buildHistoricalUsageEmbed,
    createUsageRequest,
    formatUsageBlockTime,
    getCurrentUsagePeriod,
    handleUsage,
    runUsageCommand,
} = await import("../build/discord/commands/usage.js");

const fixedNow = new Date("2026-08-05T14:30:45.000Z");

test("billing-window model lists fit a Discord field without failing the usage reply", async (t) => {
    if (process.platform === "win32") {
        t.skip("PATH-based executable fixture requires POSIX");
        return;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-usage-models-"));
    const originalPath = process.env.PATH;
    t.after(() => {
        process.env.PATH = originalPath;
        fs.rmSync(root, { recursive: true, force: true });
    });
    const models = Array.from({ length: 20 }, (_, index) =>
        `claude-model-${index}-${"x".repeat(90)}`);
    fs.writeFileSync(path.join(root, "npx"),
        `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify({
            blocks: [{
                startTime: "2026-08-05T00:00:00Z",
                endTime: "2026-08-05T05:00:00Z",
                tokenCounts: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
                totalTokens: 2, costUSD: 0.01, entries: 1, models,
            }],
        }))});\n`, { mode: 0o700 });
    process.env.PATH = `${root}${path.delimiter}${originalPath ?? ""}`;
    const replies = [];
    await handleUsage({
        content: "!usage blocks",
        channel: { sendTyping: async () => {}, send: async () => {} },
        reply: async (payload) => { replies.push(payload); },
    });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].embeds[0].toJSON().title, "⏱️ Billing Windows (Today)");
    const field = replies[0].embeds[0].toJSON().fields.find((item) => item.name === "🤖 Models");
    assert.ok(field);
    assert.ok(field.value.length <= 1024);
    const modelLines = field.value.split("\n");
    const omitted = modelLines.pop();
    assert.equal(omitted, `${models.length - modelLines.length} more models omitted`);
});

test("times out a usage subprocess that does not exit", async () => {
    await assert.rejects(
        () => runUsageCommand(
            ["-e", "setInterval(() => {}, 1000)"],
            { command: process.execPath, timeoutMs: 50 },
        ),
        /ccusage timed out after 50 milliseconds/,
    );
});

test("rejects excessive usage subprocess output instead of buffering it all", async () => {
    await assert.rejects(
        () => runUsageCommand(
            ["-e", "process.stdout.write('x'.repeat(1_048_577))"],
            { command: process.execPath, timeoutMs: 5_000 },
        ),
        /ccusage output exceeded 1048576 bytes/,
    );
});

test("bounds combined stdout and stderr while preserving normal output", async () => {
    assert.deepEqual(await runUsageCommand(
        ["-e", "process.stdout.write('ok'); process.stderr.write('note')"],
        { command: process.execPath, timeoutMs: 5_000 },
    ), { stdout: "ok", stderr: "note" });

    await assert.rejects(
        () => runUsageCommand(
            ["-e", "process.stdout.write('x'.repeat(600_000)); process.stderr.write('y'.repeat(600_000))"],
            { command: process.execPath, timeoutMs: 5_000 },
        ),
        /ccusage output exceeded 1048576 bytes/,
    );
});

test("calculates the current UTC week from Monday through now", () => {
    assert.deepEqual(getCurrentUsagePeriod("week", fixedNow), {
        since: "20260803",
        until: "20260805",
        displayRange: "2026-08-03 00:00 UTC → 2026-08-05 14:30:45 UTC",
    });

    const monday = new Date("2026-08-03T00:00:01.000Z");
    assert.equal(getCurrentUsagePeriod("week", monday).since, "20260803");

    const sundayAcrossYearBoundary = new Date("2027-01-03T23:59:59.000Z");
    assert.equal(getCurrentUsagePeriod("week", sundayAcrossYearBoundary).since, "20261228");
});

test("calculates the current UTC month from its first day through now", () => {
    assert.deepEqual(getCurrentUsagePeriod("month", fixedNow), {
        since: "20260801",
        until: "20260805",
        displayRange: "2026-08-01 00:00 UTC → 2026-08-05 14:30:45 UTC",
    });
});

test("builds bounded UTC ccusage requests for current week and month", () => {
    assert.deepEqual(createUsageRequest("week", fixedNow)?.ccArgs, [
        "ccusage@latest",
        "claude",
        "weekly",
        "--json",
        "--breakdown",
        "--start-of-week",
        "monday",
        "--since",
        "20260803",
        "--until",
        "20260805",
        "--timezone",
        "UTC",
    ]);

    assert.deepEqual(createUsageRequest("month", fixedNow)?.ccArgs, [
        "ccusage@latest",
        "claude",
        "monthly",
        "--json",
        "--breakdown",
        "--since",
        "20260801",
        "--until",
        "20260805",
        "--timezone",
        "UTC",
    ]);
});

test("requests today's usage using the same UTC boundary as its date filter", () => {
    assert.deepEqual(createUsageRequest("today", fixedNow)?.ccArgs, [
        "ccusage@latest", "claude", "daily", "--json", "--since", "20260805",
        "--timezone", "UTC",
    ]);
});

test("keeps historical usage request arguments unchanged", () => {
    assert.deepEqual(createUsageRequest("daily", fixedNow)?.ccArgs, [
        "ccusage@latest", "claude", "daily", "--json",
    ]);
    assert.deepEqual(createUsageRequest("monthly", fixedNow)?.ccArgs, [
        "ccusage@latest", "claude", "monthly", "--json",
    ]);
    assert.equal(createUsageRequest("unknown", fixedNow), undefined);
});

test("requests and renders today's billing windows in UTC", () => {
    assert.deepEqual(createUsageRequest("blocks", fixedNow)?.ccArgs, [
        "ccusage@latest", "claude", "blocks", "--json", "--since", "20260805",
        "--timezone", "UTC",
    ]);
    assert.equal(
        formatUsageBlockTime(new Date("2026-08-05T00:30:00.000Z")),
        "12:30 AM UTC",
    );
});

test("renders aggregate totals, date range, and per-model usage", () => {
    const period = getCurrentUsagePeriod("week", fixedNow);
    const embed = buildCurrentPeriodUsageEmbed("week", {
        totals: {
            inputTokens: 2000,
            outputTokens: 750,
            cacheCreationTokens: 300,
            cacheReadTokens: 450,
            totalTokens: 3500,
            totalCost: 0.75,
        },
        weekly: [
            {
                inputTokens: 1000,
                outputTokens: 500,
                cacheCreationTokens: 100,
                cacheReadTokens: 200,
                totalTokens: 1800,
                totalCost: 0.4,
                modelBreakdowns: [{
                    modelName: "claude-sonnet-4-20250514",
                    inputTokens: 1000,
                    outputTokens: 500,
                    cacheCreationTokens: 100,
                    cacheReadTokens: 200,
                    cost: 0.4,
                }],
            },
            {
                inputTokens: 1000,
                outputTokens: 250,
                cacheCreationTokens: 200,
                cacheReadTokens: 250,
                totalTokens: 1700,
                totalCost: 0.35,
                modelBreakdowns: [
                    {
                        modelName: "claude-sonnet-4-20250514",
                        inputTokens: 500,
                        outputTokens: 100,
                        cacheCreationTokens: 100,
                        cacheReadTokens: 100,
                        cost: 0.1,
                    },
                    {
                        modelName: "claude-haiku-4-5-20251001",
                        inputTokens: 500,
                        outputTokens: 150,
                        cacheCreationTokens: 100,
                        cacheReadTokens: 150,
                        cost: 0.25,
                    },
                ],
            },
        ],
    }, period).toJSON();

    assert.equal(embed.title, "📈 Current Week Usage");
    assert.match(embed.description, /Total Cost: \$0\.7500/);
    assert.match(embed.description, /3\.5K tokens/);

    const coveredPeriod = embed.fields.find((field) => field.name === "📅 Covered Period");
    assert.equal(coveredPeriod?.value, period.displayRange);

    const sonnet = embed.fields.find((field) => field.name.includes("sonnet-4"));
    assert.match(sonnet?.value ?? "", /\$0\.5000/);
    assert.match(sonnet?.value ?? "", /In: 1\.5K · Out: 600/);

    const haiku = embed.fields.find((field) => field.name.includes("haiku-4-5"));
    assert.match(haiku?.value ?? "", /\$0\.2500/);
});

test("renders a clear empty state for a current period", () => {
    const embed = buildCurrentPeriodUsageEmbed("month", {
        monthly: [],
        totals: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalTokens: 0,
            totalCost: 0,
        },
    }, getCurrentUsagePeriod("month", fixedNow)).toJSON();

    assert.match(embed.description, /No usage data found for this period/);
    assert.match(embed.description, /Total Cost: \$0\.0000/);
    assert.ok(embed.fields.some((field) =>
        field.name === "🤖 Models" && field.value === "No model usage in this period."
    ));
});

test("keeps current-period model fields within Discord's embed limit", () => {
    const modelBreakdowns = Array.from({ length: 24 }, (_, index) => ({
        modelName: `claude-model-${index}`,
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        cost: 1,
    }));
    const embed = buildCurrentPeriodUsageEmbed("week", {
        weekly: [{
            inputTokens: 24,
            outputTokens: 24,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalTokens: 48,
            totalCost: 24,
            modelBreakdowns,
        }],
    }, getCurrentUsagePeriod("week", fixedNow)).toJSON();

    assert.equal(embed.fields.length, 25);
    assert.ok(embed.fields.some((field) =>
        field.name === "🤖 Additional Models" && field.value.startsWith("2 more model(s)")
    ));
});

test("keeps historical model fields within Discord's embed limit", () => {
    const modelBreakdowns = Array.from({ length: 25 }, (_, index) => ({
        modelName: `claude-model-${index}`,
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        cost: 1,
    }));
    const embed = buildHistoricalUsageEmbed("📅 Daily Usage", 0x57f287, "2026-08-05", {
        inputTokens: 25,
        outputTokens: 25,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 50,
        totalCost: 25,
        modelBreakdowns,
    }).toJSON();

    assert.equal(embed.fields.length, 25);
    assert.ok(embed.fields.some((field) =>
        field.name === "🤖 Additional Models" && field.value.startsWith("2 more model(s)")
    ));
});

test("long model names fit Discord's embed field-name limit", () => {
    const entry = {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 2,
        totalCost: 1,
        modelBreakdowns: [{
            modelName: "model-" + "🟣".repeat(150),
            inputTokens: 1,
            outputTokens: 1,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            cost: 1,
        }],
    };
    const field = buildHistoricalUsageEmbed("Daily", 0x57f287, "today", entry)
        .toJSON().fields.find((item) => item.name.includes("model-"));
    assert.ok(field);
    assert.ok(field.name.length <= 256);
    assert.ok(field.name.endsWith("…"));
    assert.doesNotMatch(field.name, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
});

test("many long model names fit Discord's total embed character limit", () => {
    const models = Array.from({ length: 25 }, (_, index) => ({
        modelName: `model-${index}-${"x".repeat(300)}`,
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        cost: 1,
    }));
    const embed = buildHistoricalUsageEmbed("Daily", 0x57f287, "today", {
        inputTokens: 25,
        outputTokens: 25,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 50,
        totalCost: 25,
        modelBreakdowns: models,
    }).toJSON();
    const characters = (embed.title?.length ?? 0)
        + (embed.description?.length ?? 0)
        + (embed.footer?.text.length ?? 0)
        + (embed.author?.name.length ?? 0)
        + embed.fields.reduce((total, field) => total + field.name.length + field.value.length, 0);
    assert.ok(characters <= 6000, `embed contains ${characters} characters`);
});
