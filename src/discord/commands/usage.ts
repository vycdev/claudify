import { spawn } from "child_process";
import { Message, TextChannel, EmbedBuilder } from "discord.js";

export type CurrentUsagePeriodKind = "week" | "month";

export interface CurrentUsagePeriod {
    since: string;
    until: string;
    displayRange: string;
}

interface UsageRequest {
    ccArgs: string[];
    title: string;
    embedColor: number;
    period?: CurrentUsagePeriod;
}

interface UsageTotals {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
    totalCost: number;
}

interface UsageModelBreakdown {
    modelName: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    cost: number;
}

interface CurrentPeriodEntry extends UsageTotals {
    modelBreakdowns?: UsageModelBreakdown[];
}

interface HistoricalUsageEntry extends UsageTotals {
    modelBreakdowns?: UsageModelBreakdown[];
}

export interface CurrentPeriodUsageData {
    weekly?: CurrentPeriodEntry[];
    monthly?: CurrentPeriodEntry[];
    totals?: UsageTotals;
}

const EMPTY_TOTALS: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    totalCost: 0,
};

const DISCORD_MAX_EMBED_FIELDS = 25;

function formatCompactUtcDate(date: Date): string {
    return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function formatUtcCalendarDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

function formatUtcTimestamp(date: Date): string {
    return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export function getCurrentUsagePeriod(
    kind: CurrentUsagePeriodKind,
    now = new Date(),
): CurrentUsagePeriod {
    const start = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        kind === "month" ? 1 : now.getUTCDate(),
    ));

    if (kind === "week") {
        const daysSinceMonday = (start.getUTCDay() + 6) % 7;
        start.setUTCDate(start.getUTCDate() - daysSinceMonday);
    }

    return {
        since: formatCompactUtcDate(start),
        until: formatCompactUtcDate(now),
        displayRange: `${formatUtcCalendarDate(start)} 00:00 UTC → ${formatUtcTimestamp(now)}`,
    };
}

export function createUsageRequest(subcommand: string, now = new Date()): UsageRequest | undefined {
    const today = formatCompactUtcDate(now);

    switch (subcommand) {
        case "today":
            return {
                ccArgs: ["ccusage@latest", "claude", "daily", "--json", "--since", today],
                title: "📊 Today's Usage",
                embedColor: 0x5865f2,
            };
        case "week": {
            const period = getCurrentUsagePeriod("week", now);
            return {
                ccArgs: [
                    "ccusage@latest", "claude", "weekly", "--json", "--breakdown",
                    "--start-of-week", "monday", "--since", period.since,
                    "--until", period.until, "--timezone", "UTC",
                ],
                title: "📈 Current Week Usage",
                embedColor: 0x3498db,
                period,
            };
        }
        case "month": {
            const period = getCurrentUsagePeriod("month", now);
            return {
                ccArgs: [
                    "ccusage@latest", "claude", "monthly", "--json", "--breakdown",
                    "--since", period.since, "--until", period.until, "--timezone", "UTC",
                ],
                title: "📆 Current Month Usage",
                embedColor: 0x9b59b6,
                period,
            };
        }
        case "daily":
            return {
                ccArgs: ["ccusage@latest", "claude", "daily", "--json"],
                title: "📅 Daily Usage",
                embedColor: 0x57f287,
            };
        case "blocks":
            return {
                ccArgs: [
                    "ccusage@latest", "claude", "blocks", "--json", "--since", today,
                    "--timezone", "UTC",
                ],
                title: "⏱️ Billing Windows (Today)",
                embedColor: 0xfee75c,
            };
        case "monthly":
            return {
                ccArgs: ["ccusage@latest", "claude", "monthly", "--json"],
                title: "📆 Monthly Usage",
                embedColor: 0xeb459e,
            };
        default:
            return undefined;
    }
}

