import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import dotenv from 'dotenv';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client, GatewayIntentBits, TextChannel, Message } from 'discord.js';
import { z } from 'zod';
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

function runClaude(args: string[], input: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      env: (() => {
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
          if (value !== undefined) env[key] = value;
        }
        delete env.MCP_SERVER_NAME;
        return env;
      })(),
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err: any = new Error(`Claude CLI exited with code ${code}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });

    proc.on('error', reject);

    proc.stdin.write(input);
    proc.stdin.end();

    setTimeout(() => {
      proc.kill();
      reject(new Error('Claude CLI timed out after 120 seconds'));
    }, 120000);
  });
}

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

// User profiles directory
const PROFILES_DIR = path.join(MESSAGES_DIR, 'profiles');
const SUMMARIES_DIR = path.join(MESSAGES_DIR, 'summaries');
fs.mkdirSync(PROFILES_DIR, { recursive: true });
fs.mkdirSync(SUMMARIES_DIR, { recursive: true });

const PROFILE_MAX_CHARS = 500;

// Get the daily log filename for a channel: #general_2026-03-07.txt
function getDailyLogPath(channelName: string, date: Date = new Date()): string {
  const dateStr = date.toISOString().split('T')[0];
  const safeName = channelName.replace(/[^a-zA-Z0-9-_]/g, '_');
  return path.join(HISTORY_DIR, `${safeName}_${dateStr}.txt`);
}

// Append a message to the daily channel log
function appendToLog(author: string, content: string, channelName: string, timestamp: Date = new Date()) {
  const filePath = getDailyLogPath(channelName, timestamp);
  const time = timestamp.toTimeString().split(' ')[0];
  const line = `[${time}] ${author}: ${content}\n`;
  fs.appendFileSync(filePath, line, 'utf-8');
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
  ].join('\n');
  fs.writeFileSync(path.join(PENDING_DIR, filename), content, 'utf-8');
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
    const dateStr = yesterday.toISOString().split('T')[0];
    parts.push(`--- Yesterday (${dateStr}) summary ---\n${fs.readFileSync(yesterdaySummary, 'utf-8').trim()}`);
  } else if (fs.existsSync(yesterdayLog)) {
    const content = fs.readFileSync(yesterdayLog, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length > 0) {
      parts.push(`--- Yesterday ---\n${lines.slice(-30).join('\n')}`);
    }
  }

  // Today: raw messages (capped at 50)
  const todayPath = getDailyLogPath(channelName);
  if (fs.existsSync(todayPath)) {
    const content = fs.readFileSync(todayPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length > 50) {
      parts.push(`--- Today (last 50 of ${lines.length} messages) ---\n${lines.slice(-50).join('\n')}`);
    } else {
      parts.push(`--- Today ---\n${content}`);
    }
  }

  return parts.join('\n\n').trim() || 'No previous conversation history.';
}

// Load user profile
function getUserProfile(userId: string): string {
  const filePath = path.join(PROFILES_DIR, `${userId}.txt`);
  if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf-8');
  return '';
}

// Get summary file path for a channel+date
function getSummaryPath(channelName: string, date: Date): string {
  const dateStr = date.toISOString().split('T')[0];
  const safeName = channelName.replace(/[^a-zA-Z0-9-_]/g, '_');
  return path.join(SUMMARIES_DIR, `${safeName}_${dateStr}.txt`);
}

// Load summaries for the past N days (excluding today)
function loadRecentSummaries(channelName: string, days: number = 7): string {
  const summaries: string[] = [];
  for (let i = 1; i <= days; i++) {
    const date = new Date(Date.now() - i * 86400000);
    const summaryPath = getSummaryPath(channelName, date);
    if (fs.existsSync(summaryPath)) {
      const dateStr = date.toISOString().split('T')[0];
      summaries.push(`[${dateStr}] ${fs.readFileSync(summaryPath, 'utf-8').trim()}`);
    }
  }
  return summaries.reverse().join('\n\n');
}

// Generate a summary for a day's channel log (runs in background)
async function generateDailySummary(channelName: string, date: Date): Promise<void> {
  const logPath = getDailyLogPath(channelName, date);
  const summaryPath = getSummaryPath(channelName, date);

  // Skip if no log or summary already exists
  if (!fs.existsSync(logPath) || fs.existsSync(summaryPath)) return;

  const log = fs.readFileSync(logPath, 'utf-8').trim();
  if (!log || log.split('\n').length < 3) {
    // Too short to summarize — just copy as-is
    fs.writeFileSync(summaryPath, log, 'utf-8');
    return;
  }

  try {
    const dateStr = date.toISOString().split('T')[0];
    console.error(`[Summary] Generating summary for #${channelName} on ${dateStr}`);
    const { stdout } = await runClaude([
      '-p',
      '--model', 'haiku',
      '--system-prompt', 'You are a conversation summarizer. Summarize the following Discord chat log into a concise paragraph (max 200 words). Focus on key topics discussed, decisions made, and important information shared. Do not include greetings, small talk, or filler. Output ONLY the summary, no preamble.',
    ], log);

    if (stdout.trim()) {
      fs.writeFileSync(summaryPath, stdout.trim(), 'utf-8');
      console.error(`[Summary] Saved summary for #${channelName} on ${dateStr}`);
    }
  } catch (err: any) {
    console.error(`[Summary] Failed to generate summary: ${err.message}`);
  }
}

