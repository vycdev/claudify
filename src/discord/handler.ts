import { Message, TextChannel } from "discord.js";
import { REQUIRED_ROLE_ID } from "../config.js";
import { client } from "./client.js";
import { handleStorage } from "./commands/storage.js";
import { handleUsage } from "./commands/usage.js";
import { handleGuild } from "./commands/guild.js";
import { handleProfile } from "./commands/profile.js";
import { askClaude } from "../askClaude.js";
import { appendToLog } from "../storage/history.js";
import { savePending, removePending } from "../storage/pending.js";
import { downloadAttachment } from "../storage/images.js";
import { backgroundProfileUpdate, backgroundServerMemoryUpdate } from "../storage/profiles.js";
import { ensureYesterdaySummaries } from "../storage/summaries.js";

export function registerHandler() {
    client.on("messageCreate", async (msg: Message) => {
        try {
            if (msg.author.bot) return;
            if (!(msg.channel instanceof TextChannel)) return;

            // Command routing
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

            if (response.length <= 2000) {
                await safeSend(response, true);
            } else {
                const chunks: string[] = [];
                let current = "";
                for (const line of response.split("\n")) {
                    if (current.length + line.length + 1 > 2000) {
                        chunks.push(current);
                        current = line;
                    } else {
                        current += (current ? "\n" : "") + line;
                    }
                }
                if (current) chunks.push(current);
                for (const chunk of chunks) {
                    await safeSend(chunk, false);
                }
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

            // Background jobs
            backgroundProfileUpdate(
                msg.author.tag,
                msg.author.id,
                rawQuestion,
                response,
            ).catch(() => {});
            if (msg.guild) {
                backgroundServerMemoryUpdate(
                    msg.guild.id,
                    msg.guild.name,
                    msg.channel.name,
                    msg.author.tag,
                    rawQuestion,
                    response,
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
}