const formatCost = (cost: number) => cost >= 1 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`;
const formatTokens = (tokens: number) =>
    tokens >= 1_000_000_000 ? `${(tokens / 1_000_000_000).toFixed(2)}B`
    : tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(2)}M`
    : tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1)}K`
    : `${tokens}`;
const progressBar = (value: number, max: number, length = 10) => {
    if (max === 0) return "░".repeat(length);
    const filled = Math.round((value / max) * length);
    return "█".repeat(Math.min(filled, length)) + "░".repeat(length - Math.min(filled, length));
};
const modelEmoji = (name: string) => {
    if (name.includes("opus")) return "🟣";
    if (name.includes("sonnet")) return "🔵";
    if (name.includes("haiku")) return "🟢";
    return "⚪";
};
const shortModel = (name: string) => name
    .replace("claude-", "")
    .replace(/-\d{8}$/, "");

export function formatUsageBlockTime(date: Date): string {
    return `${date.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
        timeZone: "UTC",
    })} UTC`;
}

function sumUsageTotals(entries: CurrentPeriodEntry[]): UsageTotals {
    return entries.reduce<UsageTotals>((totals, entry) => ({
        inputTokens: totals.inputTokens + entry.inputTokens,
        outputTokens: totals.outputTokens + entry.outputTokens,
        cacheCreationTokens: totals.cacheCreationTokens + entry.cacheCreationTokens,
        cacheReadTokens: totals.cacheReadTokens + entry.cacheReadTokens,
        totalTokens: totals.totalTokens + entry.totalTokens,
        totalCost: totals.totalCost + entry.totalCost,
    }), { ...EMPTY_TOTALS });
}

function aggregateModelBreakdowns(entries: CurrentPeriodEntry[]): UsageModelBreakdown[] {
    const models = new Map<string, UsageModelBreakdown>();

    for (const entry of entries) {
        for (const model of entry.modelBreakdowns || []) {
            const existing = models.get(model.modelName);
            if (existing) {
                existing.inputTokens += model.inputTokens;
                existing.outputTokens += model.outputTokens;
                existing.cacheCreationTokens += model.cacheCreationTokens;
                existing.cacheReadTokens += model.cacheReadTokens;
                existing.cost += model.cost;
            } else {
                models.set(model.modelName, { ...model });
            }
        }
    }

    return [...models.values()].sort((a, b) => b.cost - a.cost);
}

function addModelBreakdownFields(
    embed: EmbedBuilder,
    modelBreakdowns: UsageModelBreakdown[],
    totalCost: number,
): void {
    const existingFieldCount = embed.toJSON().fields?.length || 0;
    const availableFields = Math.max(0, DISCORD_MAX_EMBED_FIELDS - existingFieldCount);
    const visibleModelLimit = modelBreakdowns.length > availableFields
        ? Math.max(0, availableFields - 1)
        : availableFields;
    const visibleModels = modelBreakdowns.slice(0, visibleModelLimit);
    const maxCost = Math.max(0, ...visibleModels.map((model) => model.cost));

    for (const model of visibleModels) {
        const percentage = totalCost > 0
            ? ((model.cost / totalCost) * 100).toFixed(1)
            : "0";
        let detail = `\`${progressBar(model.cost, maxCost, 12)}\` **${formatCost(model.cost)}** (${percentage}%)\n`;
        detail += `In: ${formatTokens(model.inputTokens)} · Out: ${formatTokens(model.outputTokens)}`;
        if (model.cacheCreationTokens > 0 || model.cacheReadTokens > 0) {
            detail += `\nCache W: ${formatTokens(model.cacheCreationTokens)} · Cache R: ${formatTokens(model.cacheReadTokens)}`;
        }
        embed.addFields({
            name: `${modelEmoji(model.modelName)} ${shortModel(model.modelName)}`,
            value: detail,
            inline: false,
        });
    }

    if (modelBreakdowns.length > visibleModels.length && availableFields > 0) {
        embed.addFields({
            name: "🤖 Additional Models",
            value: `${modelBreakdowns.length - visibleModels.length} more model(s) omitted to fit Discord's embed limit.`,
            inline: false,
        });
    }
}

export function buildHistoricalUsageEmbed(
    title: string,
    embedColor: number,
    label: string,
    entry: HistoricalUsageEntry,
): EmbedBuilder {
    const embed = new EmbedBuilder()
        .setTitle(`${title} — ${label}`)
        .setColor(embedColor)
        .setDescription(
            `**Total Cost: ${formatCost(entry.totalCost)}** · ${formatTokens(entry.totalTokens)} tokens`,
        );

    let tokenDetail = "```\n";
    tokenDetail += `Input:        ${formatTokens(entry.inputTokens).padStart(10)}\n`;
    tokenDetail += `Output:       ${formatTokens(entry.outputTokens).padStart(10)}\n`;
    tokenDetail += `Cache write:  ${formatTokens(entry.cacheCreationTokens).padStart(10)}\n`;
    tokenDetail += `Cache read:   ${formatTokens(entry.cacheReadTokens).padStart(10)}\n`;
    tokenDetail += "```";
    embed.addFields({ name: "🔢 Token Breakdown", value: tokenDetail, inline: false });

    addModelBreakdownFields(embed, entry.modelBreakdowns || [], entry.totalCost);
    return embed.setTimestamp();
}

