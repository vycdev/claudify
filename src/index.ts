import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from 'dotenv';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client, GatewayIntentBits, TextChannel, Message } from 'discord.js';
import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

// Load environment variables
dotenv.config();

// Message history directory
const MESSAGES_DIR = process.env.MESSAGES_DIR || path.join(process.cwd(), 'messages');
const REQUIRED_ROLE_ID = process.env.REQUIRED_ROLE_ID || '';
const HISTORY_DIR = path.join(MESSAGES_DIR, 'history');
const PENDING_DIR = path.join(MESSAGES_DIR, 'pending');

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
      .map(g => `"${g.name}"`).join(', ');
    throw new Error(`Bot is in multiple servers. Please specify server name or ID. Available servers: ${guildList}`);
  }

  // Try to fetch by ID first
  try {
    const guild = await client.guilds.fetch(guildIdentifier);
    if (guild) return guild;
  } catch {
    // If ID fetch fails, search by name
    const guilds = client.guilds.cache.filter(
      g => g.name.toLowerCase() === guildIdentifier.toLowerCase()
    );
    
    if (guilds.size === 0) {
      const availableGuilds = Array.from(client.guilds.cache.values())
        .map(g => `"${g.name}"`).join(', ');
      throw new Error(`Server "${guildIdentifier}" not found. Available servers: ${availableGuilds}`);
    }
    if (guilds.size > 1) {
      const guildList = guilds.map(g => `${g.name} (ID: ${g.id})`).join(', ');
      throw new Error(`Multiple servers found with name "${guildIdentifier}": ${guildList}. Please specify the server ID.`);
    }
    return guilds.first()!;
  }
  throw new Error(`Server "${guildIdentifier}" not found`);
}

// Helper function to find a channel by name or ID within a specific guild
async function findChannel(channelIdentifier: string, guildIdentifier?: string): Promise<TextChannel> {
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
        (channel.name.toLowerCase() === channelIdentifier.toLowerCase() ||
         channel.name.toLowerCase() === channelIdentifier.toLowerCase().replace('#', ''))
    );

    if (channels.size === 0) {
      const availableChannels = guild.channels.cache
        .filter((c): c is TextChannel => c instanceof TextChannel)
        .map(c => `"#${c.name}"`).join(', ');
      throw new Error(`Channel "${channelIdentifier}" not found in server "${guild.name}". Available channels: ${availableChannels}`);
    }
    if (channels.size > 1) {
      const channelList = channels.map(c => `#${c.name} (${c.id})`).join(', ');
      throw new Error(`Multiple channels found with name "${channelIdentifier}" in server "${guild.name}": ${channelList}. Please specify the channel ID.`);
    }
    return channels.first()!;
  }
  throw new Error(`Channel "${channelIdentifier}" is not a text channel or not found in server "${guild.name}"`);
}

// Save a message to a text file
function saveMessage(msg: Message, type: 'history' | 'pending' = 'history') {
  const dir = type === 'pending' ? PENDING_DIR : HISTORY_DIR;
  const timestamp = msg.createdAt.toISOString().replace(/[:.]/g, '-');
  const filename = `${timestamp}_${msg.id}.txt`;
  const content = [
    `ID: ${msg.id}`,
    `Author: ${msg.author.tag} (${msg.author.id})`,
    `Channel: #${(msg.channel as TextChannel).name}`,
    `Server: ${msg.guild?.name || 'DM'}`,
    `Timestamp: ${msg.createdAt.toISOString()}`,
    `---`,
    msg.content,
  ].join('\n');

  fs.writeFileSync(path.join(dir, filename), content, 'utf-8');
  return filename;
}

// Load recent history files for context
function loadRecentHistory(limit = 20): string {
  const files = fs.readdirSync(HISTORY_DIR)
    .filter(f => f.endsWith('.txt'))
    .sort()
    .slice(-limit);

  if (files.length === 0) return 'No previous conversation history.';

  return files.map(f => fs.readFileSync(path.join(HISTORY_DIR, f), 'utf-8')).join('\n\n===\n\n');
}

// Invoke Claude Code CLI to answer a question
const SYSTEM_PROMPT = [
  `You are an AI Discord bot. You have access to a Discord MCP server and message history files in the messages directory.`,
  ``,
  `Personality and behavior:`,
  `- Talk casually, like a regular person in a Discord server. No corporate speak.`,
  `- Be concise by default. Short, direct answers. No filler.`,
  `- When someone asks you to elaborate or the topic is complex, go deeper. But don't over-explain unprompted.`,
  `- Have actual opinions. Don't fence-sit or "both sides" everything. Pick a side and say why.`,
  `- Don't be sycophantic. No "Great question!" or "That's a really interesting point!" Just answer.`,
  `- Don't try to mediate or play peacekeeper. If someone's wrong, say so.`,
  `- Keep responses under 2000 characters (Discord's limit).`,
  `- You can read and write to the messages directory for memory across conversations.`,
].join('\n');

