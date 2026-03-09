import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import dotenv from "dotenv";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client, GatewayIntentBits, TextChannel, Message, EmbedBuilder } from "discord.js";
import { z } from "zod";
import { spawn } from "child_process";
import http from "http";
import fs from "fs";
import path from "path";

function runClaude(
    args: string[],
    input: string,
    model?: string,
): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) env[key] = value;
        }
        delete env.MCP_SERVER_NAME;
        if (model) {
            env.ANTHROPIC_MODEL = model;
            args = ["--model", model, ...args];
        }

        console.error(
            `[Claude CLI] Spawning with model=${model || "default"}, ANTHROPIC_MODEL=${env.ANTHROPIC_MODEL || "unset"}`,
        );
        const proc = spawn("claude", args, { env });

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (data) => {
            stdout += data.toString();
        });
        proc.stderr.on("data", (data) => {
            stderr += data.toString();
        });

        proc.on("close", (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                const err: any = new Error(
                    `Claude CLI exited with code ${code}`,
                );
                err.stdout = stdout;
                err.stderr = stderr;
                reject(err);
            }
        });

        proc.on("error", reject);

        proc.stdin.write(input);
        proc.stdin.end();

        setTimeout(() => {
            proc.kill();
            reject(new Error("Claude CLI timed out after 120 seconds"));
        }, 120000);
    });
}

// Load environment variables
dotenv.config();

// Message history directory
const MESSAGES_DIR =
    process.env.MESSAGES_DIR || path.join(process.cwd(), "messages");
const REQUIRED_ROLE_ID = process.env.REQUIRED_ROLE_ID || "";
const HISTORY_DIR = path.join(MESSAGES_DIR, "history");
const PENDING_DIR = path.join(MESSAGES_DIR, "pending");

// Ensure directories exist
fs.mkdirSync(HISTORY_DIR, { recursive: true });
fs.mkdirSync(PENDING_DIR, { recursive: true });

// Discord client setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// Helper function to find a guild by name or ID
async function findGuild(guildIdentifier?: string) {
    if (!guildIdentifier) {
        // If no guild specified and bot is only in one guild, use that
        if (client.guilds.cache.size === 1) {
            return client.guilds.cache.first()!;
        }
        // List available guilds
        const guildList = Array.from(client.guilds.cache.values())
            .map((g) => `"${g.name}"`)
            .join(", ");
        throw new Error(
            `Bot is in multiple servers. Please specify server name or ID. Available servers: ${guildList}`,
        );
    }

    // Try to fetch by ID first
    try {
        const guild = await client.guilds.fetch(guildIdentifier);
        if (guild) return guild;
    } catch {
        // If ID fetch fails, search by name
        const guilds = client.guilds.cache.filter(
            (g) => g.name.toLowerCase() === guildIdentifier.toLowerCase(),
        );

        if (guilds.size === 0) {
            const availableGuilds = Array.from(client.guilds.cache.values())
                .map((g) => `"${g.name}"`)
                .join(", ");
            throw new Error(
                `Server "${guildIdentifier}" not found. Available servers: ${availableGuilds}`,
            );
        }
        if (guilds.size > 1) {
            const guildList = guilds
                .map((g) => `${g.name} (ID: ${g.id})`)
                .join(", ");
            throw new Error(
                `Multiple servers found with name "${guildIdentifier}": ${guildList}. Please specify the server ID.`,
            );
        }
        return guilds.first()!;
    }
    throw new Error(`Server "${guildIdentifier}" not found`);
}

// Helper function to find a channel by name or ID within a specific guild
async function findChannel(
    channelIdentifier: string,
    guildIdentifier?: string,
): Promise<TextChannel> {
    const guild = await findGuild(guildIdentifier);

    // First try to fetch by ID
    try {
        const channel = await client.channels.fetch(channelIdentifier);
        if (channel instanceof TextChannel && channel.guild.id === guild.id) {
            return channel;
        }
    } catch {
        // If fetching by ID fails, search by name in the specified guild
        const channels = guild.channels.cache.filter(
            (channel): channel is TextChannel =>
                channel instanceof TextChannel &&
                (channel.name.toLowerCase() ===
                    channelIdentifier.toLowerCase() ||
                    channel.name.toLowerCase() ===
                        channelIdentifier.toLowerCase().replace("#", "")),
        );

        if (channels.size === 0) {
            const availableChannels = guild.channels.cache
                .filter((c): c is TextChannel => c instanceof TextChannel)
                .map((c) => `"#${c.name}"`)
                .join(", ");
            throw new Error(
                `Channel "${channelIdentifier}" not found in server "${guild.name}". Available channels: ${availableChannels}`,
            );
        }
        if (channels.size > 1) {
            const channelList = channels
                .map((c) => `#${c.name} (${c.id})`)
                .join(", ");
            throw new Error(
                `Multiple channels found with name "${channelIdentifier}" in server "${guild.name}": ${channelList}. Please specify the channel ID.`,
            );
        }
        return channels.first()!;
    }
    throw new Error(
        `Channel "${channelIdentifier}" is not a text channel or not found in server "${guild.name}"`,
    );
}

// User profiles directory
const PROFILES_DIR = path.join(MESSAGES_DIR, "profiles");
const SUMMARIES_DIR = path.join(MESSAGES_DIR, "summaries");
fs.mkdirSync(PROFILES_DIR, { recursive: true });
fs.mkdirSync(SUMMARIES_DIR, { recursive: true });

const PROFILE_MAX_CHARS = 2000;
const SERVER_MEMORY_MAX_CHARS = 10000;

