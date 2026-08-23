# Claudify

An AI-powered Discord bot that uses Claude Code CLI to answer questions directly in your server. It also doubles as an MCP server, so Claude Desktop or Claude Code can read and send Discord messages.

## How it works

1. A user sends `!ask <question>` or mentions the bot in a channel
2. The bot spawns the Claude Code CLI to generate a response
3. The response is sent back to the channel as a reply
4. All exchanges are saved as text files, giving Claude memory across conversations

Claude is sandboxed — it can only search the web and read/write its own message history files. No shell access, no code execution.

## Setup (Docker)

1. Create a Discord bot and invite it to your server with these permissions:
   - Read Messages/View Channels
   - Send Messages
   - Read Message History

2. Set your environment variables in `docker-compose.yml`:
   - `DISCORD_TOKEN` — your bot token
   - `REQUIRED_ROLE_ID` — Discord role ID that can use the bot (leave as placeholder to allow everyone)
   - `AUTH_ADMIN_USER_IDS` — comma-separated Discord user IDs allowed to manage Claude authentication (leave empty to disable)
   - `CLAUDE_AUTH_LOGIN_TIMEOUT_MS` — optional Discord login-session timeout (default: `300000`)
   - `MESSAGES_DIR` — where message history is stored (default: `/app/messages`)
   - `BOT_MODEL` — global Claude model fallback for every workload (default: `claude-haiku-4-5`)
   - `BOT_EFFORT` — optional Claude Code `--effort` level: `low`, `medium`, `high`, `xhigh`, or `max`
   - `LIVE_CONTEXT_MAX_CHARS` — optional maximum size of recent live Discord context passed to Claude (default: `140000`)
   - `SUPPRESS_MENTIONS` — optional; set to `true` to prevent bot messages from notifying users, roles, `@everyone`, or `@here` (default: `false`)

3. Run it:
```bash
docker compose up -d
```

### Per-workload Claude configuration

Responses and background maintenance can use different model and effort
settings. This lets user-facing answers use a stronger model while profile
extraction, server-memory maintenance, and daily summaries use lower-cost
settings.

| Workload | Model override | Effort override |
|----------|----------------|-----------------|
| User response | `CLAUDE_RESPONSE_MODEL` | `CLAUDE_RESPONSE_EFFORT` |
| User-profile update | `CLAUDE_PROFILE_MODEL` | `CLAUDE_PROFILE_EFFORT` |
| Server-memory update | `CLAUDE_SERVER_MEMORY_MODEL` | `CLAUDE_SERVER_MEMORY_EFFORT` |
| Daily summary | `CLAUDE_SUMMARY_MODEL` | `CLAUDE_SUMMARY_EFFORT` |

Each property resolves independently. A non-empty workload override takes
priority, then `BOT_MODEL` or `BOT_EFFORT`, then the built-in fallback
(`claude-haiku-4-5` and no explicit effort). Unset, blank, or `inherit` values
inherit the global setting. Use `default` to bypass the global value and omit
that Claude CLI flag for one workload. Effort values are case-insensitive.
Invalid values produce a startup warning and inherit their deterministic global
fallback; model IDs are operator-controlled but cannot contain whitespace or
control characters.

For example:

```env
# Stronger user-facing responses
BOT_MODEL=claude-sonnet-5
BOT_EFFORT=high

# Lower-cost background maintenance
CLAUDE_PROFILE_MODEL=claude-haiku-4-5
CLAUDE_PROFILE_EFFORT=low
CLAUDE_SERVER_MEMORY_MODEL=claude-haiku-4-5
CLAUDE_SERVER_MEMORY_EFFORT=low
CLAUDE_SUMMARY_MODEL=claude-haiku-4-5
CLAUDE_SUMMARY_EFFORT=low
```

Model aliases remain operator-controlled; stronger background models may
improve extraction and summary quality at higher cost and latency. Restart the
process or container after changing these environment variables because the
routing table is resolved once at startup.

## Authenticating Claude

Claude Code CLI needs to be authenticated inside the container before the bot can respond. On first run (or after clearing volumes), you need to log in:

### Private Discord login

