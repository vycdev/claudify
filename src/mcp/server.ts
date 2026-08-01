import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TextChannel } from "discord.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import {
    DISCORD_MESSAGE_MAX_CHARS,
    HISTORY_DIR,
    PENDING_DIR,
} from "../config.js";
import { client } from "../discord/client.js";
import { findChannel } from "../discord/helpers.js";
import { downloadAttachment } from "../storage/images.js";

const ReactToMessageSchema = z.object({
    server: z
        .string()
        .optional()
        .describe("Server name or ID (optional if bot is only in one server)"),
    channel: z.string().describe('Channel name (e.g., "general") or ID'),
    messageId: z.string().describe("The Discord message ID to react to"),
    emoji: z.string().describe('Emoji to react with — unicode emoji (e.g. "👍") or custom guild emoji name (e.g. "pepeclap")'),
});

function isWithinDiscordMessageLimit(message: string): boolean {
    let characters = 0;
    for (const _character of message) {
        characters += 1;
        if (characters > DISCORD_MESSAGE_MAX_CHARS) return false;
    }
    return true;
}

export const SendMessageSchema = z.object({
    server: z
        .string()
        .optional()
        .describe("Server name or ID (optional if bot is only in one server)"),
    channel: z.string().describe('Channel name (e.g., "general") or ID'),
    message: z
        .string()
        .min(1)
        .refine(
            isWithinDiscordMessageLimit,
            `String must contain at most ${DISCORD_MESSAGE_MAX_CHARS} character(s)`,
        ),
});

const ReadMessagesSchema = z.object({
    server: z
        .string()
        .optional()
        .describe("Server name or ID (optional if bot is only in one server)"),
    channel: z.string().describe('Channel name (e.g., "general") or ID'),
    limit: z.number().min(1).max(100).default(50),
});

const ReadMessageHistorySchema = z.object({
    limit: z.number().min(1).max(100).default(20),
    type: z.enum(["history", "pending"]).default("history"),
    channel: z.string().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    search: z.string().min(1).optional(),
    maxLines: z.number().min(1).max(2000).default(300),
});

