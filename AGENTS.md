# CLAUDE.md

Project guidance for Claude Code when working in this repository.

## Build & Run

- **Build:** `npm run build` (runs `tsc`, outputs to `build/`)
- **Test:** `npm test` (builds, then runs `node --test tests/*.test.mjs`)
- **Dev:** `npm run dev` (runs `tsc -w` for watch mode)
- **Start:** `npm start` (runs `node build/index.js`)
- **MCP Inspector:** `npx @modelcontextprotocol/inspector node build/index.js`

No linter is configured. Always run `npm test` after changes; `npm run build`
is the minimum compilation gate when tests cannot run.

## Workflow

- Always commit and push after making changes.
- Build before committing to catch type errors.

## Project Overview

Claudify is a Discord bot + MCP server built with TypeScript (ES Modules, Node16 resolution). It has two roles:

1. **Auto-response bot** — Responds to `!ask`, `@mentions`, replies to bot messages, and 🤖 reactions. Spawns the Claude CLI (`claude -p`) with assembled context (history, profiles, server memory, live messages) to generate responses.

2. **MCP Server (HTTP)** — Exposes Discord tools over HTTP so external MCP clients (Claude Desktop, Claude Code) can interact with Discord programmatically.

## Architecture

### Layered structure

```
src/
├── index.ts              → Entry point (bootstrap only — no logic)
├── config.ts             → All env vars, paths, constants, directory setup
├── claude.ts             → Claude CLI process spawner (no project deps)
├── askClaude.ts          → System prompt + prompt assembly + Claude invocation
│
├── discord/              → Discord client and event handling
│   ├── client.ts         → Client singleton (intents config)
│   ├── helpers.ts        → Guild/channel resolution utilities
│   ├── split.ts          → Discord message splitting + code fence balancing
│   ├── handler.ts        → Event listeners (messageCreate, messageReactionAdd)
│   └── commands/         → Command handlers (one file per command)
│       ├── help.ts       → !help — command list and bot info
│       ├── storage.ts    → !storage — file/directory stats
│       ├── usage.ts      → !usage — token usage via ccusage (rich embeds)
│       ├── guild.ts      → !guild — server memory display
│       └── profile.ts    → !profile — user profile display
│
├── storage/              → Persistent data management (filesystem-based)
│   ├── history.ts        → Daily conversation logs (append-only text files)
│   ├── pending.ts        → In-flight message tracking
│   ├── profiles.ts       → User profiles + server memory (background Claude updates)
│   ├── summaries.ts      → Daily conversation summaries (background Claude generation)
│   └── images.ts         → Attachment downloads
│
└── mcp/                  → MCP server implementation
    ├── server.ts         → Tool schemas, ListTools/CallTool handlers
    └── http.ts           → HTTP transport, config file generation
```

### Design principles

- **Separation of concerns**: Discord handling, storage, AI invocation, and MCP are isolated layers. They communicate through well-defined function signatures, not shared state.
- **One file per command**: Each `!command` gets its own file in `discord/commands/`. To add a new command, create a new file and add the route in `handler.ts`.
- **Background processing**: Profile updates, server memory updates, and summary generation run async after the response is sent. They must never block the user-facing response.
- **No circular imports**: `storage/` modules must not import from `discord/`. `summaries.ts` has its own `getLogPath()` to avoid circular dependency with `history.ts`.
- **Config as single source of truth**: All paths, limits, and tunables live in `config.ts`. Never hardcode paths or magic numbers elsewhere.

### Key conventions

- **ES Modules**: All imports use `.js` extensions (Node16 module resolution).
- **Strict TypeScript**: `strict: true` in tsconfig. No `any` except in catch blocks.
- **Model selection**: Every Claude CLI caller passes a typed workload to
  `runClaude()`. `CLAUDE_WORKLOAD_CONFIG` resolves response, profile-update,
  server-memory-update, and daily-summary settings once at startup. Workload
  overrides inherit `BOT_MODEL`/`BOT_EFFORT` by default; do not bypass this map
  or re-read environment variables per request.
- **Error handling**: Catch at boundaries (event handlers, background jobs). Log with `console.error` and prefixed tags like `[Bot]`, `[Claude CLI]`, `[Profile]`, `[Summary]`.
- **Discord limits**: Messages max 2000 chars, 10 embeds per message. The `smartSplit()` function in `split.ts` handles splitting.

## Data flow

### Auto-response (message trigger)

```
User message (trigger: !ask / @mention / reply / 🤖 reaction)
  → Cooldown check (per-user, COOLDOWN_MS)
  → Role permission check (REQUIRED_ROLE_ID)
  → Save to pending/
  → Download image attachments
  → Fetch live channel context (last 25 Discord messages)
  → Load saved history + summaries + user profile + server memory
  → askClaude() → runClaude() → Claude CLI subprocess
  → Parse response:
      - [REACT:emoji] → React to message, skip text reply
      - Text → smartSplit() → Send as reply (chunked if needed)
  → Log to history
  → Remove from pending/
  → Background: profile update, server memory update, yesterday summaries
```

