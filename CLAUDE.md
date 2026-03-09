# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

- **Build:** `npm run build` (runs `tsc`, outputs to `build/`)
- **Dev mode:** `npm run dev` (runs `tsc -w` for watch mode)
- **Start:** `npm start` (runs `node build/index.js`)
- **Test with MCP Inspector:** `npx @modelcontextprotocol/inspector node build/index.js`

No linter or test suite is configured.

## Workflow

- Always commit and push after making changes.

## Architecture

This is a Discord MCP (Model Context Protocol) server that serves two purposes:

1. **MCP Server (HTTP transport):** Exposes tools (`send-message`, `read-messages`, `read-message-history`, `fetch-messages`) that an MCP client (Claude Desktop, Claude Code) can call to interact with Discord.

2. **Auto-response bot:** Listens for `!ask <question>` commands, `@bot` mentions, and replies to bot messages in Discord, invokes the `claude` CLI (`claude -p`) to generate a response, and replies in the channel.

### File structure

```
src/
  index.ts                    — Entry point: boots Discord client, registers handler, starts MCP HTTP server
  config.ts                   — Environment variables, directory paths, constants
  claude.ts                   — runClaude() wrapper for spawning the Claude CLI
  askClaude.ts                — getSystemPrompt() + askClaude() orchestration (assembles prompts from history/profiles/memory)
  discord/
    client.ts                 — Discord.js Client singleton
    helpers.ts                — findGuild(), findChannel() resolution helpers
    handler.ts                — messageCreate listener: routes commands and handles !ask/@mention/reply flow
    commands/
      storage.ts              — !storage command
      usage.ts                — !usage command (rich embeds via ccusage)
      guild.ts                — !guild command (server memory)
      profile.ts              — !profile command (user profiles)
  storage/
    history.ts                — getDailyLogPath, appendToLog, loadRecentHistory
    pending.ts                — savePending, removePending
    profiles.ts               — getUserProfile, getServerMemory, backgroundProfileUpdate, backgroundServerMemoryUpdate
    summaries.ts              — getSummaryPath, loadRecentSummaries, generateDailySummary, ensureYesterdaySummaries
    images.ts                 — downloadAttachment
  mcp/
    server.ts                 — createMcpServer() factory, tool schemas, ListTools/CallTool handlers
    http.ts                   — writeMcpConfig(), startMcpHttpServer()
```

### Message flow (auto-response)

```
Discord user (!ask or @mention or reply)
  → savePending()
  → askClaude (spawns claude CLI with history + profile + server memory context)
  → reply in Discord
  → appendToLog() question + response
  → removePending()
  → background: update user profile, server memory, generate summaries
```

### Environment

- `DISCORD_TOKEN` — required, Discord bot token
- `MESSAGES_DIR` — optional, defaults to `./messages/` (contains `history/`, `pending/`, `profiles/`, `summaries/`, `images/` subdirs)
- `REQUIRED_ROLE_ID` — optional, restrict bot usage to a specific Discord role
- `MCP_PORT` — optional, HTTP MCP server port (default 3100)

### MCP Tools

| Tool | Purpose |
|------|---------|
| `send-message` | Send a message to a Discord channel |
| `read-messages` | Read recent messages from a Discord channel via Discord API |
| `read-message-history` | Read saved message text files from disk (history or pending) |
| `fetch-messages` | Fetch specific messages by Discord message links |

### Key dependencies

- `@modelcontextprotocol/sdk` — MCP server framework
- `discord.js` — Discord bot client
- `zod` — input validation for MCP tool arguments