export function createMcpServer(): Server {
    const mcpServer = new Server(
        { name: "discord", version: "1.0.0" },
        { capabilities: { tools: {} } },
    );

    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "send-message",
                description: "Send a message to a Discord channel",
                inputSchema: {
                    type: "object" as const,
                    properties: {
                        server: {
                            type: "string",
                            description:
                                "Server name or ID (optional if bot is only in one server)",
                        },
                        channel: {
                            type: "string",
                            description: 'Channel name (e.g., "general") or ID',
                        },
                        message: {
                            type: "string",
                            description: "Message content to send",
                            minLength: 1,
                            maxLength: DISCORD_MESSAGE_MAX_CHARS,
                        },
                    },
                    required: ["channel", "message"],
                },
            },
            {
                name: "react-to-message",
                description:
                    "React to a Discord message with an emoji (unicode or custom guild emoji)",
                inputSchema: {
                    type: "object" as const,
                    properties: {
                        server: {
                            type: "string",
                            description:
                                "Server name or ID (optional if bot is only in one server)",
                        },
                        channel: {
                            type: "string",
                            description: 'Channel name (e.g., "general") or ID',
                        },
                        messageId: {
                            type: "string",
                            description: "The Discord message ID to react to",
                        },
                        emoji: {
                            type: "string",
                            description:
                                'Emoji to react with — unicode emoji (e.g. "👍") or custom guild emoji name (e.g. "pepeclap")',
                        },
                    },
                    required: ["channel", "messageId", "emoji"],
                },
            },
            {
                name: "read-message-history",
                description:
                    "Read saved channel history files from disk. Use channel/date/search for older context and recaps.",
                inputSchema: {
                    type: "object" as const,
                    properties: {
                        limit: {
                            type: "number",
                            description:
                                "Number of matching history files to read (default 20)",
                            default: 20,
                        },
                        type: {
                            type: "string",
                            enum: ["history", "pending"],
                            description: "Read from history or pending",
                            default: "history",
                        },
                        channel: {
                            type: "string",
                            description:
                                "Optional channel name to narrow history files",
                        },
                        date: {
                            type: "string",
                            description:
                                "Optional date in YYYY-MM-DD format",
                        },
                        search: {
                            type: "string",
                            description:
                                "Optional case-insensitive text filter",
                        },
                        maxLines: {
                            type: "number",
                            description:
                                "Maximum lines returned per file (default 300, max 2000)",
                            default: 300,
                        },
                    },
                },
            },
            {
                name: "fetch-messages",
                description:
                    "Fetch specific Discord messages by their message links (e.g. https://discord.com/channels/SERVER_ID/CHANNEL_ID/MESSAGE_ID)",
                inputSchema: {
                    type: "object" as const,
                    properties: {
                        links: {
                            type: "array",
                            items: { type: "string" },
                            description:
                                "Array of Discord message links to fetch",
                        },
                    },
                    required: ["links"],
                },
            },
            {
                name: "read-messages",
                description:
                    "Read recent messages from a Discord channel (live from Discord API)",
                inputSchema: {
                    type: "object" as const,
                    properties: {
                        server: {
                            type: "string",
                            description:
                                "Server name or ID (optional if bot is only in one server)",
                        },
                        channel: {
                            type: "string",
                            description: 'Channel name (e.g., "general") or ID',
                        },
                        limit: {
                            type: "number",
                            description:
                                "Number of messages to fetch (max 100)",
                            default: 50,
                        },
                    },
                    required: ["channel"],
                },
            },
        ],
    }));

    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        try {
            switch (name) {
                case "send-message": {
                    const { server, channel: channelIdentifier, message } =
                        SendMessageSchema.parse(args);
                    const channel = await findChannel(channelIdentifier, server);
                    const sent = await channel.send(message);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Message sent to #${channel.name}. ID: ${sent.id}`,
                            },
                        ],
                    };
                }
                case "react-to-message": {
                    const { server, channel: chId, messageId, emoji } =
                        ReactToMessageSchema.parse(args);
                    const reactChannel = await findChannel(chId, server);
                    const targetMsg = await reactChannel.messages.fetch(messageId);

                    try {
                        await targetMsg.react(emoji);
                    } catch {
                        // Try custom guild emoji by name
                        const customEmoji = reactChannel.guild.emojis.cache.find(
                            (e) => e.name?.toLowerCase() === emoji.toLowerCase(),
                        );
                        if (customEmoji) {
                            await targetMsg.react(customEmoji);
                        } else {
                            throw new Error(
                                `Could not find emoji "${emoji}". Use a unicode emoji or a custom emoji name from this server.`,
                            );
                        }
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Reacted with ${emoji} to message ${messageId} in #${reactChannel.name}`,
                            },
                        ],
                    };
                }
                case "read-message-history": {
                    const { limit, type, channel, date, search, maxLines } =
                        ReadMessageHistorySchema.parse(args ?? {});
                    const dir = type === "pending" ? PENDING_DIR : HISTORY_DIR;
                    const safeChannel = channel?.replace(/[^a-zA-Z0-9-_]/g, "_");
                    let files = fs
                        .readdirSync(dir)
                        .filter((f) => f.endsWith(".txt"))
                        .sort();

                    if (safeChannel) {
                        files = files.filter((f) => f.startsWith(`${safeChannel}_`));
                    }
                    if (date) {
                        files = files.filter((f) => f.includes(`_${date}`));
                    }

                    const searchLower = search?.toLowerCase();
                    const candidateFiles = searchLower
                        ? files
                        : files.slice(-limit);
                    let matchingFiles = candidateFiles
                        .map((file) => {
                            let lines = fs
                                .readFileSync(path.join(dir, file), "utf-8")
                                .split("\n")
                                .map((line) => line.trim())
                                .filter(Boolean);

                            if (searchLower) {
                                lines = lines.filter((line) =>
                                    line.toLowerCase().includes(searchLower),
                                );
                            }

                            return { file, lines };
                        })
                        .filter(({ lines }) => !searchLower || lines.length > 0);

                    if (searchLower) {
                        matchingFiles = matchingFiles.slice(-limit);
                    }

                    if (matchingFiles.length === 0)
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No ${type} messages found.`,
                                },
                            ],
                        };

                    const messages = matchingFiles.map(({ file, lines }) => {
                        const omitted = Math.max(0, lines.length - maxLines);
                        const selected = lines.slice(-maxLines);
                        const note = omitted > 0
                            ? ` (${selected.length} of ${lines.length} matching lines; ${omitted} older omitted)`
                            : ` (${selected.length} matching lines)`;

                        return `=== ${file}${note} ===\n${selected.join("\n")}`;
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: messages.join("\n\n===\n\n"),
                            },
                        ],
                    };
                }
                case "fetch-messages": {
                    const links = (args as any)?.links as string[];
                    if (!links || !Array.isArray(links) || links.length === 0) {
                        throw new Error(
                            "Please provide at least one Discord message link",
                        );
                    }
                    const linkPattern =
                        /discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/;
                    const results = [];
                    for (const link of links) {
                        const match = link.match(linkPattern);
                        if (!match) {
                            results.push({
                                link,
                                error: "Invalid Discord message link format",
                            });
                            continue;
                        }
                        const [, , channelId, messageId] = match;
                        try {
                            const channel =
                                await client.channels.fetch(channelId);
                            if (!(channel instanceof TextChannel)) {
                                results.push({
                                    link,
                                    error: "Channel is not a text channel",
                                });
                                continue;
                            }
                            const msg = await channel.messages.fetch(messageId);
                            const entry: any = {
                                link,
                                id: msg.id,
                                channel: `#${channel.name}`,
                                server: channel.guild.name,
                                author: msg.author.tag,
                                content: msg.content,
                                timestamp: msg.createdAt.toISOString(),
                            };
                            const images: string[] = [];
                            for (const att of msg.attachments.values()) {
                                if (att.contentType?.startsWith("image/")) {
                                    try {
                                        const filePath =
                                            await downloadAttachment(
                                                att.url,
                                                `mcp_${att.id}_${att.name || "image.png"}`,
                                            );
                                        images.push(filePath);
                                    } catch {
                                        /* skip */
                                    }
                                }
                            }
                            if (images.length > 0) entry.images = images;
                            if (msg.embeds.length > 0) {
                                entry.embeds = msg.embeds
                                    .map((e) => ({
                                        title: e.title,
                                        description: e.description,
                                        url: e.url,
                                    }))
                                    .filter((e) => e.title || e.description);
                            }
                            results.push(entry);
                        } catch (err: any) {
                            results.push({
                                link,
                                error: `Failed to fetch: ${err.message}`,
                            });
                        }
                    }
                    const resultText = JSON.stringify(results, null, 2);
                    const hasImages = results.some(
                        (r: any) => r.images?.length,
                    );
                    const hint = hasImages
                        ? "\n\nNote: Some messages have images. Use the Read tool to view the image file paths listed above."
                        : "";
                    return {
                        content: [{ type: "text", text: resultText + hint }],
                    };
                }
                case "read-messages": {
                    const { server, channel: channelIdentifier, limit } =
                        ReadMessagesSchema.parse(args);
                    const channel = await findChannel(channelIdentifier, server);
                    const messages = await channel.messages.fetch({ limit });
                    const formatted = [];
                    for (const msg of messages.values()) {
                        const entry: any = {
                            id: msg.id,
                            channel: `#${channel.name}`,
                            server: channel.guild.name,
                            author: msg.author.tag,
                            content: msg.content,
                            timestamp: msg.createdAt.toISOString(),
                        };
                        const images: string[] = [];
                        for (const att of msg.attachments.values()) {
                            if (att.contentType?.startsWith("image/")) {
                                try {
                                    const filePath = await downloadAttachment(
                                        att.url,
                                        `mcp_${att.id}_${att.name || "image.png"}`,
                                    );
                                    images.push(filePath);
                                } catch {
                                    /* skip failed downloads */
                                }
                            }
                        }
                        if (images.length > 0) entry.images = images;
                        formatted.push(entry);
                    }
                    const resultText = JSON.stringify(formatted, null, 2);
                    const hasImages = formatted.some(
                        (m: any) => m.images?.length,
                    );
                    const hint = hasImages
                        ? "\n\nNote: Some messages have images. Use the Read tool to view the image file paths listed above."
                        : "";
                    return {
                        content: [{ type: "text", text: resultText + hint }],
                    };
                }
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        } catch (error) {
            if (error instanceof z.ZodError) {
                throw new Error(
                    `Invalid arguments: ${error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`,
                );
            }
            throw error;
        }
    });

    return mcpServer;
}