export function buildCurrentPeriodUsageEmbed(
    kind: CurrentUsagePeriodKind,
    data: CurrentPeriodUsageData,
    period: CurrentUsagePeriod,
): EmbedBuilder {
    const entries = kind === "week" ? data.weekly || [] : data.monthly || [];
    const totals = data.totals || (entries.length > 0 ? sumUsageTotals(entries) : EMPTY_TOTALS);
    const modelBreakdowns = aggregateModelBreakdowns(entries);
    const title = kind === "week" ? "📈 Current Week Usage" : "📆 Current Month Usage";
    const embedColor = kind === "week" ? 0x3498db : 0x9b59b6;
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(embedColor)
        .setDescription(
            `${entries.length === 0 ? "No usage data found for this period.\n\n" : ""}` +
            `**Total Cost: ${formatCost(totals.totalCost)}** · ${formatTokens(totals.totalTokens)} tokens`,
        )
        .addFields(
            { name: "📅 Covered Period", value: period.displayRange, inline: false },
            {
                name: "🔢 Token Breakdown",
                value:
                    "```\n" +
                    `Input:        ${formatTokens(totals.inputTokens).padStart(10)}\n` +
                    `Output:       ${formatTokens(totals.outputTokens).padStart(10)}\n` +
                    `Cache write:  ${formatTokens(totals.cacheCreationTokens).padStart(10)}\n` +
                    `Cache read:   ${formatTokens(totals.cacheReadTokens).padStart(10)}\n` +
                    "```",
                inline: false,
            },
        );

    if (modelBreakdowns.length === 0) {
        embed.addFields({ name: "🤖 Models", value: "No model usage in this period.", inline: false });
    } else {
        addModelBreakdownFields(embed, modelBreakdowns, totals.totalCost);
    }

    return embed.setTimestamp();
}

