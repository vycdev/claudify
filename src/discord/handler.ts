import { Message, TextChannel, MessageReaction, User, PartialMessageReaction, PartialUser } from "discord.js";
import { REQUIRED_ROLE_ID, COOLDOWN_MS } from "../config.js";
import { client } from "./client.js";
import { handleStorage } from "./commands/storage.js";
import { handleUsage } from "./commands/usage.js";
import { handleGuild } from "./commands/guild.js";
import { handleProfile } from "./commands/profile.js";
import { handleHelp } from "./commands/help.js";
import { askClaude } from "../askClaude.js";
import { appendToLog } from "../storage/history.js";
import { savePending, removePending } from "../storage/pending.js";
import { downloadAttachment } from "../storage/images.js";
import { backgroundProfileUpdate, backgroundServerMemoryUpdate } from "../storage/profiles.js";
import { ensureYesterdaySummaries } from "../storage/summaries.js";

// Per-user cooldown tracking
const userCooldowns = new Map<string, number>();

function isOnCooldown(userId: string): boolean {
    const last = userCooldowns.get(userId);
    if (!last) return false;
    return Date.now() - last < COOLDOWN_MS;
}

function setCooldown(userId: string): void {
    userCooldowns.set(userId, Date.now());
}

function getRemainingCooldown(userId: string): number {
    const last = userCooldowns.get(userId);
    if (!last) return 0;
    return Math.max(0, Math.ceil((COOLDOWN_MS - (Date.now() - last)) / 1000));
}

// React to a message with either a unicode emoji or a custom guild emoji by name
async function reactWithEmoji(msg: Message, emoji: string): Promise<void> {
    try {
        await msg.react(emoji);
    } catch {
        // If unicode react failed, try finding a custom guild emoji by name
        const guild = msg.guild;
        if (guild) {
            const customEmoji = guild.emojis.cache.find(
                (e) => e.name?.toLowerCase() === emoji.toLowerCase(),
            );
            if (customEmoji) {
                try {
                    await msg.react(customEmoji);
                    return;
                } catch { /* fall through */ }
            }
        }
        // Final fallback
        console.error(`[Bot] Failed to react with "${emoji}", using 👍 fallback`);
        await msg.react("👍").catch(() => {});
    }
}

// Smart message splitting that respects code blocks and paragraph boundaries
function smartSplit(text: string, maxLen: number = 2000): string[] {
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
            chunks.push(remaining);
            break;
        }

        let splitAt = -1;
        const slice = remaining.slice(0, maxLen);

        // Count open code blocks in this slice to avoid splitting inside one
        const codeBlockMatches = slice.match(/```/g);
        const insideCodeBlock = codeBlockMatches && codeBlockMatches.length % 2 !== 0;

        if (insideCodeBlock) {
            // Find the last ``` opening before maxLen and split before it
            const lastCodeBlockStart = slice.lastIndexOf("```");
            if (lastCodeBlockStart > 0) {
                // Look for a newline before the code block
                const newlineBefore = slice.lastIndexOf("\n", lastCodeBlockStart);
                splitAt = newlineBefore > 0 ? newlineBefore : lastCodeBlockStart;
            }
        }

        if (splitAt === -1) {
            // Try splitting at double newline (paragraph boundary)
            const doubleNewline = slice.lastIndexOf("\n\n");
            if (doubleNewline > maxLen * 0.3) {
                splitAt = doubleNewline;
            }
        }

        if (splitAt === -1) {
            // Try splitting at single newline
            const singleNewline = slice.lastIndexOf("\n");
            if (singleNewline > maxLen * 0.3) {
                splitAt = singleNewline;
            }
        }

        if (splitAt === -1) {
            // Last resort: split at space
            const space = slice.lastIndexOf(" ");
            splitAt = space > maxLen * 0.3 ? space : maxLen;
        }

        chunks.push(remaining.slice(0, splitAt).trimEnd());
        remaining = remaining.slice(splitAt).trimStart();
    }

    return chunks.filter((c) => c.length > 0);
}

