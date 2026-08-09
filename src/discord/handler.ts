import { Message, TextChannel, MessageReaction, User, PartialMessageReaction, PartialUser } from "discord.js";
import {
    REQUIRED_ROLE_ID,
    COOLDOWN_MS,
    LIVE_CONTEXT_LIMIT,
    DEEP_LIVE_CONTEXT_LIMIT,
    LIVE_CONTEXT_MAX_CHARS,
} from "../config.js";
import { client } from "./client.js";
import { normalizeBotMentions } from "./mentions.js";
import { parseClaudeResponse } from "./response.js";
import { handleStorage } from "./commands/storage.js";
import { handleUsage } from "./commands/usage.js";
import { handleGuild } from "./commands/guild.js";
import { handleProfile } from "./commands/profile.js";
import { handleHelp } from "./commands/help.js";
import { handleAuthTextMessage } from "./commands/auth.js";
import { parseAskCommand } from "./commands/ask.js";
import { askClaude } from "../askClaude.js";
import { appendToLog, isDeepHistoryRequest } from "../storage/history.js";
import { savePending, removePending } from "../storage/pending.js";
import { downloadAttachment } from "../storage/images.js";
import { backgroundProfileUpdate, backgroundServerMemoryUpdate } from "../storage/profiles.js";
import { ensureYesterdaySummaries } from "../storage/summaries.js";
import { smartSplit } from "./split.js";

// Consistent display name for a user — used in logs, prompts, and history
function authorLabel(user: { displayName?: string; globalName?: string | null; username: string; id: string }): string {
    if (user.id === client.user?.id) {
        const botName = client.user?.displayName || client.user?.username || "Claudify";
        return `${botName} (bot)`;
    }
    return user.globalName || user.displayName || user.username;
}

function summarizeEmbeds(msg: Message): string {
    if (msg.embeds.length === 0) return "";

    const embedSummary = msg.embeds
        .map((e) => {
            const parts: string[] = [];
            if (e.title) parts.push(e.title);
            if (e.description) parts.push(e.description);
            if (e.fields?.length) {
                parts.push(...e.fields.map((f) => `${f.name}: ${f.value}`));
            }
            return parts.join(": ");
        })
        .filter(Boolean)
        .join("; ");

    return embedSummary ? ` [Embed: ${embedSummary}]` : "";
}

function messageContentForMemory(msg: Message): string {
    let content = msg.content.trim();
    if (msg.attachments.size > 0) {
        content += `${content ? " " : ""}[${msg.attachments.size} attachment(s)]`;
    }
    content += summarizeEmbeds(msg);
    return content.trim();
}

function formatMessageForContext(msg: Message): string {
    const time = msg.createdAt.toTimeString().split(" ")[0];
    const label = authorLabel(msg.author);
    return `[${time}] ${label}: ${messageContentForMemory(msg) || "[no text]"}`;
}

