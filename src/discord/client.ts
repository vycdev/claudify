import { Client, GatewayIntentBits } from "discord.js";
import { SUPPRESS_MENTIONS } from "../config.js";

export const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
    ],
    allowedMentions: SUPPRESS_MENTIONS ? { parse: [] } : undefined,
});