export function registerHandler() {
    client.on("messageCreate", async (msg: Message) => {
        try {
            if (msg.author.bot) return;
            if (!(msg.channel instanceof TextChannel)) return;

            // Command routing
            if (msg.content.trim() === "!help") {
                await handleHelp(msg);
                return;
            }

            if (msg.content.trim() === "!storage") {
                await handleStorage(msg);
                return;
            }

            if (msg.content.trim().startsWith("!usage")) {
                await handleUsage(msg);
                return;
            }

            if (msg.content.trim() === "!guild") {
                await handleGuild(msg);
                return;
            }

            if (msg.content.trim().startsWith("!profile")) {
                await handleProfile(msg);
                return;
            }

            // Check if this is a bot interaction
            const isMention = msg.mentions.has(client.user!);
            const isAskCommand = msg.content.startsWith("!ask ");
            const isReplyToBot = msg.reference?.messageId
                ? (
                      await msg.channel.messages
                          .fetch(msg.reference.messageId)
                          .catch(() => null)
                  )?.author?.id === client.user!.id
                : false;

            if (!isMention && !isAskCommand && !isReplyToBot) return;

            // Per-user cooldown check
            if (isOnCooldown(msg.author.id)) {
                const remaining = getRemainingCooldown(msg.author.id);
                console.error(`[Bot] Cooldown active for ${msg.author.tag} (${remaining}s remaining)`);
                await msg.react("⏳").catch(() => {});
                return;
            }

            const triggerType = isAskCommand
                ? "!ask"
                : isReplyToBot
                  ? "reply"
                  : "@mention";
            console.error(
                `[Bot] Received ${triggerType} from ${msg.author.tag} in #${(msg.channel as TextChannel).name}: ${msg.content}`,
            );

            // Check role permission
            if (
                REQUIRED_ROLE_ID &&
                msg.member &&
                !msg.member.roles.cache.has(REQUIRED_ROLE_ID)
            ) {
                console.error(
                    `[Bot] Rejected: ${msg.author.tag} missing role ${REQUIRED_ROLE_ID}`,
                );
                await msg.reply(
                    "You can't use this command because you don't have the required role.",
                );
                return;
            }

            // Fetch referenced message if this is a reply
            let replyContext = "";
            const allAttachments: { url: string; name: string }[] = [];
            if (msg.reference?.messageId) {
                const refMsg = await msg.channel.messages
                    .fetch(msg.reference.messageId)
                    .catch(() => null);
                if (refMsg) {
                    let refText = refMsg.content;
                    if (refMsg.embeds.length > 0) {
                        const embedTexts = refMsg.embeds
                            .map((e) => {
                                const parts: string[] = [];
                                if (e.title) parts.push(e.title);
                                if (e.description) parts.push(e.description);
                                if (e.fields?.length)
                                    parts.push(
                                        ...e.fields.map(
                                            (f) => `${f.name}: ${f.value}`,
                                        ),
                                    );
                                if (e.footer?.text) parts.push(e.footer.text);
                                return parts.join("\n");
                            })
                            .filter((t) => t);
                        if (embedTexts.length > 0) {
                            refText +=
                                (refText ? "\n" : "") +
                                "[Embeds]\n" +
                                embedTexts.join("\n---\n");
                        }
                    }
                    replyContext = `[Replying to ${refMsg.author.tag}: "${refText}"]\n`;
                    console.error(
                        `[Bot] Reply context from ${refMsg.author.tag}: ${refText.slice(0, 200)}`,
                    );
                    for (const att of refMsg.attachments.values()) {
                        if (att.contentType?.startsWith("image/")) {
                            allAttachments.push({
                                url: att.url,
                                name: `ref_${att.id}_${att.name || "image.png"}`,
                            });
                        }
                    }
                }
            }

            // Collect attachments from current message
            for (const att of msg.attachments.values()) {
                if (att.contentType?.startsWith("image/")) {
                    allAttachments.push({
                        url: att.url,
                        name: `${att.id}_${att.name || "image.png"}`,
                    });
                }
            }

            // Extract the question
            const botName =
                client.user?.displayName || client.user?.username || "Claudify";
            const rawQuestion = isAskCommand
                ? msg.content.slice(5).trim()
                : msg.content.replace(`<@${client.user!.id}>`, botName).trim();
            const question = replyContext + rawQuestion;

            if (!rawQuestion) {
                console.error(`[Bot] Empty question from ${msg.author.tag}`);
                await msg.reply(
                    "Please provide a question! Usage: `!ask <your question>` or mention me with a question.",
                );
                return;
            }

            console.error(
                `[Bot] Processing question: "${question}" (${allAttachments.length} images)`,
            );

            savePending(msg);

            // Download attachments
            const imagePaths: string[] = [];
            for (const att of allAttachments) {
                try {
                    const filePath = await downloadAttachment(att.url, att.name);
                    imagePaths.push(filePath);
                    console.error(`[Bot] Downloaded image: ${att.name}`);
                } catch (err: any) {
                    console.error(
                        `[Bot] Failed to download image ${att.name}: ${err.message}`,
                    );
                }
            }

            // Show typing indicator
            await msg.channel.sendTyping();
            const typingInterval = setInterval(() => {
                (msg.channel as TextChannel).sendTyping().catch(() => {});
            }, 8000);

            // Fetch live channel messages for context
            let liveMessages = "";
            try {
                const recent = await (msg.channel as TextChannel).messages.fetch({ limit: 25 });
                const sorted = Array.from(recent.values()).reverse();
                liveMessages = sorted.map((m) => {
                    const time = m.createdAt.toTimeString().split(" ")[0];
                    const authorLabel = m.author.id === client.user!.id
                        ? `${botName} (bot)`
                        : m.author.displayName || m.author.username;
                    let content = m.content;
                    if (m.attachments.size > 0) {
                        content += ` [${m.attachments.size} attachment(s)]`;
                    }
                    if (m.embeds.length > 0) {
                        const embedSummary = m.embeds
                            .map((e) => [e.title, e.description].filter(Boolean).join(": "))
                            .filter(Boolean)
                            .join("; ");
                        if (embedSummary) content += ` [Embed: ${embedSummary}]`;
                    }
                    return `[${time}] ${authorLabel}: ${content}`;
                }).join("\n");
            } catch (err: any) {
                console.error(`[Bot] Failed to fetch live messages: ${err.message}`);
            }

            const response = await askClaude(
                question,
                msg.author.tag,
                msg.author.id,
                msg.channel.name,
                msg.guild?.name || "DM",
                msg.guild?.id || "unknown",
                imagePaths,
                liveMessages,
            );

            clearInterval(typingInterval);
            setCooldown(msg.author.id);

            // Check if Claude chose to just react instead of responding
            const reactMatch = response.match(/^\[REACT:(.+?)\]\s*$/);
            if (reactMatch) {
                const emoji = reactMatch[1].trim();
                console.error(`[Bot] React-only response with: ${emoji}`);
                await reactWithEmoji(msg, emoji);
                removePending(msg.id);
                return;
            }

            console.error(
                `[Bot] Sending response (${response.length} chars) to #${msg.channel.name}`,
            );

            const safeSend = async (text: string, reply: boolean) => {
                if (reply) {
                    try {
                        await msg.reply(text);
                    } catch {
                        await (msg.channel as TextChannel).send(text);
                    }
                } else {
                    await (msg.channel as TextChannel).send(text);
                }
            };

            const chunks = smartSplit(response);
            for (let i = 0; i < chunks.length; i++) {
                await safeSend(chunks[i], i === 0);
            }

            console.error(`[Bot] Response sent successfully`);

            appendToLog(
                msg.author.tag,
                rawQuestion,
                msg.channel.name,
                msg.createdAt,
            );
            appendToLog(botName + " (bot)", response, msg.channel.name);

            removePending(msg.id);

            // Background jobs — use live messages as context for all participants
            const conversationContext = liveMessages || `${msg.author.tag}: ${rawQuestion}\n${botName} (bot): ${response}`;

            // Collect all human users from the live messages
            const participantUsers: { tag: string; id: string }[] = [];
            try {
                const recent = await (msg.channel as TextChannel).messages.fetch({ limit: 25 });
                for (const m of recent.values()) {
                    if (!m.author.bot) {
                        participantUsers.push({
                            tag: m.author.tag,
                            id: m.author.id,
                        });
                    }
                }
            } catch {
                // Fallback to just the triggering user
                participantUsers.push({ tag: msg.author.tag, id: msg.author.id });
            }

            backgroundProfileUpdate(
                participantUsers,
                conversationContext,
            ).catch(() => {});
            if (msg.guild) {
                backgroundServerMemoryUpdate(
                    msg.guild.id,
                    msg.guild.name,
                    msg.channel.name,
                    conversationContext,
                ).catch(() => {});
            }
            ensureYesterdaySummaries().catch(() => {});
        } catch (error: any) {
            console.error(
                `[Bot] Unhandled error in messageCreate: ${error.message}`,
            );
            console.error(error.stack);
            try {
                await msg.reply(
                    "Sorry, something went wrong while processing your request.",
                );
            } catch {
                /* ignore reply failure */
            }
        }
    });

    // Reaction trigger: respond to messages when someone adds a 🤖 reaction
    client.on("messageReactionAdd", async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
        try {
            // Fetch partial reaction/message if needed
            if (reaction.partial) {
                try { await reaction.fetch(); } catch { return; }
            }
            if (reaction.message.partial) {
                try { await reaction.message.fetch(); } catch { return; }
            }

            // Only respond to 🤖 emoji
            if (reaction.emoji.name !== "🤖") return;

            // Ignore bot reactions
            if (user.bot) return;

            const msg = reaction.message as Message;
            if (!(msg.channel instanceof TextChannel)) return;
            if (!msg.guild) return;

            // Don't respond to reactions on bot's own messages
            if (msg.author?.id === client.user!.id) return;

            // Cooldown check for the reacting user
            if (isOnCooldown(user.id)) {
                console.error(`[Bot] Reaction trigger cooldown for ${user.tag}`);
                return;
            }

            console.error(`[Bot] 🤖 reaction trigger by ${user.tag} on message from ${msg.author?.tag} in #${msg.channel.name}`);

            const botName = client.user?.displayName || client.user?.username || "Claudify";
            const question = `[${msg.author?.tag} said this, and ${user.tag} wants you to respond to it]: ${msg.content}`;

            // Fetch live messages for context
            let liveMessages = "";
            try {
                const recent = await msg.channel.messages.fetch({ limit: 25 });
                const sorted = Array.from(recent.values()).reverse();
                liveMessages = sorted.map((m) => {
                    const time = m.createdAt.toTimeString().split(" ")[0];
                    const authorLabel = m.author.id === client.user!.id
                        ? `${botName} (bot)`
                        : m.author.displayName || m.author.username;
                    let content = m.content;
                    if (m.attachments.size > 0) content += ` [${m.attachments.size} attachment(s)]`;
                    if (m.embeds.length > 0) {
                        const embedSummary = m.embeds
                            .map((e) => [e.title, e.description].filter(Boolean).join(": "))
                            .filter(Boolean)
                            .join("; ");
                        if (embedSummary) content += ` [Embed: ${embedSummary}]`;
                    }
                    return `[${time}] ${authorLabel}: ${content}`;
                }).join("\n");
            } catch { /* ignore */ }

            // Download images from the reacted message
            const imagePaths: string[] = [];
            for (const att of msg.attachments.values()) {
                if (att.contentType?.startsWith("image/")) {
                    try {
                        const filePath = await downloadAttachment(att.url, `${att.id}_${att.name || "image.png"}`);
                        imagePaths.push(filePath);
                    } catch { /* ignore */ }
                }
            }

            await msg.channel.sendTyping();
            const typingInterval = setInterval(() => {
                (msg.channel as TextChannel).sendTyping().catch(() => {});
            }, 8000);

            const response = await askClaude(
                question,
                user.tag || "Unknown",
                user.id,
                msg.channel.name,
                msg.guild.name,
                msg.guild.id,
                imagePaths,
                liveMessages,
            );

            clearInterval(typingInterval);
            setCooldown(user.id);

            // Check for react-only response
            const reactMatch = response.match(/^\[REACT:(.+?)\]\s*$/);
            if (reactMatch) {
                const emoji = reactMatch[1].trim();
                await reactWithEmoji(msg, emoji);
                return;
            }

            const chunks = smartSplit(response);
            for (const chunk of chunks) {
                await msg.channel.send(chunk);
            }

            appendToLog(user.tag || "Unknown", `[🤖 reaction on: ${msg.content?.slice(0, 100)}]`, msg.channel.name);
            appendToLog(botName + " (bot)", response, msg.channel.name);

            console.error(`[Bot] Reaction-triggered response sent successfully`);
        } catch (error: any) {
            console.error(`[Bot] Error in reaction handler: ${error.message}`);
        }
    });
}