// Background: update user profile after a conversation
async function backgroundProfileUpdate(authorTag: string, authorId: string, question: string, response: string): Promise<void> {
  const profilePath = path.join(PROFILES_DIR, `${authorId}.txt`);
  const existingProfile = getUserProfile(authorId);

  try {
    const prompt = [
      `Current profile for ${authorTag} (may be empty):`,
      existingProfile || '(no profile yet)',
      '',
      `Latest exchange:`,
      `${authorTag}: ${question}`,
      `Bot: ${response}`,
      '',
      `Task: Based on this exchange, output an updated user profile. Include ONLY lasting facts about the user (name, preferences, expertise, interests, projects, etc). Keep it under ${PROFILE_MAX_CHARS} characters. If you learned nothing new, output the existing profile unchanged. Output ONLY the profile text, no preamble or explanation.`,
    ].join('\n');

    const { stdout } = await runClaude([
      '-p',
      '--model', 'haiku',
    ], prompt);

    const newProfile = stdout.trim();
    if (newProfile && newProfile !== existingProfile.trim()) {
      // Enforce size cap
      const capped = newProfile.slice(0, PROFILE_MAX_CHARS);
      fs.writeFileSync(profilePath, capped, 'utf-8');
      console.error(`[Profile] Updated profile for ${authorTag} (${capped.length} chars)`);
    }
  } catch (err: any) {
    console.error(`[Profile] Failed to update profile for ${authorTag}: ${err.message}`);
  }
}

// Check and generate summaries for yesterday (called on bot activity)
async function ensureYesterdaySummaries(): Promise<void> {
  const yesterday = new Date(Date.now() - 86400000);
  try {
    const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.txt'));
    const dateStr = yesterday.toISOString().split('T')[0];
    const yesterdayFiles = files.filter(f => f.includes(dateStr));
    for (const file of yesterdayFiles) {
      const channelName = file.replace(`_${dateStr}.txt`, '');
      await generateDailySummary(channelName, yesterday);
    }
  } catch (err: any) {
    console.error(`[Summary] Error checking yesterday summaries: ${err.message}`);
  }
}

// Invoke Claude Code CLI to answer a question
function getSystemPrompt(): string {
  const botName = client.user?.displayName || client.user?.username || 'Claudify';
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
    `- You can read and write to the messages directory for memory across conversations.`,
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
  ].join('\n');
}

const IMAGES_DIR = path.join(MESSAGES_DIR, 'images');
fs.mkdirSync(IMAGES_DIR, { recursive: true });

