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
   - `BOT_EFFORT` — optional Claude Code `--effort` level: `low`, `medium`, `high`, `xhigh`, or `max`

3. Run it:
```bash
docker compose up -d
```

## Authenticating Claude

Claude Code CLI needs to be authenticated inside the container before the bot can respond. On first run (or after clearing volumes), you need to log in:

### Private Discord login

Set `AUTH_ADMIN_USER_IDS` to your Discord user ID and restart the bot. Claudify registers owner-only slash commands with ephemeral responses:

- `/auth status` checks the CLI's authentication state without making a model request.
- `/auth login` returns Claude's browser login URL.
- `/auth code` privately submits the short-lived code shown after browser authorization.
- `/auth cancel` stops an unfinished login.

Only explicitly listed user IDs can execute these commands, even if another user has the Discord Administrator permission. Claudify never logs or stores the one-time code. Never submit an API key or long-lived OAuth token through Discord.

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

## MCP Server Tools

When used as an MCP server (e.g., with Claude Desktop or Claude Code), these tools are available:

| Tool | Description |
|------|-------------|
| `send-message` | Send a message to a Discord channel |
| `read-messages` | Read recent messages from a channel via Discord API |
| `read-message-history` | Read saved message history/pending files from disk |

### MCP Configuration

```json
{
  "mcpServers": {
    "discord": {
      "command": "node",
      "args": ["path/to/claudify/build/index.js"],
      "env": {
        "DISCORD_TOKEN": "your_token"
      }
    }
  }
}
```

## Development

```bash
npm install
npm run dev      # watch mode
npm run build    # compile
npm start        # run
```

Test with the MCP Inspector:
```bash
npx @modelcontextprotocol/inspector node build/index.js
```

## Security

- Claude CLI is restricted to `WebSearch`, `WebFetch`, `Read`, and `Write` tools only
- File access is scoped to the messages directory
- Role-based access control limits who can interact with the bot
- Claude authentication commands require both Discord Administrator permission and an explicit user-ID allowlist
- Authentication responses are ephemeral, and login codes are never logged or persisted
- Runs in Docker for isolation

## License

MIT
