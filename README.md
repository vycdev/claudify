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
   - `MESSAGES_DIR` — where message history is stored (default: `/app/messages`)
   - `BOT_EFFORT` — optional Claude Code `--effort` level: `low`, `medium`, `high`, `xhigh`, or `max`

3. Run it:
```bash
docker compose up -d
```

## Authenticating Claude

Claude Code CLI needs to be authenticated inside the container before the bot can respond. On first run (or after clearing volumes), you need to log in:

1. Exec into the running container:
```bash
docker exec -it <container_name> claude auth login
```

2. The CLI will display a URL. Open it in your browser and complete the login.

3. Once authenticated, the bot is ready — no restart needed. Auth persists across container restarts via the `claude-home` volume.

If the bot sends "Sorry, I could not generate a response", it's most likely an auth issue. Check the logs with `docker logs <container_name>` and re-run the auth command above.

## MCP Server Tools

When used as an MCP server (e.g., with Claude Desktop or Claude Code), these tools are available:

| Tool | Description |
|------|-------------|
| `send-message` | Send a message to a Discord channel |
| `read-messages` | Read recent messages from a channel via Discord API |
| `read-message-history` | Read saved message history/pending files from disk |

### MCP Configuration

After Claudify successfully logs in to Discord, configure an MCP client in the
same network environment to connect to its Streamable HTTP endpoint:

```json
{
  "mcpServers": {
    "discord": {
      "type": "http",
      "url": "http://localhost:3100/mcp"
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
npm start        # run
```

Test with the MCP Inspector:
```bash
npm start
# In another terminal:
npx @modelcontextprotocol/inspector
```

In the Inspector, select **Streamable HTTP** and connect to
`http://localhost:3100/mcp` (or your configured `MCP_PORT`).

## Security

- Claude CLI is restricted to `WebSearch`, `WebFetch`, `Read`, and `Write` tools only
- File access is scoped to the messages directory
- Role-based access control limits who can interact with the bot
- Runs in Docker for isolation

## License

MIT