async function askClaude(question: string, author: string, channelName: string, serverName: string): Promise<string> {
  const recentHistory = loadRecentHistory(10);

  const prompt = [
    `Recent conversation history for context:`,
    recentHistory,
    ``,
    `Current question from ${author} in #${channelName} (${serverName}):`,
    question,
  ].join('\n');

  try {
    console.error(`[Claude CLI] Spawning claude with prompt (${prompt.length} chars)`);
    // Clean env to avoid MCP/stdio conflicts with the spawned CLI
    const cleanEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) cleanEnv[key] = value;
    }
    // Remove MCP-related vars that could interfere
    delete cleanEnv.MCP_SERVER_NAME;

    const { stdout, stderr } = await execFileAsync('claude', [
      '-p',
      '--system-prompt', SYSTEM_PROMPT,
      '--tools', 'WebSearch,WebFetch,Read,Write',
      '--allowedTools', 'WebSearch,WebFetch,Read,Write',
      '--add-dir', MESSAGES_DIR,
      prompt,
    ], {
      timeout: 120000, // 2 minute timeout
      maxBuffer: 1024 * 1024,
      env: cleanEnv,
    });
    if (stderr) console.error(`[Claude CLI] stderr: ${stderr}`);
    console.error(`[Claude CLI] Response received (${stdout.length} chars)`);
    return stdout.trim() || 'Sorry, I could not generate a response.';
  } catch (error: any) {
    console.error(`[Claude CLI] Error: ${error.message}`);
    if (error.stderr) console.error(`[Claude CLI] stderr: ${error.stderr}`);
    if (error.stdout) console.error(`[Claude CLI] stdout: ${error.stdout}`);
    return 'Sorry, I encountered an error processing your request.';
  }
}

// Updated validation schemas
const SendMessageSchema = z.object({
  server: z.string().optional().describe('Server name or ID (optional if bot is only in one server)'),
  channel: z.string().describe('Channel name (e.g., "general") or ID'),
  message: z.string(),
});

const ReadMessagesSchema = z.object({
  server: z.string().optional().describe('Server name or ID (optional if bot is only in one server)'),
  channel: z.string().describe('Channel name (e.g., "general") or ID'),
  limit: z.number().min(1).max(100).default(50),
});

// Create server instance
const server = new Server(
  {
    name: "discord",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "send-message",
        description: "Send a message to a Discord channel",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: 'Server name or ID (optional if bot is only in one server)',
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
        description: "Read saved message history files from disk (messages exchanged via !ask or bot mentions)",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Number of recent history entries to read (default 20)",
              default: 20,
            },
            type: {
              type: "string",
              enum: ["history", "pending"],
              description: "Read from history (past exchanges) or pending (unanswered questions)",
              default: "history",
            },
          },
        },
      },
      {
        name: "read-messages",
        description: "Read recent messages from a Discord channel",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: 'Server name or ID (optional if bot is only in one server)',
            },
            channel: {
              type: "string",
              description: 'Channel name (e.g., "general") or ID',
            },
            limit: {
              type: "number",
              description: "Number of messages to fetch (max 100)",
              default: 50,
            },
          },
          required: ["channel"],
        },
      },
    ],
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "send-message": {
        const { channel: channelIdentifier, message } = SendMessageSchema.parse(args);
        const channel = await findChannel(channelIdentifier);
        
        const sent = await channel.send(message);
        return {
          content: [{
            type: "text",
            text: `Message sent successfully to #${channel.name} in ${channel.guild.name}. Message ID: ${sent.id}`,
          }],
        };
      }

      case "read-message-history": {
        const limit = (args as any)?.limit ?? 20;
        const type = (args as any)?.type === 'pending' ? 'pending' : 'history';
        const dir = type === 'pending' ? PENDING_DIR : HISTORY_DIR;

        const files = fs.readdirSync(dir)
          .filter(f => f.endsWith('.txt'))
          .sort()
          .slice(-limit);

        if (files.length === 0) {
          return {
            content: [{ type: "text", text: `No ${type} messages found.` }],
          };
        }

        const messages = files.map(f => fs.readFileSync(path.join(dir, f), 'utf-8'));
        return {
          content: [{ type: "text", text: messages.join('\n\n===\n\n') }],
        };
      }

      case "read-messages": {
        const { channel: channelIdentifier, limit } = ReadMessagesSchema.parse(args);
        const channel = await findChannel(channelIdentifier);
        
        const messages = await channel.messages.fetch({ limit });
        const formattedMessages = Array.from(messages.values()).map(msg => ({
          channel: `#${channel.name}`,
          server: channel.guild.name,
          author: msg.author.tag,
          content: msg.content,
          timestamp: msg.createdAt.toISOString(),
        }));

        return {
          content: [{
            type: "text",
            text: JSON.stringify(formattedMessages, null, 2),
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        `Invalid arguments: ${error.errors
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join(", ")}`
      );
    }
    throw error;
  }
});

