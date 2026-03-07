# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

- **Build:** `npm run build` (runs `tsc`, outputs to `build/`)
- **Dev mode:** `npm run dev` (runs `tsc -w` for watch mode)
- **Start:** `npm start` (runs `node build/index.js`)
- **Test with MCP Inspector:** `npx @modelcontextprotocol/inspector node build/index.js`

No linter or test suite is configured.

## Architecture

This is a Discord MCP (Model Context Protocol) server that serves two purposes:

1. **MCP Server (stdio transport):** Exposes tools (`send-message`, `read-messages`, `read-message-history`) that an MCP client (Claude Desktop, Claude Code) can call to interact with Discord.

2. **Auto-response bot:** Listens for `!ask <question>` commands and `@bot` mentions in Discord, invokes the `claude` CLI (`claude -p`) to generate a response, and replies in the channel.

### Single file: `src/index.ts`

Everything lives in one file. Key sections:

- **Discord.js client** with `Guilds`, `GuildMessages`, `MessageContent` intents
- **`findGuild` / `findChannel` helpers** — resolve servers/channels by name or ID
- **`saveMessage` / `loadRecentHistory`** — persist messages as text files in `messages/history/` and `messages/pending/`
- **`askClaude`** — spawns `claude -p` with the question and recent history context, captures stdout
- **MCP server setup** — `ListToolsRequestSchema` and `CallToolRequestSchema` handlers
- **`messageCreate` listener** — the auto-response loop that ties Discord messages to Claude CLI

### Message flow (auto-response)

```
Discord user (!ask or @mention)
  → saveMessage to pending/
  → askClaude (spawns claude CLI with history context)
  → reply in Discord
  → save question + response to history/
  → remove from pending/
```

### Environment

- `DISCORD_TOKEN` — required, Discord bot token
- `MESSAGES_DIR` — optional, defaults to `./messages/` (contains `history/` and `pending/` subdirs)

### MCP Tools

| Tool | Purpose |
|------|---------|
| `send-message` | Send a message to a Discord channel |
| `read-messages` | Read recent messages from a Discord channel via Discord API |
| `read-message-history` | Read saved message text files from disk (history or pending) |

### Key dependencies

- `@modelcontextprotocol/sdk` — MCP server framework
- `discord.js` — Discord bot client
- `zod` — input validation for MCP tool arguments
