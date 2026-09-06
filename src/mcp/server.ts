import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { URL } from "node:url";
import {
    DISCORD_MESSAGE_MAX_CHARS,
    HISTORY_DIR,
    HISTORY_V2_DIR,
    MCP_FETCH_MESSAGES_MAX_LINKS,
    MCP_READ_MESSAGES_MAX_CHARS,
    MCP_HISTORY_MAX_CHARS,
    MESSAGES_DIR,
    PENDING_DIR,
} from "../config.js";
import { client } from "../discord/client.js";
import {
    findChannel,
    normalizeChannelIdentifier,
} from "../discord/helpers.js";
import { downloadAttachment } from "../storage/images.js";
import {
    compareHistoryFilenames,
    getLegacyHistoryChannel,
    isCalendarDate,
} from "./historyFiles.js";
import { parseChannelHistoryFileName } from "../storage/historyPaths.js";
import { readVerifiedUtf8File } from "../storage/safeRead.js";

const ReactToMessageSchema = z.object({
    server: z
        .string()
        .optional()
        .describe("Server name or ID (optional if bot is only in one server)"),
    channel: z.string().describe('Channel name (e.g., "general") or ID'),
    messageId: z
        .string()
        .regex(/^\d+$/, "Invalid Discord message ID")
        .describe("The Discord message ID to react to"),
    emoji: z
        .string()
        .trim()
        .min(1, "Emoji must not be empty")
        .describe('Emoji to react with — unicode emoji (e.g. "👍") or custom guild emoji name (e.g. "pepeclap")'),
});

function isWithinDiscordMessageLimit(message: string): boolean {
    let characters = 0;
    for (const _character of message) {
        characters += 1;
        if (characters > DISCORD_MESSAGE_MAX_CHARS) return false;
    }
    return true;
}

function readPendingMetadata(text: string): {
    channelId: string | undefined;
    channelName: string | undefined;
    date: string | undefined;
} {
    const lines = text.split("\n");
    const separatorIndex = lines.indexOf("---");
    const headerLines = lines.slice(0, separatorIndex === -1 ? 4 : separatorIndex);
    const channelLine = headerLines.find((line) => line.startsWith("Channel: #"));
    const channelIdLine = headerLines.find((line) =>
        line.startsWith("Channel ID: "),
    );
    const timestampLine = headerLines.find((line) =>
        line.startsWith("Timestamp: "),
    );
    const timestamp = timestampLine
        ? new Date(timestampLine.slice("Timestamp: ".length))
        : undefined;

    return {
        channelId: channelIdLine?.slice("Channel ID: ".length),
        channelName: channelLine
            ?.slice("Channel: #".length)
            .replace(/[^a-zA-Z0-9-_]/g, "_"),
        date:
            timestamp && !Number.isNaN(timestamp.getTime())
                ? timestamp.toISOString().slice(0, 10)
                : undefined,
    };
}

interface StoredHistoryFile {
    displayName: string;
    filePath: string;
    directory: string;
    channelId: string | undefined;
    channelName: string | undefined;
}

function readStoredHistoryFile(
    filePath: string,
    expectedDirectory: string,
): string | undefined {
    const result = readVerifiedUtf8File(
        filePath,
        MESSAGES_DIR,
        expectedDirectory,
    );
    return result.state === "valid" ? result.text : undefined;
}

const HISTORY_RESPONSE_SEPARATOR = "\n\n===\n\n";

function takeUtf16Suffix(text: string, maxChars: number): string {
    let start = Math.max(0, text.length - maxChars);
    if (
        start > 0 &&
        start < text.length &&
        /[\uDC00-\uDFFF]/.test(text[start]) &&
        /[\uD800-\uDBFF]/.test(text[start - 1])
    ) {
        start++;
    }
    return text.slice(start);
}

function boundHistoryResponse(messages: string[]): string {
    const fullLength = messages.reduce(
        (length, message) => length + message.length,
        Math.max(0, messages.length - 1) * HISTORY_RESPONSE_SEPARATOR.length,
    );
    if (fullLength <= MCP_HISTORY_MAX_CHARS) {
        return messages.join(HISTORY_RESPONSE_SEPARATOR);
    }

    const note = `\n\n[History response truncated at ${MCP_HISTORY_MAX_CHARS} characters; older history omitted.]`;
    if (note.length >= MCP_HISTORY_MAX_CHARS) {
        return note.slice(0, MCP_HISTORY_MAX_CHARS);
    }

    let remaining = MCP_HISTORY_MAX_CHARS - note.length;
    const selected: string[] = [];
    for (let index = messages.length - 1; index >= 0; index--) {
        const separatorLength = selected.length
            ? HISTORY_RESPONSE_SEPARATOR.length
            : 0;
        const budget = remaining - separatorLength;
        if (budget <= 0) break;

        if (messages[index].length <= budget) {
            selected.unshift(messages[index]);
            remaining -= separatorLength + messages[index].length;
            continue;
        }

        selected.unshift(takeUtf16Suffix(messages[index], budget));
        remaining = 0;
        break;
    }

    return selected.join(HISTORY_RESPONSE_SEPARATOR) + note;
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
            (message) => /\S/u.test(message),
            "String must contain at least one non-whitespace character",
        )
        .refine(
            isWithinDiscordMessageLimit,
            `String must contain at most ${DISCORD_MESSAGE_MAX_CHARS} character(s)`,
        ),
});