### MCP request

```
HTTP POST /mcp → Parse JSON-RPC → Route to tool handler → Execute → JSON response
```

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_TOKEN` | Yes | — | Discord bot token |
| `MESSAGES_DIR` | No | `./messages/` | Root storage directory |
| `REQUIRED_ROLE_ID` | No | `""` (anyone) | Discord role ID for access control |
| `AUTH_ADMIN_USER_IDS` | No | `""` (disabled) | Comma-separated Discord user IDs allowed to manage Claude CLI authentication |
| `CLAUDE_AUTH_LOGIN_TIMEOUT_MS` | No | `300000` | Timeout for an interactive Discord authentication session |
| `COOLDOWN_MS` | No | `10000` | Per-user cooldown in ms |
| `BOT_MODEL` | No | `claude-haiku-4-5` | Global Claude model fallback |
| `BOT_EFFORT` | No | `""` | Global Claude Code `--effort` fallback (`low`, `medium`, `high`, `xhigh`, `max`) |
| `CLAUDE_RESPONSE_MODEL` | No | inherit | Model for user-facing responses |
| `CLAUDE_RESPONSE_EFFORT` | No | inherit | Effort for user-facing responses |
| `CLAUDE_PROFILE_MODEL` | No | inherit | Model for background profile updates |
| `CLAUDE_PROFILE_EFFORT` | No | inherit | Effort for background profile updates |
| `CLAUDE_SERVER_MEMORY_MODEL` | No | inherit | Model for background server-memory updates |
| `CLAUDE_SERVER_MEMORY_EFFORT` | No | inherit | Effort for background server-memory updates |
| `CLAUDE_SUMMARY_MODEL` | No | inherit | Model for daily summaries |
| `CLAUDE_SUMMARY_EFFORT` | No | inherit | Effort for daily summaries |
| `SUPPRESS_MENTIONS` | No | `false` | Prevent bot messages from notifying users, roles, `@everyone`, or `@here` |
| `MCP_PORT` | No | `3100` | HTTP MCP server port |
| `MORPHEUS_MCP_URL` | No | — | Morpheus Streamable HTTP MCP endpoint; requires `MORPHEUS_MCP_API_KEY` |
| `MORPHEUS_MCP_API_KEY` | No | — | Bearer token for the configured Morpheus MCP endpoint |

Per-workload model and effort properties resolve independently. Blank, unset,
or `inherit` values inherit the corresponding global value; `default` omits the
Claude CLI setting for that workload. Invalid workload overrides warn at
startup and inherit the global fallback. Configuration changes require a
restart because the typed routing table is immutable after startup.

## Storage layout

All data is stored as text files under `MESSAGES_DIR`. ID-keyed channel data
uses dedicated `v2/` namespaces so legacy flat filenames cannot be mistaken
for current channel history:

```
messages/
├── history/
│   ├── v2/     → Daily logs: v2_{channelId}__{channel}_{YYYY-MM-DD}.txt
│   └── *.txt   → Legacy name-keyed logs (explicit browsing only)
├── summaries/
│   ├── v2/     → Daily summaries: v2_{channelId}__{channel}_{YYYY-MM-DD}.txt
│   └── *.txt   → Legacy name-keyed summaries
├── profiles/   → User profiles: {userId}.txt, server memory: server_{guildId}.txt
├── pending/    → In-flight messages (temp files)
└── images/     → Downloaded attachments
```

## MCP tools

| Tool | Description |
|------|-------------|
| `send-message` | Send a message to a Discord channel |
| `react-to-message` | React to a message with unicode or custom guild emoji |
| `read-messages` | Fetch recent messages from Discord API (live) |
| `read-message-history` | Read saved history/pending files from disk |
| `fetch-messages` | Fetch specific messages by Discord message links |

## Adding new features

### New command
1. Create `src/discord/commands/mycommand.ts` exporting `async function handleMyCommand(msg: Message)`.
2. Add the route in `handler.ts`: `if (msg.content.trim() === "!mycommand") { await handleMyCommand(msg); return; }`
3. Import the handler at the top of `handler.ts`.

### New MCP tool
1. Add the tool schema in `src/mcp/server.ts` under `ListToolsRequestSchema`.
2. Add the handler in the `CallToolRequestSchema` switch.
3. Use Zod for input validation.

### New storage module
1. Create `src/storage/mystore.ts`.
2. Add any new directories to `config.ts` (export the path + `mkdirSync`).
3. Do not import from `discord/` — storage is a lower layer.

### New event listener
1. Add the listener in `handler.ts` inside `registerHandler()`.
2. If a new intent is needed, add it in `client.ts`.

## Dependencies

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server framework |
| `discord.js` | Discord bot client |
| `dotenv` | Environment variable loading |
| `node-pty` | Pseudo-terminal for interactive Claude authentication |
| `zod` | Input validation for MCP tools |

## Docker

The project includes `Dockerfile`, `docker-compose.yml`, and `entrypoint.sh` for containerized deployment. Volumes persist `messages/` data and Claude CLI auth.
