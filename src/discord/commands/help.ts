import { Message } from "discord.js";
import {
    AUTH_ADMIN_USER_IDS,
    COOLDOWN_MS,
    getResponseModelDisplay,
} from "../../config.js";
import { client } from "../client.js";

export async function handleHelp(msg: Message): Promise<void> {
    const botName =
        client.user?.displayName || client.user?.username || "Claudify";
    const cooldownSec = Math.round(COOLDOWN_MS / 1000);

    const help = [
        `**${botName}** — powered by \`${getResponseModelDisplay()}\``,
        ``,
        `**Triggers**`,
        `\`!ask <question>\` — Ask me anything`,
        `\`@${botName}\` — Mention me with a question`,
        `Reply to my messages — I'll respond to follow-ups`,
        `React with 🤖 — React to any message to make me respond to it`,
        ``,
        `**Commands**`,
        `\`!help\` — This message`,
        `\`!usage [today|week|month|daily|blocks|monthly]\` — Token usage stats (\`month\` is current; \`monthly\` is history)`,
        `\`!profile [@user]\` — View a user's profile`,
        `\`!guild\` — View server memory`,
        `\`!storage\` — Storage stats`,
        ...(AUTH_ADMIN_USER_IDS.has(msg.author.id)
            ? [
                  ``,
                  `**Owner administration**`,
                  `DM me \`!auth help\` — Manage Claude CLI authentication privately`,
              ]
            : []),
        ``,
        `**Notes**`,
        `• ${cooldownSec}s cooldown between responses per user`,
        `• I can search the web, read files, react to messages, and send messages to other channels`,
        `• If I don't think a message needs a reply, I'll just leave a reaction`,
    ].join("\n");

    await msg.reply(help);
}
