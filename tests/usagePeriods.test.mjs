import assert from "node:assert/strict";
import test from "node:test";

import {
    buildCurrentPeriodUsageEmbed,
    createUsageRequest,
    getCurrentUsagePeriod,
} from "../build/discord/commands/usage.js";

const fixedNow = new Date("2026-08-05T14:30:45.000Z");

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

test("keeps existing usage request arguments unchanged", () => {
    assert.deepEqual(createUsageRequest("today", fixedNow)?.ccArgs, [
        "ccusage@latest", "claude", "daily", "--json", "--since", "20260805",
    ]);
    assert.deepEqual(createUsageRequest("daily", fixedNow)?.ccArgs, [
        "ccusage@latest", "claude", "daily", "--json",
    ]);
    assert.deepEqual(createUsageRequest("blocks", fixedNow)?.ccArgs, [
        "ccusage@latest", "claude", "blocks", "--json", "--since", "20260805",
    ]);
    assert.deepEqual(createUsageRequest("monthly", fixedNow)?.ccArgs, [
        "ccusage@latest", "claude", "monthly", "--json",
    ]);
    assert.equal(createUsageRequest("unknown", fixedNow), undefined);
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