async function downloadAttachment(url: string, filename: string): Promise<string> {
  const response = await fetch(url);
  const buffer = Buffer.from(await response.arrayBuffer());
  const filePath = path.join(IMAGES_DIR, filename);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

async function askClaude(question: string, author: string, authorId: string, channelName: string, serverName: string, imagePaths: string[] = []): Promise<string> {
  const recentHistory = loadRecentHistory(channelName);
  const userProfile = getUserProfile(authorId);

  const promptParts = [
    `Recent conversation history in #${channelName}:`,
    recentHistory,
  ];

  promptParts.push('');
  if (userProfile) {
    promptParts.push(`Known info about ${author}:`);
    promptParts.push(userProfile);
  }

  promptParts.push('');
  promptParts.push(`Current question from ${author} in #${channelName} (${serverName}):`);
  promptParts.push(question);

  if (imagePaths.length > 0) {
    promptParts.push('');
    promptParts.push(`The user attached ${imagePaths.length} image(s). Use the Read tool to view them:`);
    for (const imgPath of imagePaths) {
      promptParts.push(`- ${imgPath}`);
    }
  }

  const prompt = promptParts.join('\n');

  try {
    console.error(`[Claude CLI] Spawning claude with prompt via stdin (${prompt.length} chars)`);

    const { stdout, stderr } = await runClaude([
      '-p',
      '--model', 'sonnet',
      '--system-prompt', getSystemPrompt(),
      '--allowedTools', 'WebSearch,WebFetch,Read,Write,mcp__discord__send-message,mcp__discord__read-messages,mcp__discord__read-message-history',
      '--add-dir', MESSAGES_DIR,
      '--mcp-config', MCP_CONFIG_PATH,
    ], prompt);

    if (stderr) console.error(`[Claude CLI] stderr: ${stderr}`);
    console.error(`[Claude CLI] Response received (${stdout.length} chars)`);
    if (!stdout.trim()) {
      console.error(`[Claude CLI] WARNING: Empty response. Claude CLI may not be authenticated. Run: docker exec -it <container> claude auth login`);
    }
    return stdout.trim() || 'Sorry, I could not generate a response. The bot may not be authenticated yet — check the server logs.';
  } catch (error: any) {
    console.error(`[Claude CLI] Error: ${error.message}`);
    if (error.stderr) console.error(`[Claude CLI] stderr: ${error.stderr}`);
    if (error.stdout) console.error(`[Claude CLI] stdout: ${error.stdout}`);
    return 'Sorry, I encountered an error processing your request.';
  }
}

// Validation schemas for MCP tools
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

// Factory: creates a fresh MCP Server with Discord tools registered
function createMcpServer(): Server {
  const mcpServer = new Server(
    { name: "discord", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "send-message",
        description: "Send a message to a Discord channel",
        inputSchema: {
          type: "object" as const,
          properties: {
            server: { type: "string", description: 'Server name or ID (optional if bot is only in one server)' },
            channel: { type: "string", description: 'Channel name (e.g., "general") or ID' },
            message: { type: "string", description: "Message content to send" },
          },
          required: ["channel", "message"],
        },
      },
      {
        name: "read-message-history",
        description: "Read saved message history files from disk (messages exchanged via !ask or bot mentions)",
        inputSchema: {
          type: "object" as const,
          properties: {
            limit: { type: "number", description: "Number of recent history entries to read (default 20)", default: 20 },
            type: { type: "string", enum: ["history", "pending"], description: "Read from history or pending", default: "history" },
          },
        },
      },
      {
        name: "read-messages",
        description: "Read recent messages from a Discord channel (live from Discord API)",
        inputSchema: {
          type: "object" as const,
          properties: {
            server: { type: "string", description: 'Server name or ID (optional if bot is only in one server)' },
            channel: { type: "string", description: 'Channel name (e.g., "general") or ID' },
            limit: { type: "number", description: "Number of messages to fetch (max 100)", default: 50 },
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
          const { channel: channelIdentifier, message } = SendMessageSchema.parse(args);
          const channel = await findChannel(channelIdentifier);
          const sent = await channel.send(message);
          return { content: [{ type: "text", text: `Message sent to #${channel.name}. ID: ${sent.id}` }] };
        }
        case "read-message-history": {
          const limit = (args as any)?.limit ?? 20;
          const type = (args as any)?.type === 'pending' ? 'pending' : 'history';
          const dir = type === 'pending' ? PENDING_DIR : HISTORY_DIR;
          const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt')).sort().slice(-limit);
          if (files.length === 0) return { content: [{ type: "text", text: `No ${type} messages found.` }] };
          const messages = files.map(f => fs.readFileSync(path.join(dir, f), 'utf-8'));
          return { content: [{ type: "text", text: messages.join('\n\n===\n\n') }] };
        }
        case "read-messages": {
          const { channel: channelIdentifier, limit } = ReadMessagesSchema.parse(args);
          const channel = await findChannel(channelIdentifier);
          const messages = await channel.messages.fetch({ limit });
          const formatted = Array.from(messages.values()).map(msg => ({
            channel: `#${channel.name}`, server: channel.guild.name,
            author: msg.author.tag, content: msg.content, timestamp: msg.createdAt.toISOString(),
          }));
          return { content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }] };
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(`Invalid arguments: ${error.errors.map(e => `${e.path.join(".")}: ${e.message}`).join(", ")}`);
      }
      throw error;
    }
  });

  return mcpServer;
}

// MCP HTTP server port (internal, not exposed to internet)
const MCP_PORT = parseInt(process.env.MCP_PORT || '3100', 10);

// MCP config file for Claude CLI
const MCP_CONFIG_PATH = path.join(MESSAGES_DIR, '.mcp-config.json');