// Get the daily log filename for a channel: #general_2026-03-07.txt
function getDailyLogPath(channelName: string, date: Date = new Date()): string {
    const dateStr = date.toISOString().split("T")[0];
    const safeName = channelName.replace(/[^a-zA-Z0-9-_]/g, "_");
    return path.join(HISTORY_DIR, `${safeName}_${dateStr}.txt`);
}

// Append a message to the daily channel log
function appendToLog(
    author: string,
    content: string,
    channelName: string,
    timestamp: Date = new Date(),
) {
    const filePath = getDailyLogPath(channelName, timestamp);
    const time = timestamp.toTimeString().split(" ")[0];
    const line = `[${time}] ${author}: ${content}\n`;
    fs.appendFileSync(filePath, line, "utf-8");
}

// Save a message to pending (still individual files for tracking)
function savePending(msg: Message) {
    const filename = `${msg.id}.txt`;
    const content = [
        `Author: ${msg.author.tag}`,
        `Channel: #${(msg.channel as TextChannel).name}`,
        `Timestamp: ${msg.createdAt.toISOString()}`,
        `---`,
        msg.content,
    ].join("\n");
    fs.writeFileSync(path.join(PENDING_DIR, filename), content, "utf-8");
}

function removePending(msgId: string) {
    const filePath = path.join(PENDING_DIR, `${msgId}.txt`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

// Load recent history: past week summaries + today's raw messages
function loadRecentHistory(channelName: string): string {
    const parts: string[] = [];

    // Past week summaries (days 2-7 ago)
    const olderSummaries = loadRecentSummaries(channelName, 7);
    if (olderSummaries) {
        parts.push(`--- Past week summaries ---\n${olderSummaries}`);
    }

    // Yesterday: use summary if available, otherwise last 30 raw lines
    const yesterday = new Date(Date.now() - 86400000);
    const yesterdaySummary = getSummaryPath(channelName, yesterday);
    const yesterdayLog = getDailyLogPath(channelName, yesterday);
    if (fs.existsSync(yesterdaySummary)) {
        const dateStr = yesterday.toISOString().split("T")[0];
        parts.push(
            `--- Yesterday (${dateStr}) summary ---\n${fs.readFileSync(yesterdaySummary, "utf-8").trim()}`,
        );
    } else if (fs.existsSync(yesterdayLog)) {
        const content = fs.readFileSync(yesterdayLog, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());
        if (lines.length > 0) {
            parts.push(`--- Yesterday ---\n${lines.slice(-30).join("\n")}`);
        }
    }

    // Today: raw messages (capped at 50)
    const todayPath = getDailyLogPath(channelName);
    if (fs.existsSync(todayPath)) {
        const content = fs.readFileSync(todayPath, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());
        if (lines.length > 50) {
            parts.push(
                `--- Today (last 50 of ${lines.length} messages) ---\n${lines.slice(-50).join("\n")}`,
            );
        } else {
            parts.push(`--- Today ---\n${content}`);
        }
    }

    return parts.join("\n\n").trim() || "No previous conversation history.";
}

// Load user profile
function getUserProfile(userId: string): string {
    const filePath = path.join(PROFILES_DIR, `${userId}.txt`);
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf-8");
    return "";
}

// Load server memory (generic context not tied to any user)
function getServerMemory(guildId: string): string {
    const filePath = path.join(PROFILES_DIR, `server_${guildId}.txt`);
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf-8");
    return "";
}

// Get summary file path for a channel+date
function getSummaryPath(channelName: string, date: Date): string {
    const dateStr = date.toISOString().split("T")[0];
    const safeName = channelName.replace(/[^a-zA-Z0-9-_]/g, "_");
    return path.join(SUMMARIES_DIR, `${safeName}_${dateStr}.txt`);
}

// Load summaries for the past N days (excluding today)
function loadRecentSummaries(channelName: string, days: number = 7): string {
    const summaries: string[] = [];
    for (let i = 1; i <= days; i++) {
        const date = new Date(Date.now() - i * 86400000);
        const summaryPath = getSummaryPath(channelName, date);
        if (fs.existsSync(summaryPath)) {
            const dateStr = date.toISOString().split("T")[0];
            summaries.push(
                `[${dateStr}] ${fs.readFileSync(summaryPath, "utf-8").trim()}`,
            );
        }
    }
    return summaries.reverse().join("\n\n");
}

// Generate a summary for a day's channel log (runs in background)
async function generateDailySummary(
    channelName: string,
    date: Date,
): Promise<void> {
    const logPath = getDailyLogPath(channelName, date);
    const summaryPath = getSummaryPath(channelName, date);

    // Skip if no log or summary already exists
    if (!fs.existsSync(logPath) || fs.existsSync(summaryPath)) return;

    const log = fs.readFileSync(logPath, "utf-8").trim();
    if (!log || log.split("\n").length < 3) {
        // Too short to summarize — just copy as-is
        fs.writeFileSync(summaryPath, log, "utf-8");
        return;
    }

    try {
        const dateStr = date.toISOString().split("T")[0];
        console.error(
            `[Summary] Generating summary for #${channelName} on ${dateStr}`,
        );
        const { stdout } = await runClaude(
            [
                "-p",
                "--system-prompt",
                "You are a conversation summarizer. Summarize the following Discord chat log into a concise paragraph (max 200 words). Focus on key topics discussed, decisions made, and important information shared. Do not include greetings, small talk, or filler. Output ONLY the summary, no preamble.",
            ],
            log,
            "claude-haiku-4-5",
        );

        if (stdout.trim()) {
            fs.writeFileSync(summaryPath, stdout.trim(), "utf-8");
            console.error(
                `[Summary] Saved summary for #${channelName} on ${dateStr}`,
            );
        }
    } catch (err: any) {
        console.error(`[Summary] Failed to generate summary: ${err.message}`);
    }
}

// Background: update user profile after a conversation
async function backgroundProfileUpdate(
    authorTag: string,
    authorId: string,
    question: string,
    response: string,
): Promise<void> {
    const profilePath = path.join(PROFILES_DIR, `${authorId}.txt`);
    const existingProfile = getUserProfile(authorId);

    try {
        const prompt = [
            `Current profile for ${authorTag} (may be empty):`,
            existingProfile || "(no profile yet)",
            "",
            `Latest exchange:`,
            `${authorTag}: ${question}`,
            `Bot: ${response}`,
            "",
            `Task: Based on this exchange, output an updated user profile. Include ONLY lasting facts about the user (name, preferences, expertise, interests, projects, etc). Keep it under ${PROFILE_MAX_CHARS} characters. If you learned nothing new, output the existing profile unchanged. Output ONLY the profile text, no preamble or explanation.`,
        ].join("\n");

        const { stdout } = await runClaude(["-p"], prompt, "claude-haiku-4-5");

        const newProfile = stdout.trim();
        if (newProfile && newProfile !== existingProfile.trim()) {
            // Enforce size cap
            const capped = newProfile.slice(0, PROFILE_MAX_CHARS);
            fs.writeFileSync(profilePath, capped, "utf-8");
            console.error(
                `[Profile] Updated profile for ${authorTag} (${capped.length} chars)`,
            );
        }
    } catch (err: any) {
        console.error(
            `[Profile] Failed to update profile for ${authorTag}: ${err.message}`,
        );
    }
}

// Background: update server memory after a conversation
async function backgroundServerMemoryUpdate(
    guildId: string,
    guildName: string,
    channelName: string,
    authorTag: string,
    question: string,
    response: string,
): Promise<void> {
    const memoryPath = path.join(PROFILES_DIR, `server_${guildId}.txt`);
    const existingMemory = getServerMemory(guildId);

    try {
        const prompt = [
            `Current server memory for "${guildName}" (may be empty):`,
            existingMemory || "(no server memory yet)",
            "",
            `Latest exchange in #${channelName}:`,
            `${authorTag}: ${question}`,
            `Bot: ${response}`,
            "",
            `Task: Based on this exchange, output an updated server memory. Include ONLY server-wide context: channel purposes, recurring topics, ongoing projects, inside jokes, server culture, important events, and shared knowledge. Do NOT include any user-specific information (user descriptions, user preferences, user behavior patterns, who does what) — that belongs in individual user profiles which are managed separately. Keep it under ${SERVER_MEMORY_MAX_CHARS} characters. If you learned nothing new about the server, output the existing memory unchanged. Output ONLY the memory text, no preamble or explanation.`,
        ].join("\n");

        const { stdout } = await runClaude(["-p"], prompt, "claude-haiku-4-5");

        const newMemory = stdout.trim();
        if (newMemory && newMemory !== existingMemory.trim()) {
            const capped = newMemory.slice(0, SERVER_MEMORY_MAX_CHARS);
            fs.writeFileSync(memoryPath, capped, "utf-8");
            console.error(
                `[ServerMemory] Updated memory for ${guildName} (${capped.length} chars)`,
            );
        }
    } catch (err: any) {
        console.error(
            `[ServerMemory] Failed to update memory for ${guildName}: ${err.message}`,
        );
    }
}

// Check and generate summaries for yesterday (called on bot activity)
async function ensureYesterdaySummaries(): Promise<void> {
    const yesterday = new Date(Date.now() - 86400000);
    try {
        const files = fs
            .readdirSync(HISTORY_DIR)
            .filter((f) => f.endsWith(".txt"));
        const dateStr = yesterday.toISOString().split("T")[0];
        const yesterdayFiles = files.filter((f) => f.includes(dateStr));
        for (const file of yesterdayFiles) {
            const channelName = file.replace(`_${dateStr}.txt`, "");
            await generateDailySummary(channelName, yesterday);
        }
    } catch (err: any) {
        console.error(
            `[Summary] Error checking yesterday summaries: ${err.message}`,
        );
    }
}

// Invoke Claude Code CLI to answer a question
function getSystemPrompt(): string {
    const botName =
        client.user?.displayName || client.user?.username || "Claudify";
    return [
        `You are ${botName}, an AI Discord bot. You have access to message history files in the messages directory.`,
        ``,
        `Personality and behavior:`,
        `- Your name is ${botName}. Respond to it naturally.`,
        `- Talk casually, like a regular person in a Discord server. No corporate speak.`,
        `- Be concise by default. Short, direct answers. No filler.`,
        `- When someone asks you to elaborate or the topic is complex, go deeper. But don't over-explain unprompted.`,
        `- Have actual opinions. Don't fence-sit or "both sides" everything. Pick a side and say why.`,
        `- Don't be sycophantic. No "Great question!" or "That's a really interesting point!" Just answer.`,
        `- Don't try to mediate or play peacekeeper. If someone's wrong, say so.`,
        `- Keep responses under 2000 characters (Discord's limit).`,
        `- You can read from the messages directory for memory across conversations.`,
        ``,
        `Memory:`,
        `- Conversation history (recent messages + past week summaries) is provided automatically in each prompt.`,
        `- User profiles are maintained automatically — the user's profile is included in your prompt when they talk to you.`,
        `- You do NOT need to write or update profile files. A background system handles that after each conversation.`,
        `- Conversation logs are in ${HISTORY_DIR}/ if you need to look up older history beyond what's provided.`,
        ``,
        `Discord tools (via MCP):`,
        `- You have access to Discord tools: send-message, read-messages, read-message-history.`,
        `- Use read-messages to read live messages from any channel the bot can see.`,
        `- Use send-message to send messages to other channels if needed.`,
        `- Only use these tools when the user's request requires interacting with Discord beyond the current channel.`,
    ].join("\n");
}

const IMAGES_DIR = path.join(MESSAGES_DIR, "images");
fs.mkdirSync(IMAGES_DIR, { recursive: true });

async function downloadAttachment(
    url: string,
    filename: string,
): Promise<string> {
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());
    const filePath = path.join(IMAGES_DIR, filename);
    fs.writeFileSync(filePath, buffer);
    return filePath;
}

async function askClaude(
    question: string,
    author: string,
    authorId: string,
    channelName: string,
    serverName: string,
    guildId: string,
    imagePaths: string[] = [],
): Promise<string> {
    const recentHistory = loadRecentHistory(channelName);
    const userProfile = getUserProfile(authorId);
    const serverMemory = getServerMemory(guildId);

    const promptParts = [
        `Recent conversation history in #${channelName}:`,
        recentHistory,
    ];

    if (serverMemory) {
        promptParts.push("");
        promptParts.push(`Server memory for "${serverName}":`);
        promptParts.push(serverMemory);
    }

    promptParts.push("");
    if (userProfile) {
        promptParts.push(`Known info about ${author}:`);
        promptParts.push(userProfile);
    }

    promptParts.push("");
    promptParts.push(
        `Current question from ${author} in #${channelName} (${serverName}):`,
    );
    promptParts.push(question);

    if (imagePaths.length > 0) {
        promptParts.push("");
        promptParts.push(
            `The user attached ${imagePaths.length} image(s). Use the Read tool to view them:`,
        );
        for (const imgPath of imagePaths) {
            promptParts.push(`- ${imgPath}`);
        }
    }

    const prompt = promptParts.join("\n");

    try {
        console.error(
            `[Claude CLI] Spawning claude with prompt via stdin (${prompt.length} chars)`,
        );

        const { stdout, stderr } = await runClaude(
            [
                "-p",
                "--system-prompt",
                getSystemPrompt(),
                "--allowedTools",
                "WebSearch,WebFetch,Read,mcp__discord__send-message,mcp__discord__read-messages,mcp__discord__read-message-history,mcp__discord__fetch-messages",
                "--add-dir",
                MESSAGES_DIR,
                "--mcp-config",
                MCP_CONFIG_PATH,
            ],
            prompt,
            "claude-haiku-4-5",
        );

        if (stderr) console.error(`[Claude CLI] stderr: ${stderr}`);
        console.error(
            `[Claude CLI] Response received (${stdout.length} chars)`,
        );
        if (!stdout.trim()) {
            console.error(
                `[Claude CLI] WARNING: Empty response. Claude CLI may not be authenticated. Run: docker exec -it <container> claude auth login`,
            );
        }
        return (
            stdout.trim() ||
            "Sorry, I could not generate a response. The bot may not be authenticated yet — check the server logs."
        );
    } catch (error: any) {
        console.error(`[Claude CLI] Error: ${error.message}`);
        if (error.stderr) console.error(`[Claude CLI] stderr: ${error.stderr}`);
        if (error.stdout) console.error(`[Claude CLI] stdout: ${error.stdout}`);
        return "Sorry, I encountered an error processing your request.";
    }
}

// Validation schemas for MCP tools
const SendMessageSchema = z.object({
    server: z
        .string()
        .optional()
        .describe("Server name or ID (optional if bot is only in one server)"),
    channel: z.string().describe('Channel name (e.g., "general") or ID'),
    message: z.string(),
});

const ReadMessagesSchema = z.object({
    server: z
        .string()
        .optional()
        .describe("Server name or ID (optional if bot is only in one server)"),
    channel: z.string().describe('Channel name (e.g., "general") or ID'),
    limit: z.number().min(1).max(100).default(50),
});

// Factory: creates a fresh MCP Server with Discord tools registered
function createMcpServer(): Server {
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
                        },
                    },
                    required: ["channel", "message"],
                },
            },
            {
                name: "read-message-history",
                description:
                    "Read saved message history files from disk (messages exchanged via !ask or bot mentions)",
                inputSchema: {
                    type: "object" as const,
                    properties: {
                        limit: {
                            type: "number",
                            description:
                                "Number of recent history entries to read (default 20)",
                            default: 20,
                        },
                        type: {
                            type: "string",
                            enum: ["history", "pending"],
                            description: "Read from history or pending",
                            default: "history",
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
                    const { channel: channelIdentifier, message } =
                        SendMessageSchema.parse(args);
                    const channel = await findChannel(channelIdentifier);
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
                case "read-message-history": {
                    const limit = (args as any)?.limit ?? 20;
                    const type =
                        (args as any)?.type === "pending"
                            ? "pending"
                            : "history";
                    const dir = type === "pending" ? PENDING_DIR : HISTORY_DIR;
                    const files = fs
                        .readdirSync(dir)
                        .filter((f) => f.endsWith(".txt"))
                        .sort()
                        .slice(-limit);
                    if (files.length === 0)
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No ${type} messages found.`,
                                },
                            ],
                        };
                    const messages = files.map((f) =>
                        fs.readFileSync(path.join(dir, f), "utf-8"),
                    );
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
                                channel: `#${channel.name}`,
                                server: channel.guild.name,
                                author: msg.author.tag,
                                content: msg.content,
                                timestamp: msg.createdAt.toISOString(),
                            };
                            // Download image attachments
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
                            // Include embeds if present
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
                    const { channel: channelIdentifier, limit } =
                        ReadMessagesSchema.parse(args);
                    const channel = await findChannel(channelIdentifier);
                    const messages = await channel.messages.fetch({ limit });
                    const formatted = [];
                    for (const msg of messages.values()) {
                        const entry: any = {
                            channel: `#${channel.name}`,
                            server: channel.guild.name,
                            author: msg.author.tag,
                            content: msg.content,
                            timestamp: msg.createdAt.toISOString(),
                        };
                        // Download image attachments and include paths
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

// MCP HTTP server port (internal, not exposed to internet)
const MCP_PORT = parseInt(process.env.MCP_PORT || "3100", 10);

// MCP config file for Claude CLI
const MCP_CONFIG_PATH = path.join(process.cwd(), ".mcp-config.json");

function writeMcpConfig() {
    const config = {
        mcpServers: {
            discord: {
                type: "http",
                url: `http://localhost:${MCP_PORT}/mcp`,
            },
        },
    };
    fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
    console.error(`[MCP] Config written to ${MCP_CONFIG_PATH}`);
}

// Start HTTP MCP server
function startMcpHttpServer(): http.Server {
    const httpServer = http.createServer(async (req, res) => {
        const url = new URL(req.url || "/", `http://localhost:${MCP_PORT}`);
        if (url.pathname !== "/mcp") {
            res.writeHead(404).end("Not found");
            return;
        }

        if (req.method === "POST") {
            // Stateless: create fresh server + transport per request
            const mcpServer = createMcpServer();
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
            });
            try {
                await mcpServer.connect(transport);
                // Parse body manually (no express body-parser)
                const chunks: Buffer[] = [];
                for await (const chunk of req) chunks.push(chunk as Buffer);
                const body = JSON.parse(Buffer.concat(chunks).toString());
                await transport.handleRequest(req, res, body);
            } catch (error: any) {
                console.error(`[MCP HTTP] Error: ${error.message}`);
                if (!res.headersSent) {
                    res.writeHead(500).end(
                        JSON.stringify({
                            jsonrpc: "2.0",
                            error: {
                                code: -32603,
                                message: "Internal server error",
                            },
                            id: null,
                        }),
                    );
                }
            } finally {
                await transport.close().catch(() => {});
                await mcpServer.close().catch(() => {});
            }
        } else if (req.method === "GET" || req.method === "DELETE") {
            // Stateless mode: no sessions, reject GET/DELETE
            res.writeHead(405).end(
                JSON.stringify({
                    jsonrpc: "2.0",
                    error: {
                        code: -32000,
                        message: "Method not allowed (stateless mode)",
                    },
                    id: null,
                }),
            );
        } else {
            res.writeHead(405).end();
        }
    });

    httpServer.listen(MCP_PORT, "127.0.0.1", () => {
        console.error(
            `[MCP HTTP] Streamable HTTP server listening on http://127.0.0.1:${MCP_PORT}/mcp`,
        );
    });

    return httpServer;
}

// Discord client login and error handling
client.once("ready", () => {
    console.error("Discord bot is ready!");
    console.error(`Messages will be saved to: ${MESSAGES_DIR}`);
});

// Listen for !ask commands and bot mentions
client.on("messageCreate", async (msg: Message) => {
    try {
        if (msg.author.bot) return;
        if (!(msg.channel instanceof TextChannel)) return;

        // Handle !storage command
        if (msg.content.trim() === "!storage") {
            console.error(`[Bot] Storage requested by ${msg.author.tag}`);
            const countFiles = (dir: string) => {
                try {
                    return fs.readdirSync(dir).filter((f) => f.endsWith(".txt"))
                        .length;
                } catch {
                    return 0;
                }
            };
            const getDirSize = (dir: string): number => {
                try {
                    return fs.readdirSync(dir).reduce((total, file) => {
                        const filePath = path.join(dir, file);
                        const stat = fs.statSync(filePath);
                        return (
                            total +
                            (stat.isDirectory()
                                ? getDirSize(filePath)
                                : stat.size)
                        );
                    }, 0);
                } catch {
                    return 0;
                }
            };
            const formatSize = (bytes: number) => {
                if (bytes < 1024) return `${bytes} B`;
                if (bytes < 1024 * 1024)
                    return `${(bytes / 1024).toFixed(1)} KB`;
                return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
            };

            const historyCount = countFiles(HISTORY_DIR);
            const pendingCount = countFiles(PENDING_DIR);
            const summaryCount = countFiles(SUMMARIES_DIR);
            const profileCount = countFiles(PROFILES_DIR);
            const historySize = getDirSize(HISTORY_DIR);
            const pendingSize = getDirSize(PENDING_DIR);
            const summariesSize = getDirSize(SUMMARIES_DIR);
            const profilesSize = getDirSize(PROFILES_DIR);
            const imagesSize = getDirSize(IMAGES_DIR);
            const totalSize = getDirSize(MESSAGES_DIR);

            const output = [
                `History:    ${historyCount} files (${formatSize(historySize)})`,
                `Summaries:  ${summaryCount} files (${formatSize(summariesSize)})`,
                `Profiles:   ${profileCount} files (${formatSize(profilesSize)})`,
                `Pending:    ${pendingCount} files (${formatSize(pendingSize)})`,
                `Images:     ${formatSize(imagesSize)}`,
                `Total:      ${formatSize(totalSize)}`,
            ].join("\n");

            await msg.reply("```\n" + output + "\n```");
            return;
        }

        // Handle !usage command
        if (msg.content.trim().startsWith("!usage")) {
            const args = msg.content.trim().split(/\s+/).slice(1);
            const subcommand = args[0] || "today";

            let ccArgs: string[];
            let title: string;
            let embedColor: number;
            const today = new Date().toISOString().split("T")[0].replace(/-/g, "");

            switch (subcommand) {
                case "today":
                    ccArgs = ["ccusage@latest", "daily", "--json", "--since", today];
                    title = "📊 Today's Usage";
                    embedColor = 0x5865f2; // Discord blurple
                    break;
                case "daily":
                    ccArgs = ["ccusage@latest", "daily", "--json"];
                    title = "📅 Daily Usage";
                    embedColor = 0x57f287; // Green
                    break;
                case "blocks":
                    ccArgs = ["ccusage@latest", "blocks", "--json", "--since", today];
                    title = "⏱️ Billing Windows (Today)";
                    embedColor = 0xfee75c; // Yellow
                    break;
                case "monthly":
                    ccArgs = ["ccusage@latest", "monthly", "--json"];
                    title = "📆 Monthly Usage";
                    embedColor = 0xeb459e; // Pink
                    break;
                default:
                    const helpEmbed = new EmbedBuilder()
                        .setTitle("📊 Usage Command Help")
                        .setColor(0x5865f2)
                        .setDescription("View Claude API token usage and costs.")
                        .addFields(
                            { name: "`!usage today`", value: "Today's breakdown by model *(default)*", inline: true },
                            { name: "`!usage daily`", value: "Daily breakdown over time", inline: true },
                            { name: "`!usage blocks`", value: "5-hour billing windows for today", inline: true },
                            { name: "`!usage monthly`", value: "Monthly totals and trends", inline: true },
                        )
                        .setFooter({ text: "Powered by ccusage" });
                    await msg.reply({ embeds: [helpEmbed] });
                    return;
            }

            await (msg.channel as TextChannel).sendTyping();

            // Formatting helpers
            const formatCost = (c: number) => c >= 1 ? `$${c.toFixed(2)}` : `$${c.toFixed(4)}`;
            const formatTokens = (t: number) =>
                t >= 1_000_000_000 ? `${(t / 1_000_000_000).toFixed(2)}B`
                : t >= 1_000_000 ? `${(t / 1_000_000).toFixed(2)}M`
                : t >= 1_000 ? `${(t / 1_000).toFixed(1)}K`
                : `${t}`;
            const progressBar = (value: number, max: number, length = 10) => {
                if (max === 0) return "░".repeat(length);
                const filled = Math.round((value / max) * length);
                return "█".repeat(Math.min(filled, length)) + "░".repeat(length - Math.min(filled, length));
            };
            const modelEmoji = (name: string) => {
                if (name.includes("opus")) return "🟣";
                if (name.includes("sonnet")) return "🔵";
                if (name.includes("haiku")) return "🟢";
                return "⚪";
            };
            const shortModel = (name: string) => {
                return name
                    .replace("claude-", "")
                    .replace(/-\d{8}$/, "");
            };

            try {
                const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
                    const proc = spawn("npx", ccArgs, {
                        env: { ...process.env },
                        shell: true,
                    });
                    let stdout = "";
                    let stderr = "";
                    proc.stdout.on("data", (d) => (stdout += d.toString()));
                    proc.stderr.on("data", (d) => (stderr += d.toString()));
                    proc.on("close", (code) =>
                        code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || `exit ${code}`)),
                    );
                });

                const data = JSON.parse(stdout);
                const embeds: EmbedBuilder[] = [];

                if (subcommand === "blocks") {
                    const blocks = (data.blocks || []).filter((b: any) => !b.isGap);
                    if (blocks.length === 0) {
                        const embed = new EmbedBuilder()
                            .setTitle(title)
                            .setColor(embedColor)
                            .setDescription("No active billing windows found today.")
                            .setTimestamp();
                        embeds.push(embed);
                    }
                    for (const block of blocks) {
                        const start = new Date(block.startTime);
                        const end = new Date(block.endTime);
                        const startStr = start.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
                        const endStr = end.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });

                        const embed = new EmbedBuilder()
                            .setTitle(`${title}`)
                            .setColor(block.isActive ? 0x57f287 : 0x99aab5)
                            .setDescription(
                                `**${startStr} — ${endStr}**` +
                                (block.isActive ? "  🟢 Active" : "  ⚫ Ended")
                            );

                        // Token breakdown
                        const tc = block.tokenCounts;
                        let tokenDetail = "```\n";
                        tokenDetail += `Input tokens:     ${formatTokens(tc.inputTokens).padStart(10)}\n`;
                        tokenDetail += `Output tokens:    ${formatTokens(tc.outputTokens).padStart(10)}\n`;
                        tokenDetail += `Cache write:      ${formatTokens(tc.cacheCreationInputTokens).padStart(10)}\n`;
                        tokenDetail += `Cache read:       ${formatTokens(tc.cacheReadInputTokens).padStart(10)}\n`;
                        tokenDetail += `─────────────────────────\n`;
                        tokenDetail += `Total:            ${formatTokens(block.totalTokens).padStart(10)}\n`;
                        tokenDetail += "```";
                        embed.addFields({ name: "🔢 Tokens", value: tokenDetail, inline: false });

                        // Cost
                        embed.addFields(
                            { name: "💰 Cost", value: `**${formatCost(block.costUSD)}**`, inline: true },
                            { name: "📊 Entries", value: `${block.entries}`, inline: true },
                        );

                        // Models used
                        if (block.models && block.models.length > 0) {
                            const modelList = block.models.map((m: string) => `${modelEmoji(m)} ${shortModel(m)}`).join("\n");
                            embed.addFields({ name: "🤖 Models", value: modelList, inline: true });
                        }

                        // Burn rate & projection (active blocks)
                        if (block.isActive && block.burnRate) {
                            const br = block.burnRate;
                            let rateStr = `${formatTokens(Math.round(br.tokensPerMinute))} tokens/min\n`;
                            rateStr += `${formatCost(br.costPerHour)}/hour`;
                            embed.addFields({ name: "🔥 Burn Rate", value: rateStr, inline: true });

                            if (block.projection) {
                                const proj = block.projection;
                                const hoursLeft = (proj.remainingMinutes / 60).toFixed(1);
                                let projStr = `Projected window cost: **${formatCost(proj.totalCost)}**\n`;
                                projStr += `Projected tokens: ${formatTokens(proj.totalTokens)}\n`;
                                projStr += `Time remaining: ${hoursLeft}h`;
                                embed.addFields({ name: "📈 Projection", value: projStr, inline: true });
                            }
                        }

                        embed.setTimestamp();
                        embeds.push(embed);
                    }
                } else if (subcommand === "monthly") {
                    for (const entry of data.monthly || []) {
                        const embed = new EmbedBuilder()
                            .setTitle(`${title} — ${entry.month}`)
                            .setColor(embedColor);

                        // Summary line
                        embed.setDescription(
                            `**Total Cost: ${formatCost(entry.totalCost)}** · ${formatTokens(entry.totalTokens)} tokens`
                        );

                        // Token breakdown
                        let tokenDetail = "```\n";
                        tokenDetail += `Input:        ${formatTokens(entry.inputTokens).padStart(10)}\n`;
                        tokenDetail += `Output:       ${formatTokens(entry.outputTokens).padStart(10)}\n`;
                        tokenDetail += `Cache write:  ${formatTokens(entry.cacheCreationTokens).padStart(10)}\n`;
                        tokenDetail += `Cache read:   ${formatTokens(entry.cacheReadTokens).padStart(10)}\n`;
                        tokenDetail += "```";
                        embed.addFields({ name: "🔢 Token Breakdown", value: tokenDetail, inline: false });

                        // Model breakdown with progress bars
                        const maxCost = Math.max(...(entry.modelBreakdowns || []).map((m: any) => m.cost));
                        for (const m of entry.modelBreakdowns || []) {
                            const pct = entry.totalCost > 0 ? ((m.cost / entry.totalCost) * 100).toFixed(1) : "0";
                            const bar = progressBar(m.cost, maxCost, 12);
                            let detail = `\`${bar}\` **${formatCost(m.cost)}** (${pct}%)\n`;
                            detail += `In: ${formatTokens(m.inputTokens)} · Out: ${formatTokens(m.outputTokens)}`;
                            if (m.cacheCreationTokens > 0 || m.cacheReadTokens > 0) {
                                detail += `\nCache W: ${formatTokens(m.cacheCreationTokens)} · Cache R: ${formatTokens(m.cacheReadTokens)}`;
                            }
                            embed.addFields({
                                name: `${modelEmoji(m.modelName)} ${shortModel(m.modelName)}`,
                                value: detail,
                                inline: false,
                            });
                        }

                        embed.setTimestamp();
                        embeds.push(embed);
                    }
                } else {
                    // today / daily
                    const entries = data.daily || [];
                    if (entries.length === 0) {
                        const embed = new EmbedBuilder()
                            .setTitle(title)
                            .setColor(embedColor)
                            .setDescription("No usage data found for this period.")
                            .setTimestamp();
                        embeds.push(embed);
                    }

                    for (const entry of entries) {
                        const embed = new EmbedBuilder()
                            .setTitle(`${title} — ${entry.date}`)
                            .setColor(embedColor);

                        embed.setDescription(
                            `**Total Cost: ${formatCost(entry.totalCost)}** · ${formatTokens(entry.totalTokens)} tokens`
                        );

                        // Token breakdown
                        let tokenDetail = "```\n";
                        tokenDetail += `Input:        ${formatTokens(entry.inputTokens).padStart(10)}\n`;
                        tokenDetail += `Output:       ${formatTokens(entry.outputTokens).padStart(10)}\n`;
                        tokenDetail += `Cache write:  ${formatTokens(entry.cacheCreationTokens).padStart(10)}\n`;
                        tokenDetail += `Cache read:   ${formatTokens(entry.cacheReadTokens).padStart(10)}\n`;
                        tokenDetail += "```";
                        embed.addFields({ name: "🔢 Token Breakdown", value: tokenDetail, inline: false });

                        // Model breakdown with progress bars
                        const maxCost = Math.max(...(entry.modelBreakdowns || []).map((m: any) => m.cost));
                        for (const m of entry.modelBreakdowns || []) {
                            const pct = entry.totalCost > 0 ? ((m.cost / entry.totalCost) * 100).toFixed(1) : "0";
                            const bar = progressBar(m.cost, maxCost, 12);
                            let detail = `\`${bar}\` **${formatCost(m.cost)}** (${pct}%)\n`;
                            detail += `In: ${formatTokens(m.inputTokens)} · Out: ${formatTokens(m.outputTokens)}`;
                            if (m.cacheCreationTokens > 0 || m.cacheReadTokens > 0) {
                                detail += `\nCache W: ${formatTokens(m.cacheCreationTokens)} · Cache R: ${formatTokens(m.cacheReadTokens)}`;
                            }
                            embed.addFields({
                                name: `${modelEmoji(m.modelName)} ${shortModel(m.modelName)}`,
                                value: detail,
                                inline: false,
                            });
                        }

                        embed.setTimestamp();
                        embeds.push(embed);
                    }
                }

                // Add totals embed if there are multiple entries
                if (data.totals && embeds.length > 1) {
                    const t = data.totals;
                    const totalsEmbed = new EmbedBuilder()
                        .setTitle("📊 Grand Total")
                        .setColor(0xed4245) // Red accent
                        .setDescription(`**${formatCost(t.totalCost)}** across ${formatTokens(t.totalTokens)} tokens`)
                        .addFields(
                            { name: "Input", value: formatTokens(t.inputTokens), inline: true },
                            { name: "Output", value: formatTokens(t.outputTokens), inline: true },
                            { name: "Cache", value: `W: ${formatTokens(t.cacheCreationTokens)} · R: ${formatTokens(t.cacheReadTokens)}`, inline: true },
                        )
                        .setTimestamp();
                    embeds.push(totalsEmbed);
                }

                // Discord allows max 10 embeds per message
                const embedChunks: EmbedBuilder[][] = [];
                for (let i = 0; i < embeds.length; i += 10) {
                    embedChunks.push(embeds.slice(i, i + 10));
                }

                await msg.reply({ embeds: embedChunks[0] });
                for (let i = 1; i < embedChunks.length; i++) {
                    await (msg.channel as TextChannel).send({ embeds: embedChunks[i] });
                }
            } catch (error: any) {
                console.error(`[Bot] ccusage error: ${error.message}`);
                const errorEmbed = new EmbedBuilder()
                    .setTitle("❌ Usage Fetch Failed")
                    .setColor(0xed4245)
                    .setDescription("Failed to fetch usage data.")
                    .addFields({ name: "Error", value: `\`\`\`${error.message.slice(0, 1000)}\`\`\`` })
                    .setFooter({ text: "Make sure ccusage is available (npx ccusage@latest)" })
                    .setTimestamp();
                await msg.reply({ embeds: [errorEmbed] });
            }
            return;
        }

        // Handle !guild command
        if (msg.content.trim() === "!guild") {
            if (!msg.guild) {
                await msg.reply("This command can only be used in a server.");
                return;
            }
            const memory = getServerMemory(msg.guild.id);
            if (memory) {
                const header = `**Server memory for ${msg.guild.name}:**\n`;
                const full = header + memory;
                if (full.length <= 2000) {
                    await msg.reply(full);
                } else {
                    // First chunk accounts for header length
                    const firstMax = 2000 - header.length;
                    await msg.reply(header + memory.slice(0, firstMax));
                    let remaining = memory.slice(firstMax);
                    while (remaining.length > 0) {
                        await (msg.channel as TextChannel).send(
                            remaining.slice(0, 2000),
                        );
                        remaining = remaining.slice(2000);
                    }
                }
            } else {
                await msg.reply(
                    `No server memory found for ${msg.guild.name}. Server memory is built automatically as users interact with the bot.`,
                );
            }
            return;
        }

        // Handle !profile command
        if (msg.content.trim().startsWith("!profile")) {
            const mentioned = msg.mentions.users.first();
            const targetUser = mentioned || msg.author;
            const profile = getUserProfile(targetUser.id);
            if (profile) {
                const header = `**Profile for ${targetUser.tag}:**\n`;
                const full = header + profile;
                if (full.length <= 2000) {
                    await msg.reply(full);
                } else {
                    const firstMax = 2000 - header.length;
                    await msg.reply(header + profile.slice(0, firstMax));
                    let remaining = profile.slice(firstMax);
                    while (remaining.length > 0) {
                        await (msg.channel as TextChannel).send(
                            remaining.slice(0, 2000),
                        );
                        remaining = remaining.slice(2000);
                    }
                }
            } else {
                await msg.reply(
                    `No profile found for ${targetUser.tag}. Profiles are built automatically as users interact with the bot.`,
                );
            }
            return;
        }

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
                // Collect attachments from referenced message
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

        // Save the incoming message
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

        // Show typing indicator while Claude thinks (re-send every 8s since it expires after ~10s)
        await msg.channel.sendTyping();
        const typingInterval = setInterval(() => {
            (msg.channel as TextChannel).sendTyping().catch(() => {});
        }, 8000);

        // Get response from Claude CLI
        const response = await askClaude(
            question,
            msg.author.tag,
            msg.author.id,
            msg.channel.name,
            msg.guild?.name || "DM",
            msg.guild?.id || "unknown",
            imagePaths,
        );

        clearInterval(typingInterval);
        console.error(
            `[Bot] Sending response (${response.length} chars) to #${msg.channel.name}`,
        );

        // Send the response (split if over 2000 chars)
        // Fall back to channel.send() if the original message was deleted
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

        // Append question and response to daily channel log
        appendToLog(
            msg.author.tag,
            rawQuestion,
            msg.channel.name,
            msg.createdAt,
        );
        appendToLog(botName + " (bot)", response, msg.channel.name);

        // Remove from pending
        removePending(msg.id);

        // Background jobs (fire and forget — don't block the response)
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

// Start the server
async function main() {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
        throw new Error("DISCORD_TOKEN environment variable is not set");
    }

    try {
        await client.login(token);

        // Start MCP HTTP server and write config for Claude CLI
        writeMcpConfig();
        startMcpHttpServer();
    } catch (error) {
        console.error("Fatal error in main():", error);
        process.exit(1);
    }
}

main();
