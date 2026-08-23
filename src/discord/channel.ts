import { TextChannel, ThreadChannel } from "discord.js";

export type BotMessageChannel = TextChannel | ThreadChannel;

export function isBotMessageChannel(
    channel: unknown,
): channel is BotMessageChannel {
    return channel instanceof TextChannel || channel instanceof ThreadChannel;
}