Set `AUTH_ADMIN_USER_IDS` to your Discord user ID and restart the bot. Claudify registers owner-only slash commands with ephemeral responses:

- `/auth status` checks the CLI's authentication state without making a model request.
- `/auth login` returns Claude's browser login URL.
- `/auth code` privately submits the short-lived code shown after browser authorization.
- `/auth cancel` stops an unfinished login.

The login process runs in a pseudo-terminal inside the container, so the interactive Claude CLI prompt accepts the code submitted through Discord; no terminal login is required.

Only explicitly listed user IDs can execute these commands. Discord roles and Administrator status are not used for authorization. Claudify never logs or stores the one-time code. Never submit an API key or long-lived OAuth token through Discord.

The Discord application must be installed with the `applications.commands` scope for slash commands to appear.

### Terminal login

You can also exec into the running container:

```bash
docker exec -it <container_name> claude auth login
```

The CLI will display a URL. Open it in your browser and complete the login.

Once authenticated, the bot is ready — no restart needed. Auth persists across container restarts via the `claude-home` volume.

If the bot sends "Sorry, I could not generate a response", it's most likely an auth issue. Check the logs with `docker logs <container_name>` and re-run the auth command above.

For deployed products or services, prefer `ANTHROPIC_API_KEY` or a supported cloud provider rather than relaying Claude subscription authentication.

## Usage reports

Use `!usage week` for an aggregate from Monday at 00:00 through the current
time, or `!usage month` for the current calendar month through the current
time. Both current-period commands use UTC consistently and include total cost,
token and cache-token totals, and a per-model breakdown. `!usage monthly`
remains the historical monthly totals and trends report.

## MCP Server Tools

When used as an MCP server (e.g., with Claude Desktop or Claude Code), these tools are available:

| Tool | Description |
|------|-------------|
| `send-message` | Send a message to a Discord channel |
| `react-to-message` | React to a message with a Unicode or custom guild emoji |
| `read-messages` | Read recent messages from a channel via Discord API |
| `read-message-history` | Read saved message history/pending files from disk |
| `fetch-messages` | Fetch specific messages by Discord message links |

### MCP Configuration

After Claudify successfully logs in to Discord, configure an MCP client in the
same network environment to connect to its Streamable HTTP endpoint:

```json
{
  "mcpServers": {
    "discord": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp"
    }
  }
}
```

Set `DISCORD_TOKEN` in Claudify's environment, not in the MCP client
configuration. If you change `MCP_PORT`, update the URL to match. Claudify also
writes this configuration to `.mcp-config.json` when it starts. The server is
loopback-only and has no request authentication; the Docker setup therefore
does not expose it to host-side MCP clients by default.

## Development

```bash
npm install
npm run dev      # watch mode
npm run build    # compile
npm test         # build and run the complete test suite
npm start        # run
```

Test with the MCP Inspector:
```bash
npm start
# In another terminal:
npx @modelcontextprotocol/inspector
```

In the Inspector, select **Streamable HTTP** and connect to
`http://127.0.0.1:3100/mcp` (or your configured `MCP_PORT`).

### Morpheus MCP Client

Claudify can also expose Morpheus tools to its Claude Code response process.
Set both variables together:

```env
MORPHEUS_MCP_URL=http://morpheus_bot_prod:5268/api/mcp
MORPHEUS_MCP_API_KEY=replace-with-the-morpheus-api-key
```

At startup, Claudify writes the authenticated HTTP server into its generated
`.mcp-config.json`. Claude Code receives that file explicitly and allows only
the `mcp__morpheus__*` tool namespace, so running `claude mcp add` inside the
container is neither required nor relied upon for persistence. The URL must be
reachable from the Claudify container; the Portainer deployment attaches it to
Morpheus's internal Docker network without publishing the MCP port on the host.

## Security

- Claude CLI is restricted to `WebSearch`, `WebFetch`, `Read`, and `Write` tools only
- File access is scoped to the messages directory
- Role-based access control limits who can interact with the bot
- Claude authentication commands use the explicit user-ID allowlist; Discord roles are not used
- Authentication responses are ephemeral, and login codes are never logged or persisted
- Runs in Docker for isolation

## License

MIT