const READ_MESSAGES_RESPONSE_HINT = "\n\nNote: Some messages have images. Use the Read tool to view the image file paths listed above.";

type ReadMessageEntry = { images?: string[] } & Record<string, unknown>;

function renderReadMessagesResponse(entries: ReadMessageEntry[], truncated: boolean): string {
    const hint = entries.some((entry) => entry.images?.length)
        ? READ_MESSAGES_RESPONSE_HINT
        : "";
    const note = truncated
        ? `\n\n[Read-messages response truncated at ${MCP_READ_MESSAGES_MAX_CHARS} characters; older messages omitted.]`
        : "";
    return JSON.stringify(entries, null, 2) + hint + note;
}

function boundReadMessagesResponse(entries: ReadMessageEntry[]): string {
    const full = renderReadMessagesResponse(entries, false);
    if (full.length <= MCP_READ_MESSAGES_MAX_CHARS) return full;

    const note = `\n\n[Read-messages response truncated at ${MCP_READ_MESSAGES_MAX_CHARS} characters; older messages omitted.]`;
    if (note.length >= MCP_READ_MESSAGES_MAX_CHARS) {
        return note.slice(0, MCP_READ_MESSAGES_MAX_CHARS);
    }

    const selected: ReadMessageEntry[] = [];
    for (let index = entries.length - 1; index >= 0; index--) {
        const candidate = [entries[index], ...selected];
        if (renderReadMessagesResponse(candidate, true).length > MCP_READ_MESSAGES_MAX_CHARS) {
            break;
        }
        selected.unshift(entries[index]);
    }

    return renderReadMessagesResponse(selected, true);
}

function renderFetchMessagesResponse(
    entries: ReadMessageEntry[],
    omitted: number,
): string {
    const hint = entries.some((entry) => entry.images?.length)
        ? READ_MESSAGES_RESPONSE_HINT
        : "";
    const note = omitted > 0
        ? `\n\n[Fetch-messages response truncated at ${MCP_READ_MESSAGES_MAX_CHARS} characters; ${omitted} later result(s) omitted.]`
        : "";
    return JSON.stringify(entries, null, 2) + hint + note;
}

function boundFetchMessagesResponse(entries: ReadMessageEntry[]): string {
    const full = renderFetchMessagesResponse(entries, 0);
    if (full.length <= MCP_READ_MESSAGES_MAX_CHARS) return full;

    const selected: ReadMessageEntry[] = [];
    for (const entry of entries) {
        const candidate = [...selected, entry];
        const omitted = entries.length - candidate.length;
        if (
            renderFetchMessagesResponse(candidate, omitted).length
            > MCP_READ_MESSAGES_MAX_CHARS
        ) {
            break;
        }
        selected.push(entry);
    }

    return renderFetchMessagesResponse(
        selected,
        entries.length - selected.length,
    );
}

const ReadMessagesSchema = z.object({
    server: z
        .string()
        .optional()
        .describe("Server name or ID (optional if bot is only in one server)"),
    channel: z.string().describe('Channel name (e.g., "general") or ID'),
    limit: z.number().int().min(1).max(100).default(50),
});

const ReadMessageHistorySchema = z.object({
    limit: z.number().int().min(1).max(100).default(20),
    type: z.enum(["history", "pending"]).default("history"),
    channel: z
        .string()
        .trim()
        .refine(
            (channel) => normalizeChannelIdentifier(channel).length > 0,
            "Channel must contain at least one non-whitespace character",
        )
        .optional(),
    date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .refine(isCalendarDate, "Invalid calendar date")
        .optional(),
    search: z.string().min(1).optional(),
    maxLines: z.number().int().min(1).max(2000).default(300),
});

const FetchMessagesSchema = z.object({
    links: z
        .array(z.string())
        .min(1, "Please provide at least one Discord message link")
        .max(
            MCP_FETCH_MESSAGES_MAX_LINKS,
            `Please provide at most ${MCP_FETCH_MESSAGES_MAX_LINKS} Discord message links`,
        ),
});

interface DiscordMessageLinkParts {
    serverId: string;
    channelId: string;
    messageId: string;
}