async function fetchChannelMessages(channel: TextChannel, limit: number): Promise<Message[]> {
    const collected: Message[] = [];
    let before: string | undefined;

    while (collected.length < limit) {
        const batchLimit = Math.min(100, limit - collected.length);
        const batch = await channel.messages.fetch(
            before ? { limit: batchLimit, before } : { limit: batchLimit },
        );

        if (batch.size === 0) break;

        const messages = Array.from(batch.values());
        collected.push(...messages);
        const oldest = messages.reduce((currentOldest, message) =>
            message.createdTimestamp < currentOldest.createdTimestamp ? message : currentOldest,
        );
        before = oldest.id;

        if (batch.size < batchLimit) break;
    }

    return collected.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

export function formatLiveMessagesContext(
    messages: Message[],
    requestedLimit: number,
    maxChars: number,
): string {
    if (messages.length === 0 || maxChars <= 0) return "";

    let selected = [...messages];
    const buildText = (): string => {
        const oldest = selected[0]?.createdAt.toISOString() ?? "unknown";
        const newest = selected.at(-1)?.createdAt.toISOString() ?? "unknown";
        const omitted = messages.length - selected.length;
        const header =
            `Fetched ${selected.length} live message(s) from Discord, oldest=${oldest}, newest=${newest}, requested_limit=${requestedLimit}, omitted_oldest=${omitted}.`;
        return [
            header,
            ...selected.map(formatMessageForContext),
        ].join("\n");
    };

    let text = buildText();
    while (text.length > maxChars && selected.length > 0) {
        selected = selected.slice(1);
        text = buildText();
    }

    return text.slice(0, maxChars);
}

async function buildLiveMessagesContext(
    channel: TextChannel,
    question: string,
): Promise<{ text: string; messages: Message[] }> {
    const limit = isDeepHistoryRequest(question)
        ? DEEP_LIVE_CONTEXT_LIMIT
        : LIVE_CONTEXT_LIMIT;
    const messages = await fetchChannelMessages(channel, limit);

    if (messages.length === 0) return { text: "", messages };

    const text = formatLiveMessagesContext(
        messages,
        limit,
        LIVE_CONTEXT_MAX_CHARS,
    );

    return { text, messages };
}

function logIncomingMessage(msg: Message): void {
    const content = messageContentForMemory(msg);
    if (!content) return;
    appendToLog(
        authorLabel(msg.author),
        content,
        msg.channel.id,
        msg.channel instanceof TextChannel ? msg.channel.name : "unknown",
        msg.createdAt,
    );
}

async function enforceRequiredRole(msg: Message): Promise<boolean> {
    if (
        !REQUIRED_ROLE_ID ||
        msg.member?.roles.cache.has(REQUIRED_ROLE_ID)
    ) {
        return true;
    }

    console.error(
        `[Bot] Rejected: ${msg.author.tag} missing role ${REQUIRED_ROLE_ID}`,
    );
    await msg.reply(
        "You can't use this command because you don't have the required role.",
    );
    return false;
}

// Per-user message queue with cooldown
const MAX_QUEUED_PER_USER = 10;
const userQueues = new Map<string, Message[]>();
const userProcessing = new Set<string>();
const userCooldowns = new Map<string, number>();
const queueDrainTimers = new Map<string, ReturnType<typeof setTimeout>>();

function setCooldown(userId: string): void {
    userCooldowns.set(userId, Date.now());
}

function getCooldownRemaining(userId: string): number {
    const last = userCooldowns.get(userId);
    if (!last) return 0;
    return Math.max(0, COOLDOWN_MS - (Date.now() - last));
}

function enqueueUserMessage(msg: Message): boolean {
    const userId = msg.author.id;
    const queue = userQueues.get(userId) || [];
    if (queue.length >= MAX_QUEUED_PER_USER) {
        return false; // queue full
    }
    queue.push(msg);
    userQueues.set(userId, queue);
    return true;
}

function dequeueUserMessage(userId: string): Message | undefined {
    const queue = userQueues.get(userId);
    if (!queue || queue.length === 0) return undefined;
    const msg = queue.shift()!;
    if (queue.length === 0) userQueues.delete(userId);
    return msg;
}

function getUserQueueSize(userId: string): number {
    return userQueues.get(userId)?.length || 0;
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

export function registerHandler() {
    client.on("messageCreate", async (msg: Message) => {
        try {
            if (msg.author.bot) return;
            if (await handleAuthTextMessage(msg)) return;
            if (!(msg.channel instanceof TextChannel)) return;

            logIncomingMessage(msg);

            // Command routing
            const command = msg.content.trim();
            const isUsageCommand = /^!usage(?:\s|$)/.test(command);
            const isProfileCommand = /^!profile(?:\s|$)/.test(command);
            const isCommand =
                command === "!help" ||
                command === "!storage" ||
                isUsageCommand ||
                command === "!guild" ||
                isProfileCommand;

            if (isCommand && !(await enforceRequiredRole(msg))) return;

            if (command === "!help") {
                await handleHelp(msg);
                return;
            }

            if (command === "!storage") {
                await handleStorage(msg);
                return;
            }

            if (isUsageCommand) {
                await handleUsage(msg);
                return;
            }

            if (command === "!guild") {
                await handleGuild(msg);
                return;
            }

            if (isProfileCommand) {
                await handleProfile(msg);
                return;
            }

            // Check if this is a bot interaction
            const isMention = msg.mentions.has(client.user!);
            const isAskCommand = parseAskCommand(msg.content) !== null;
            const isReplyToBot = msg.reference?.messageId
                ? (
                      await msg.channel.messages
                          .fetch(msg.reference.messageId)
                          .catch(() => null)
                  )?.author?.id === client.user!.id
                : false;

            if (!isMention && !isAskCommand && !isReplyToBot) return;

            // Per-user queue — if queue is full, reject with ⏳
            if (getUserQueueSize(msg.author.id) >= MAX_QUEUED_PER_USER) {
                console.error(`[Bot] Queue full for ${msg.author.tag} (${MAX_QUEUED_PER_USER} queued)`);
                await msg.react("⏳").catch(() => {});
                return;
            }

            // If user is already being processed or on cooldown, queue the message
            if (userProcessing.has(msg.author.id) || getCooldownRemaining(msg.author.id) > 0) {
                enqueueUserMessage(msg);
                console.error(`[Bot] Queued message from ${msg.author.tag} (queue size: ${getUserQueueSize(msg.author.id)})`);
                await msg.react("📬").catch(() => {});
                if (!userProcessing.has(msg.author.id)) {
                    // Not currently processing, schedule drain after cooldown
                    scheduleQueueDrain(msg.author.id);
                }
                return;
            }

            await processMessage(msg);
        } catch (error: any) {
            console.error(
                `[Bot] Unhandled error in messageCreate: ${error.message}`,
            );
            console.error(error.stack);
        }
    });

    // Reaction trigger: respond to messages when someone adds a 🤖 reaction
    client.on("messageReactionAdd", async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
        let acquiredProcessing = false;
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

            // Enforce the same role restriction as message-based triggers
            if (REQUIRED_ROLE_ID) {
                let member;
                try {
                    member = await msg.guild.members.fetch({
                        user: user.id,
                        force: true,
                        cache: false,
                    });
                } catch (error: any) {
                    console.error(
                        `[Bot] Failed to verify role for reaction trigger by ${user.tag}: ${error.message}`,
                    );
                    return;
                }

                if (!member.roles.cache.has(REQUIRED_ROLE_ID)) {
                    console.error(
                        `[Bot] Rejected reaction trigger: ${user.tag} missing role ${REQUIRED_ROLE_ID}`,
                    );
                    return;
                }
            }

            // Serialize reaction and message triggers for the same user
            if (userProcessing.has(user.id) || getCooldownRemaining(user.id) > 0) {
                console.error(`[Bot] Reaction trigger busy or on cooldown for ${user.tag}`);
                return;
            }
            userProcessing.add(user.id);
            acquiredProcessing = true;

            console.error(`[Bot] 🤖 reaction trigger by ${user.tag} on message from ${msg.author?.tag} in #${msg.channel.name}`);

            const botName = client.user?.displayName || client.user?.username || "Claudify";
            const msgAuthorLabel = msg.author ? authorLabel(msg.author) : "someone";
            const userLabel = authorLabel(user as any);
            const question = `[${msgAuthorLabel} said this, and ${userLabel} wants you to respond to it]: ${msg.content}`;

            // Fetch live messages for context
            let liveMessages = "";
            try {
                const liveContext = await buildLiveMessagesContext(msg.channel, question);
                liveMessages = liveContext.text;
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

            let response: string;
            try {
                response = await askClaude(
                    question,
                    userLabel,
                    user.id,
                    msg.channel.name,
                    msg.channel.id,
                    msg.guild.name,
                    msg.guild.id,
                    imagePaths,
                    liveMessages,
                );
            } finally {
                clearInterval(typingInterval);
            }
            setCooldown(user.id);

            // Extract any [REACT:emoji] tags and apply them as reactions
            const parsedResponse = parseClaudeResponse(response);

            for (const emoji of parsedResponse.reactions) {
                await reactWithEmoji(msg, emoji);
            }

            if (parsedResponse.text) {
                const chunks = smartSplit(parsedResponse.text);
                for (const chunk of chunks) {
                    await msg.channel.send(chunk);
                }
            }

            appendToLog(
                userLabel,
                `[🤖 reaction on: ${msg.content?.slice(0, 100)}]`,
                msg.channel.id,
                msg.channel.name,
            );
            appendToLog(
                botName + " (bot)",
                parsedResponse.historyContent,
                msg.channel.id,
                msg.channel.name,
            );

            console.error(`[Bot] Reaction-triggered response sent successfully`);
        } catch (error: any) {
            console.error(`[Bot] Error in reaction handler: ${error.message}`);
        } finally {
            if (acquiredProcessing) {
                userProcessing.delete(user.id);
                if (getUserQueueSize(user.id) > 0) {
                    scheduleQueueDrain(user.id);
                }
            }
        }
    });
}

function scheduleQueueDrain(userId: string): void {
    if (queueDrainTimers.has(userId)) return;

    const remaining = getCooldownRemaining(userId);
    const delay = Math.max(remaining, 100);
    const timer = setTimeout(async () => {
        queueDrainTimers.delete(userId);

        // An active request will schedule the next drain in its finally block.
        if (userProcessing.has(userId)) return;

        // A stale timer may fire after another request restarted the cooldown.
        if (getCooldownRemaining(userId) > 0) {
            scheduleQueueDrain(userId);
            return;
        }

        const next = dequeueUserMessage(userId);
        if (next) {
            await processMessage(next);
        }
    }, delay);
    queueDrainTimers.set(userId, timer);
}

async function processMessage(msg: Message): Promise<void> {
    const userId = msg.author.id;
    userProcessing.add(userId);

    try {
        if (!(msg.channel instanceof TextChannel)) return;

        const askQuestion = parseAskCommand(msg.content);
        console.error(
            `[Bot] Processing message from ${msg.author.tag} in #${msg.channel.name}: ${msg.content.slice(0, 100)}`,
        );

        // Check role permission
        if (!(await enforceRequiredRole(msg))) return;

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
                replyContext = `[Replying to ${authorLabel(refMsg.author)}: "${refText}"]\n`;
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
        const rawQuestion = normalizeBotMentions(
            askQuestion ?? msg.content,
            client.user!.id,
            botName,
        ).trim();
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

        // Fetch live channel messages for context (reused later for participant collection)
        let liveMessages = "";
        let recentMessages: Message[] = [];
        try {
            const liveContext = await buildLiveMessagesContext(msg.channel as TextChannel, question);
            recentMessages = liveContext.messages;
            liveMessages = liveContext.text;
            console.error(`[Bot] Added ${recentMessages.length} live messages to context`);
        } catch (err: any) {
            console.error(`[Bot] Failed to fetch live messages: ${err.message}`);
        }

        let response: string;
        try {
            response = await askClaude(
                question,
                authorLabel(msg.author),
                msg.author.id,
                msg.channel.name,
                msg.channel.id,
                msg.guild?.name || "DM",
                msg.guild?.id || "unknown",
                imagePaths,
                liveMessages,
            );
        } finally {
            clearInterval(typingInterval);
        }
        setCooldown(userId);

        // Extract any [REACT:emoji] tags and apply them as reactions
        const parsedResponse = parseClaudeResponse(response);

        for (const emoji of parsedResponse.reactions) {
            console.error(`[Bot] Reacting with: ${emoji}`);
            await reactWithEmoji(msg, emoji);
        }

        if (!parsedResponse.text) {
            if (parsedResponse.reactions.length > 0) {
                appendToLog(
                    botName + " (bot)",
                    parsedResponse.historyContent,
                    msg.channel.id,
                    msg.channel.name,
                );
            }
            return;
        }

        console.error(
            `[Bot] Sending response (${parsedResponse.text.length} chars) to #${msg.channel.name}`,
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

        const chunks = smartSplit(parsedResponse.text);
        for (let i = 0; i < chunks.length; i++) {
            await safeSend(chunks[i], i === 0);
        }

        console.error(`[Bot] Response sent successfully`);

        appendToLog(
            botName + " (bot)",
            parsedResponse.historyContent,
            msg.channel.id,
            msg.channel.name,
        );

        // Background jobs
        const conversationContext = liveMessages || `${authorLabel(msg.author)}: ${rawQuestion}\n${botName} (bot): ${response}`;

        const participantUsers: { tag: string; id: string }[] = [];
        if (recentMessages.length > 0) {
            for (const m of recentMessages) {
                if (!m.author.bot) {
                    participantUsers.push({
                        tag: authorLabel(m.author),
                        id: m.author.id,
                    });
                }
            }
        } else {
            participantUsers.push({ tag: authorLabel(msg.author), id: msg.author.id });
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
            `[Bot] Error processing message: ${error.message}`,
        );
        console.error(error.stack);
        try {
            await msg.reply(
                "Sorry, something went wrong while processing your request.",
            );
        } catch {
            /* ignore reply failure */
        }
    } finally {
        try {
            removePending(msg.id);
        } catch (error: any) {
            console.error(
                `[Bot] Failed to remove pending message ${msg.id}: ${error.message}`,
            );
        }
        userProcessing.delete(userId);
        // Drain next queued message for this user after cooldown
        if (getUserQueueSize(userId) > 0) {
            scheduleQueueDrain(userId);
        }
    }
}