// Discord client login and error handling
client.once('ready', () => {
  console.error('Discord bot is ready!');
  console.error(`Messages will be saved to: ${MESSAGES_DIR}`);
});

// Listen for !ask commands and bot mentions
client.on('messageCreate', async (msg: Message) => {
  try {
    if (msg.author.bot) return;
    if (!(msg.channel instanceof TextChannel)) return;

    const isMention = msg.mentions.has(client.user!);
    const isAskCommand = msg.content.startsWith('!ask ');
    const isReplyToBot = msg.reference?.messageId
      ? (await msg.channel.messages.fetch(msg.reference.messageId).catch(() => null))?.author?.id === client.user!.id
      : false;

    if (!isMention && !isAskCommand && !isReplyToBot) return;

    const triggerType = isAskCommand ? '!ask' : isReplyToBot ? 'reply' : '@mention';
    console.error(`[Bot] Received ${triggerType} from ${msg.author.tag} in #${(msg.channel as TextChannel).name}: ${msg.content}`);

    // Check role permission
    if (REQUIRED_ROLE_ID && msg.member && !msg.member.roles.cache.has(REQUIRED_ROLE_ID)) {
      console.error(`[Bot] Rejected: ${msg.author.tag} missing role ${REQUIRED_ROLE_ID}`);
      await msg.reply("You can't use this command because you don't have the required role.");
      return;
    }

    // Extract the question
    const question = isAskCommand
      ? msg.content.slice(5).trim()
      : msg.content.replace(`<@${client.user!.id}>`, '').trim() || msg.content.trim();

    if (!question) {
      console.error(`[Bot] Empty question from ${msg.author.tag}`);
      await msg.reply('Please provide a question! Usage: `!ask <your question>` or mention me with a question.');
      return;
    }

    console.error(`[Bot] Processing question: "${question}"`);

    // Save the incoming message
    saveMessage(msg, 'pending');

    // Show typing indicator while Claude thinks
    await msg.channel.sendTyping();

    // Get response from Claude CLI
    const response = await askClaude(
      question,
      msg.author.tag,
      msg.channel.name,
      msg.guild?.name || 'DM'
    );

    console.error(`[Bot] Sending response (${response.length} chars) to #${msg.channel.name}`);

    // Send the response (split if over 2000 chars)
    if (response.length <= 2000) {
      await msg.reply(response);
    } else {
      const chunks: string[] = [];
      let current = '';
      for (const line of response.split('\n')) {
        if (current.length + line.length + 1 > 2000) {
          chunks.push(current);
          current = line;
        } else {
          current += (current ? '\n' : '') + line;
        }
      }
      if (current) chunks.push(current);
      for (const chunk of chunks) {
        await msg.channel.send(chunk);
      }
    }

    console.error(`[Bot] Response sent successfully`);

    // Save both the question and response to history
    saveMessage(msg, 'history');

    // Save Claude's response as a history file too
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const responseFile = `${timestamp}_claude-response.txt`;
    const responseContent = [
      `ID: claude-response`,
      `Author: Claude (bot)`,
      `Channel: #${msg.channel.name}`,
      `Server: ${msg.guild?.name || 'DM'}`,
      `In-Reply-To: ${msg.id} (${msg.author.tag})`,
      `Timestamp: ${new Date().toISOString()}`,
      `---`,
      response,
    ].join('\n');
    fs.writeFileSync(path.join(HISTORY_DIR, responseFile), responseContent, 'utf-8');

    // Remove from pending
    const pendingFiles = fs.readdirSync(PENDING_DIR).filter(f => f.includes(msg.id));
    for (const f of pendingFiles) {
      fs.unlinkSync(path.join(PENDING_DIR, f));
    }
  } catch (error: any) {
    console.error(`[Bot] Unhandled error in messageCreate: ${error.message}`);
    console.error(error.stack);
    try {
      await msg.reply('Sorry, something went wrong while processing your request.');
    } catch { /* ignore reply failure */ }
  }
});

// Start the server
async function main() {
  // Check for Discord token
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error('DISCORD_TOKEN environment variable is not set');
  }
  
  try {
    // Login to Discord
    await client.login(token);

    // Start MCP server
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Discord MCP Server running on stdio");
  } catch (error) {
    console.error("Fatal error in main():", error);
    process.exit(1);
  }
}

main();