const DISCORD_MESSAGE_LINK_HOSTS = new Set([
    "discord.com",
    "www.discord.com",
    "canary.discord.com",
    "ptb.discord.com",
]);

function parseDiscordMessageLink(
    link: string,
): DiscordMessageLinkParts | undefined {
    let url: URL;
    try {
        url = new URL(link);
    } catch {
        return undefined;
    }

    if (
        url.protocol !== "https:" ||
        !DISCORD_MESSAGE_LINK_HOSTS.has(url.hostname) ||
        url.port !== "" ||
        url.username !== "" ||
        url.password !== ""
    ) {
        return undefined;
    }

    const match = url.pathname.match(
        /^\/channels\/(\d+)\/(\d+)\/(\d+)\/?$/,
    );
    if (!match) return undefined;

    const [, serverId, channelId, messageId] = match;
    return { serverId, channelId, messageId };
}

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
                            description:
                                "Message content to send; must contain at least one non-whitespace character",
                            minLength: 1,
                            maxLength: DISCORD_MESSAGE_MAX_CHARS,
                            pattern: "\\S",
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
                            pattern: "^\\d+$",
                            description: "The Discord message ID to react to",
                        },
                        emoji: {
                            type: "string",
                            description:
                                'Emoji to react with — unicode emoji (e.g. "👍") or custom guild emoji name (e.g. "pepeclap")',
                            minLength: 1,
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
                            type: "integer",
                            description:
                                "Number of matching history files to read (default 20)",
                            minimum: 1,
                            maximum: 100,
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
                                "Optional non-blank channel name or ID to narrow history files",
                            minLength: 1,
                            pattern: "\\S",
                        },
                        date: {
                            type: "string",
                            description:
                                "Optional date in YYYY-MM-DD format",
                            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
                        },
                        search: {
                            type: "string",
                            description:
                                "Optional case-insensitive text filter",
                        },
                        maxLines: {
                            type: "integer",
                            description:
                                "Maximum lines returned per file (default 300, max 2000)",
                            minimum: 1,
                            maximum: 2000,
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
                            minItems: 1,
                            maxItems: MCP_FETCH_MESSAGES_MAX_LINKS,
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
                            type: "integer",
                            description:
                                "Number of messages to fetch (max 100)",
                            minimum: 1,
                            maximum: 100,
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
                    } catch (error) {
                        // Try custom guild emoji by name
                        const customEmoji = reactChannel.guild.emojis.cache.find(
                            (e) => e.name?.toLowerCase() === emoji.toLowerCase(),
                        );
                        if (customEmoji) {
                            await targetMsg.react(customEmoji);
                        } else {
                            throw error;
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
                    const safeChannel = channel
                        ? normalizeChannelIdentifier(channel).replace(
                            /[^a-zA-Z0-9-_]/g,
                            "_",
                        )
                        : undefined;
                    let files: StoredHistoryFile[] = [];
                    for (const entry of fs.readdirSync(dir, {
                        withFileTypes: true,
                    })) {
                        if (!entry.isFile() || !entry.name.endsWith(".txt")) {
                            continue;
                        }
                        const filePath = path.join(dir, entry.name);
                        files.push({
                            displayName: entry.name,
                            filePath,
                            directory: dir,
                            channelId: undefined,
                            channelName:
                                type === "history"
                                    ? getLegacyHistoryChannel(entry.name)
                                    : undefined,
                        });
                    }

                    if (type === "history") {
                        for (const entry of fs.readdirSync(HISTORY_V2_DIR, {
                            withFileTypes: true,
                        })) {
                            if (
                                !entry.isFile()
                                || !entry.name.endsWith(".txt")
                            ) continue;
                            const filePath = path.join(
                                HISTORY_V2_DIR,
                                entry.name,
                            );
                            const parsed = parseChannelHistoryFileName(
                                entry.name,
                            );
                            files.push({
                                displayName: `v2/${entry.name}`,
                                filePath,
                                directory: HISTORY_V2_DIR,
                                channelId: parsed?.channelId,
                                channelName: parsed?.channelName,
                            });
                        }
                        files.sort((left, right) =>
                            compareHistoryFilenames(
                                left.displayName,
                                right.displayName,
                            ),
                        );
                    } else {
                        files.sort((left, right) =>
                            left.displayName.localeCompare(right.displayName),
                        );
                    }

                    // History metadata is encoded in filenames. Do not read
                    // unrelated bodies merely to select a channel or date.
                    if (type === "history" && safeChannel) {
                        files = files.filter((file) =>
                            file.channelId === safeChannel ||
                            file.channelName === safeChannel,
                        );
                    }
                    if (type === "history" && date) {
                        files = files.filter((file) =>
                            file.displayName.endsWith(`_${date}.txt`),
                        );
                    }

                    const searchNormalized = search?.normalize("NFC").toLowerCase();
                    const messages: string[] = [];
                    let retainedChars = 0;
                    for (let index = files.length - 1; index >= 0; index--) {
                        const file = files[index];
                        const text = readStoredHistoryFile(file.filePath, file.directory);
                        if (text === undefined) continue;

                        // Pending metadata and returned content must come from
                        // the same verified snapshot, including legacy headers.
                        if (type === "pending") {
                            const metadata = readPendingMetadata(text);
                            if (safeChannel) {
                                const matches = metadata.channelId !== undefined ||
                                        metadata.channelName !== undefined
                                    ? metadata.channelId === safeChannel ||
                                      metadata.channelName === safeChannel
                                    : file.displayName.startsWith(`${safeChannel}_`);
                                if (!matches) continue;
                            }
                            if (date && metadata.date !== date) continue;
                        }

                        let lines = text.split("\n")
                            .filter((line) => line.trim().length > 0);
                        if (searchNormalized) {
                            lines = lines.filter((line) =>
                                line.normalize("NFC").toLowerCase().includes(searchNormalized),
                            );
                            if (lines.length === 0) continue;
                        }

                        const omitted = Math.max(0, lines.length - maxLines);
                        const selected = lines.slice(-maxLines);
                        const note = omitted > 0
                            ? ` (${selected.length} of ${lines.length} matching lines; ${omitted} older omitted)`
                            : ` (${selected.length} matching lines)`;
                        const rendered = `=== ${file.displayName}${note} ===\n${selected.join("\n")}`;
                        // Preserve enough overflow for boundHistoryResponse to
                        // report truncation, without retaining entire archives.
                        const message = takeUtf16Suffix(rendered, MCP_HISTORY_MAX_CHARS + 2);
                        retainedChars += message.length +
                            (messages.length ? HISTORY_RESPONSE_SEPARATOR.length : 0);
                        messages.push(message);
                        if (messages.length >= limit || retainedChars > MCP_HISTORY_MAX_CHARS) break;
                    }

                    if (messages.length === 0)
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No ${type} messages found.`,
                                },
                            ],
                        };

                    return {
                        content: [
                            {
                                type: "text",
                                text: boundHistoryResponse(messages.reverse()),
                            },
                        ],
                    };
                }
                case "fetch-messages": {
                    const { links } = FetchMessagesSchema.parse(args);
                    const results: ReadMessageEntry[] = [];
                    for (const link of links) {
                        const parsedLink = parseDiscordMessageLink(link);
                        if (!parsedLink) {
                            results.push({
                                link,
                                error: "Invalid Discord message link format",
                            });
                            continue;
                        }
                        const { serverId, channelId, messageId } = parsedLink;
                        try {
                            const channel =
                                await client.channels.fetch(channelId);
                            if (!channel?.isTextBased() || channel.isDMBased()) {
                                results.push({
                                    link,
                                    error: "Channel is not a guild text channel",
                                });
                                continue;
                            }
                            if (channel.guild.id !== serverId) {
                                results.push({
                                    link,
                                    error: "Message link server does not match the channel's server",
                                });
                                continue;
                            }
                            const msg = await channel.messages.fetch(messageId);
                            const entry: ReadMessageEntry = {
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
                                    .filter(
                                        (e) =>
                                            e.title || e.description || e.url,
                                    );
                            }
                            results.push(entry);
                        } catch (err: any) {
                            results.push({
                                link,
                                error: `Failed to fetch: ${err.message}`,
                            });
                        }
                    }
                    return {
                        content: [{
                            type: "text",
                            text: boundFetchMessagesResponse(results),
                        }],
                    };
                }
                case "read-messages": {
                    const { server, channel: channelIdentifier, limit } =
                        ReadMessagesSchema.parse(args);
                    const channel = await findChannel(channelIdentifier, server);
                    const messages = await channel.messages.fetch({ limit });
                    const formatted: ReadMessageEntry[] = [];
                    // Discord returns fetched messages newest-first. Render them in
                    // chronological order so response truncation drops the oldest.
                    for (const msg of Array.from(messages.values()).reverse()) {
                        const entry: ReadMessageEntry = {
                            id: msg.id,
                            channel: `#${channel.name}`,
                            server: channel.guild.name,
                            author: msg.author.tag,
                            content: msg.content,
                            timestamp: msg.createdAt.toISOString(),
                        };
                        if (msg.attachments.size > 0) {
                            entry.attachments = Array.from(msg.attachments.values()).map(
                                (att) => ({
                                    id: att.id,
                                    name: att.name,
                                    url: att.url,
                                    contentType: att.contentType,
                                    size: att.size,
                                }),
                            );
                        }
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
                    return {
                        content: [{
                            type: "text",
                            text: boundReadMessagesResponse(formatted),
                        }],
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
