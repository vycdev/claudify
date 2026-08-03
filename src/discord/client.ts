import { Client, GatewayIntentBits, Partials } from "discord.js";
import { SUPPRESS_MENTIONS } from "../config.js";

export const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [
        Partials.Channel,
        Partials.Message,
        Partials.Reaction,
    ],
    allowedMentions: SUPPRESS_MENTIONS ? { parse: [] } : undefined,
});
