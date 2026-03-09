import { spawn } from "child_process";
import { Message, TextChannel, EmbedBuilder } from "discord.js";

export async function handleUsage(msg: Message): Promise<void> {
    const args = msg.content.trim().split(/\s+/).slice(1);
    const subcommand = args[0] || "today";

    let ccArgs: string[];
    let title: string;
    let embedColor: number;
    const today = new Date().toISOString().split("T")[0].replace(/-/g, "");

    switch (subcommand) {
        case "today":
            ccArgs = ["ccusage@latest", "daily", "--json", "--since", today];
            title = "📊 Today's Usage";
            embedColor = 0x5865f2;
            break;
        case "daily":
            ccArgs = ["ccusage@latest", "daily", "--json"];
            title = "📅 Daily Usage";
            embedColor = 0x57f287;
            break;
        case "blocks":
            ccArgs = ["ccusage@latest", "blocks", "--json", "--since", today];
            title = "⏱️ Billing Windows (Today)";
            embedColor = 0xfee75c;
            break;
        case "monthly":
            ccArgs = ["ccusage@latest", "monthly", "--json"];
            title = "📆 Monthly Usage";
            embedColor = 0xeb459e;
            break;
        default:
            const helpEmbed = new EmbedBuilder()
                .setTitle("📊 Usage Command Help")
                .setColor(0x5865f2)
                .setDescription("View Claude API token usage and costs.")
                .addFields(
                    { name: "`!usage today`", value: "Today's breakdown by model *(default)*", inline: true },
                    { name: "`!usage daily`", value: "Daily breakdown over time", inline: true },
                    { name: "`!usage blocks`", value: "5-hour billing windows for today", inline: true },
                    { name: "`!usage monthly`", value: "Monthly totals and trends", inline: true },
                )
                .setFooter({ text: "Powered by ccusage" });
            await msg.reply({ embeds: [helpEmbed] });
            return;
    }

    await (msg.channel as TextChannel).sendTyping();

    const formatCost = (c: number) => c >= 1 ? `$${c.toFixed(2)}` : `$${c.toFixed(4)}`;
    const formatTokens = (t: number) =>
        t >= 1_000_000_000 ? `${(t / 1_000_000_000).toFixed(2)}B`
        : t >= 1_000_000 ? `${(t / 1_000_000).toFixed(2)}M`
        : t >= 1_000 ? `${(t / 1_000).toFixed(1)}K`
        : `${t}`;
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
    const shortModel = (name: string) => {
        return name
            .replace("claude-", "")
            .replace(/-\d{8}$/, "");
    };

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
                const startStr = start.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
                const endStr = end.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });

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
        } else if (subcommand === "monthly") {
            for (const entry of data.monthly || []) {
                const embed = new EmbedBuilder()
                    .setTitle(`${title} — ${entry.month}`)
                    .setColor(embedColor);

                embed.setDescription(
                    `**Total Cost: ${formatCost(entry.totalCost)}** · ${formatTokens(entry.totalTokens)} tokens`
                );

                let tokenDetail = "```\n";
                tokenDetail += `Input:        ${formatTokens(entry.inputTokens).padStart(10)}\n`;
                tokenDetail += `Output:       ${formatTokens(entry.outputTokens).padStart(10)}\n`;
                tokenDetail += `Cache write:  ${formatTokens(entry.cacheCreationTokens).padStart(10)}\n`;
                tokenDetail += `Cache read:   ${formatTokens(entry.cacheReadTokens).padStart(10)}\n`;
                tokenDetail += "```";
                embed.addFields({ name: "🔢 Token Breakdown", value: tokenDetail, inline: false });

                const maxCost = Math.max(...(entry.modelBreakdowns || []).map((m: any) => m.cost));
                for (const m of entry.modelBreakdowns || []) {
                    const pct = entry.totalCost > 0 ? ((m.cost / entry.totalCost) * 100).toFixed(1) : "0";
                    const bar = progressBar(m.cost, maxCost, 12);
                    let detail = `\`${bar}\` **${formatCost(m.cost)}** (${pct}%)\n`;
                    detail += `In: ${formatTokens(m.inputTokens)} · Out: ${formatTokens(m.outputTokens)}`;
                    if (m.cacheCreationTokens > 0 || m.cacheReadTokens > 0) {
                        detail += `\nCache W: ${formatTokens(m.cacheCreationTokens)} · Cache R: ${formatTokens(m.cacheReadTokens)}`;
                    }
                    embed.addFields({
                        name: `${modelEmoji(m.modelName)} ${shortModel(m.modelName)}`,
                        value: detail,
                        inline: false,
                    });
                }

                embed.setTimestamp();
                embeds.push(embed);
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
                const embed = new EmbedBuilder()
                    .setTitle(`${title} — ${entry.date}`)
                    .setColor(embedColor);

                embed.setDescription(
                    `**Total Cost: ${formatCost(entry.totalCost)}** · ${formatTokens(entry.totalTokens)} tokens`
                );

                let tokenDetail = "```\n";
                tokenDetail += `Input:        ${formatTokens(entry.inputTokens).padStart(10)}\n`;
                tokenDetail += `Output:       ${formatTokens(entry.outputTokens).padStart(10)}\n`;
                tokenDetail += `Cache write:  ${formatTokens(entry.cacheCreationTokens).padStart(10)}\n`;
                tokenDetail += `Cache read:   ${formatTokens(entry.cacheReadTokens).padStart(10)}\n`;
                tokenDetail += "```";
                embed.addFields({ name: "🔢 Token Breakdown", value: tokenDetail, inline: false });

                const maxCost = Math.max(...(entry.modelBreakdowns || []).map((m: any) => m.cost));
                for (const m of entry.modelBreakdowns || []) {
                    const pct = entry.totalCost > 0 ? ((m.cost / entry.totalCost) * 100).toFixed(1) : "0";
                    const bar = progressBar(m.cost, maxCost, 12);
                    let detail = `\`${bar}\` **${formatCost(m.cost)}** (${pct}%)\n`;
                    detail += `In: ${formatTokens(m.inputTokens)} · Out: ${formatTokens(m.outputTokens)}`;
                    if (m.cacheCreationTokens > 0 || m.cacheReadTokens > 0) {
                        detail += `\nCache W: ${formatTokens(m.cacheCreationTokens)} · Cache R: ${formatTokens(m.cacheReadTokens)}`;
                    }
                    embed.addFields({
                        name: `${modelEmoji(m.modelName)} ${shortModel(m.modelName)}`,
                        value: detail,
                        inline: false,
                    });
                }

                embed.setTimestamp();
                embeds.push(embed);
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