export async function handleUsage(msg: Message): Promise<void> {
    const args = msg.content.trim().split(/\s+/).slice(1);
    const subcommand = args[0] || "today";

    const request = createUsageRequest(subcommand);
    if (!request) {
        const helpEmbed = new EmbedBuilder()
            .setTitle("📊 Usage Command Help")
            .setColor(0x5865f2)
            .setDescription("View Claude API token usage and costs.")
            .addFields(
                { name: "`!usage today`", value: "Today's breakdown by model *(default)*", inline: true },
                { name: "`!usage week`", value: "Current week since Monday 00:00 UTC", inline: true },
                { name: "`!usage month`", value: "Current calendar month so far (UTC)", inline: true },
                { name: "`!usage daily`", value: "Daily breakdown over time", inline: true },
                { name: "`!usage blocks`", value: "5-hour billing windows for today", inline: true },
                { name: "`!usage monthly`", value: "Historical monthly totals and trends", inline: true },
            )
            .setFooter({ text: "Powered by ccusage" });
        await msg.reply({ embeds: [helpEmbed] });
        return;
    }

    const { ccArgs, title, embedColor, period } = request;

    await (msg.channel as TextChannel).sendTyping();

    try {
        const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
            const proc = spawn("npx", ccArgs, {
                env: { ...process.env },
                shell: true,
            });
            let stdout = "";
            let stderr = "";
            proc.stdout.on("data", (d) => (stdout += d.toString()));
            proc.stderr.on("data", (d) => (stderr += d.toString()));
            proc.on("close", (code) =>
                code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || `exit ${code}`)),
            );
        });

        const data = JSON.parse(stdout);
        const embeds: EmbedBuilder[] = [];

        if (subcommand === "blocks") {
            const blocks = (data.blocks || []).filter((b: any) => !b.isGap);
            if (blocks.length === 0) {
                const embed = new EmbedBuilder()
                    .setTitle(title)
                    .setColor(embedColor)
                    .setDescription("No active billing windows found today.")
                    .setTimestamp();
                embeds.push(embed);
            }
            for (const block of blocks) {
                const start = new Date(block.startTime);
                const end = new Date(block.endTime);
                const startStr = formatUsageBlockTime(start);
                const endStr = formatUsageBlockTime(end);

                const embed = new EmbedBuilder()
                    .setTitle(`${title}`)
                    .setColor(block.isActive ? 0x57f287 : 0x99aab5)
                    .setDescription(
                        `**${startStr} — ${endStr}**` +
                        (block.isActive ? "  🟢 Active" : "  ⚫ Ended")
                    );

                const tc = block.tokenCounts;
                let tokenDetail = "```\n";
                tokenDetail += `Input tokens:     ${formatTokens(tc.inputTokens).padStart(10)}\n`;
                tokenDetail += `Output tokens:    ${formatTokens(tc.outputTokens).padStart(10)}\n`;
                tokenDetail += `Cache write:      ${formatTokens(tc.cacheCreationInputTokens).padStart(10)}\n`;
                tokenDetail += `Cache read:       ${formatTokens(tc.cacheReadInputTokens).padStart(10)}\n`;
                tokenDetail += `─────────────────────────\n`;
                tokenDetail += `Total:            ${formatTokens(block.totalTokens).padStart(10)}\n`;
                tokenDetail += "```";
                embed.addFields({ name: "🔢 Tokens", value: tokenDetail, inline: false });

                embed.addFields(
                    { name: "💰 Cost", value: `**${formatCost(block.costUSD)}**`, inline: true },
                    { name: "📊 Entries", value: `${block.entries}`, inline: true },
                );

                if (block.models && block.models.length > 0) {
                    const modelList = block.models.map((m: string) => `${modelEmoji(m)} ${shortModel(m)}`).join("\n");
                    embed.addFields({ name: "🤖 Models", value: modelList, inline: true });
                }

                if (block.isActive && block.burnRate) {
                    const br = block.burnRate;
                    let rateStr = `${formatTokens(Math.round(br.tokensPerMinute))} tokens/min\n`;
                    rateStr += `${formatCost(br.costPerHour)}/hour`;
                    embed.addFields({ name: "🔥 Burn Rate", value: rateStr, inline: true });

                    if (block.projection) {
                        const proj = block.projection;
                        const hoursLeft = (proj.remainingMinutes / 60).toFixed(1);
                        let projStr = `Projected window cost: **${formatCost(proj.totalCost)}**\n`;
                        projStr += `Projected tokens: ${formatTokens(proj.totalTokens)}\n`;
                        projStr += `Time remaining: ${hoursLeft}h`;
                        embed.addFields({ name: "📈 Projection", value: projStr, inline: true });
                    }
                }

                embed.setTimestamp();
                embeds.push(embed);
            }
        } else if ((subcommand === "week" || subcommand === "month") && period) {
            embeds.push(buildCurrentPeriodUsageEmbed(subcommand, data, period));
        } else if (subcommand === "monthly") {
            const entries = data.monthly || [];
            if (entries.length === 0) {
                const embed = new EmbedBuilder()
                    .setTitle(title)
                    .setColor(embedColor)
                    .setDescription("No usage data found for this period.")
                    .setTimestamp();
                embeds.push(embed);
            }

            for (const entry of entries) {
                embeds.push(buildHistoricalUsageEmbed(title, embedColor, entry.month, entry));
            }
        } else {
            const entries = data.daily || [];
            if (entries.length === 0) {
                const embed = new EmbedBuilder()
                    .setTitle(title)
                    .setColor(embedColor)
                    .setDescription("No usage data found for this period.")
                    .setTimestamp();
                embeds.push(embed);
            }

            for (const entry of entries) {
                embeds.push(buildHistoricalUsageEmbed(title, embedColor, entry.date, entry));
            }
        }

        if (data.totals && embeds.length > 1) {
            const t = data.totals;
            const totalsEmbed = new EmbedBuilder()
                .setTitle("📊 Grand Total")
                .setColor(0xed4245)
                .setDescription(`**${formatCost(t.totalCost)}** across ${formatTokens(t.totalTokens)} tokens`)
                .addFields(
                    { name: "Input", value: formatTokens(t.inputTokens), inline: true },
                    { name: "Output", value: formatTokens(t.outputTokens), inline: true },
                    { name: "Cache", value: `W: ${formatTokens(t.cacheCreationTokens)} · R: ${formatTokens(t.cacheReadTokens)}`, inline: true },
                )
                .setTimestamp();
            embeds.push(totalsEmbed);
        }

        const embedChunks: EmbedBuilder[][] = [];
        for (let i = 0; i < embeds.length; i += 10) {
            embedChunks.push(embeds.slice(i, i + 10));
        }

        await msg.reply({ embeds: embedChunks[0] });
        for (let i = 1; i < embedChunks.length; i++) {
            await (msg.channel as TextChannel).send({ embeds: embedChunks[i] });
        }
    } catch (error: any) {
        console.error(`[Bot] ccusage error: ${error.message}`);
        const errorEmbed = new EmbedBuilder()
            .setTitle("❌ Usage Fetch Failed")
            .setColor(0xed4245)
            .setDescription("Failed to fetch usage data.")
            .addFields({ name: "Error", value: `\`\`\`${error.message.slice(0, 1000)}\`\`\`` })
            .setFooter({ text: "Make sure ccusage is available (npx ccusage@latest)" })
            .setTimestamp();
        await msg.reply({ embeds: [errorEmbed] });
    }
}