function writeMcpConfig() {
  const config = {
    mcpServers: {
      discord: {
        url: `http://localhost:${MCP_PORT}/mcp`,
      },
    },
  };
  fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  console.error(`[MCP] Config written to ${MCP_CONFIG_PATH}`);
}

// Start HTTP MCP server
function startMcpHttpServer(): http.Server {
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${MCP_PORT}`);
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end('Not found');
      return;
    }

    if (req.method === 'POST') {
      // Stateless: create fresh server + transport per request
      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
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
          res.writeHead(500).end(JSON.stringify({
            jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null,
          }));
        }
      } finally {
        await transport.close().catch(() => {});
        await mcpServer.close().catch(() => {});
      }
    } else if (req.method === 'GET' || req.method === 'DELETE') {
      // Stateless mode: no sessions, reject GET/DELETE
      res.writeHead(405).end(JSON.stringify({
        jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless mode)' }, id: null,
      }));
    } else {
      res.writeHead(405).end();
    }
  });

  httpServer.listen(MCP_PORT, '127.0.0.1', () => {
    console.error(`[MCP HTTP] Streamable HTTP server listening on http://127.0.0.1:${MCP_PORT}/mcp`);
  });

  return httpServer;
}

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

    // Handle !storage command
    if (msg.content.trim() === '!storage') {
      console.error(`[Bot] Storage requested by ${msg.author.tag}`);
      const countFiles = (dir: string) => {
        try { return fs.readdirSync(dir).filter(f => f.endsWith('.txt')).length; } catch { return 0; }
      };
      const getDirSize = (dir: string): number => {
        try {
          return fs.readdirSync(dir).reduce((total, file) => {
            const filePath = path.join(dir, file);
            const stat = fs.statSync(filePath);
            return total + (stat.isDirectory() ? getDirSize(filePath) : stat.size);
          }, 0);
        } catch { return 0; }
      };
      const formatSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
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
      ].join('\n');

      await msg.reply('```\n' + output + '\n```');
      return;
    }

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

    // Fetch referenced message if this is a reply
    let replyContext = '';
    const allAttachments: { url: string; name: string }[] = [];
    if (msg.reference?.messageId) {
      const refMsg = await msg.channel.messages.fetch(msg.reference.messageId).catch(() => null);
      if (refMsg) {
        replyContext = `[Replying to ${refMsg.author.tag}: "${refMsg.content}"]\n`;
        console.error(`[Bot] Reply context from ${refMsg.author.tag}: ${refMsg.content}`);
        // Collect attachments from referenced message
        for (const att of refMsg.attachments.values()) {
          if (att.contentType?.startsWith('image/')) {
            allAttachments.push({ url: att.url, name: `ref_${att.id}_${att.name || 'image.png'}` });
          }
        }
      }
    }

    // Collect attachments from current message
    for (const att of msg.attachments.values()) {
      if (att.contentType?.startsWith('image/')) {
        allAttachments.push({ url: att.url, name: `${att.id}_${att.name || 'image.png'}` });
      }
    }

    // Extract the question
    const botName = client.user?.displayName || client.user?.username || 'Claudify';
    const rawQuestion = isAskCommand
      ? msg.content.slice(5).trim()
      : msg.content.replace(`<@${client.user!.id}>`, botName).trim();
    const question = replyContext + rawQuestion;

    if (!rawQuestion) {
      console.error(`[Bot] Empty question from ${msg.author.tag}`);
      await msg.reply('Please provide a question! Usage: `!ask <your question>` or mention me with a question.');
      return;
    }

    console.error(`[Bot] Processing question: "${question}" (${allAttachments.length} images)`);

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
        console.error(`[Bot] Failed to download image ${att.name}: ${err.message}`);
      }
    }

    // Show typing indicator while Claude thinks
    await msg.channel.sendTyping();

    // Get response from Claude CLI
    const response = await askClaude(
      question,
      msg.author.tag,
      msg.author.id,
      msg.channel.name,
      msg.guild?.name || 'DM',
      imagePaths
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

    // Append question and response to daily channel log
    appendToLog(msg.author.tag, rawQuestion, msg.channel.name, msg.createdAt);
    appendToLog(botName + ' (bot)', response, msg.channel.name);

    // Remove from pending
    removePending(msg.id);

    // Background jobs (fire and forget — don't block the response)
    backgroundProfileUpdate(msg.author.tag, msg.author.id, rawQuestion, response).catch(() => {});
    ensureYesterdaySummaries().catch(() => {});
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
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error('DISCORD_TOKEN environment variable is not set');
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