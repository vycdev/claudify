import { Collection, type Attachment, type Message } from "discord.js";

/**
 * Exclude the entire message, including attachments/embeds, at message ingress.
 * All !codex subcommands (even malformed/unknown ones) and existing !auth
 * commands are private control traffic, not conversation. Match complete
 * command tokens, as the auth routers do; !authentic is ordinary text.
 */
export function isSensitiveAuthMessage(content: string): boolean {
    return /^\s*!(?:codex|auth)(?:\s|$)/i.test(content);
}

/**
 * Classify once and synchronously detach the message data used by model/storage
 * consumers. Discord patches cached Messages in place, including across awaits.
 * Never consume the original's content, embeds, attachments or reference after
 * this boundary. Methods and Discord service references stay usable for replies.
 */
export function snapshotConversationMessage(message: Message): Message | undefined {
    const content = message.content;
    if (isSensitiveAuthMessage(content)) return undefined;

    const attachments = new Collection<string, Attachment>();
    for (const [id, attachment] of message.attachments.size ? message.attachments : []) {
        // Copy entry data as well as the collection; entries can also be patched.
        attachments.set(id, cloneMessageData(attachment));
    }
    const embeds = message.embeds?.map(cloneMessageData) ?? [];

    // Own properties shadow the live Message, even when Discord later replaces
    // entire collections. Do not clone the circular client/channel/guild graph.
    return Object.create(message, {
        content: { value: content, enumerable: true },
        embeds: { value: embeds, enumerable: true },
        attachments: { value: attachments, enumerable: true },
        reference: { value: structuredClone(message.reference), enumerable: true },
        id: { value: message.id },
        author: { value: message.author },
        createdAt: { value: new Date(message.createdAt) },
        createdTimestamp: { value: message.createdTimestamp },
        channelId: { value: message.channelId },
        guildId: { value: message.guildId },
        channel: { value: message.channel },
        guild: { value: message.guild },
        client: { value: message.client },
    }) as Message;
}
// Only embed/attachment data, never the circular Discord Message graph. Copy
// Embed.data deeply (fields/footer/etc.), retaining the class getters and methods.
function cloneMessageData<T extends object>(data: T): T {
    return Object.assign(
        Object.create(Object.getPrototypeOf(data)) as T,
        structuredClone({ ...data }),
    );
}
