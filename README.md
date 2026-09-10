# Claudify

An AI-powered Discord bot that uses Claude Code CLI or a Codex subscription to answer questions directly in your server. It also doubles as an MCP server, so Claude Desktop or Claude Code can read and send Discord messages.

## How it works

1. A user sends `!ask <question>` or mentions the bot in a channel
2. The harness builds an explicit active-turn record and removes duplicate turn messages from background context
3. Claude returns a structured response envelope; the harness validates text and reaction requirements before Discord sees it
4. Conversation text and response audit metadata are stored separately for later context and replay evaluation

Claude is sandboxed — it can only search the web and read/write its own message history files. No shell access, no code execution.

## Setup (Docker)

1. Create a Discord bot and invite it to your server with these permissions:
   - Read Messages/View Channels
   - Send Messages
   - Read Message History

2. Set your environment variables in `docker-compose.yml`:
   - `DISCORD_TOKEN` — your bot token
   - `REQUIRED_ROLE_ID` — Discord role ID that can use the bot (leave as placeholder to allow everyone)
   - `AUTH_ADMIN_USER_IDS` — comma-separated Discord user IDs allowed to manage Claude and Codex authentication (leave empty to disable)
   - `CLAUDE_AUTH_LOGIN_TIMEOUT_MS` — optional Discord login-session timeout (default: `300000`)
   - `MESSAGES_DIR` — where message history is stored (default: `/app/messages`)
   - `BOT_MODEL` — global Claude model fallback for every workload (default: `claude-haiku-4-5`)
   - `BOT_EFFORT` — optional Claude Code `--effort` level: `low`, `medium`, `high`, `xhigh`, or `max`
   - `CLAUDE_RESPONSE_EFFORT_MODE` — `fixed` by default; use `adaptive` to lower effort for simple user turns
   - `CLAUDE_RESPONSE_SIMPLE_EFFORT` — simple-turn effort in adaptive mode (default: `low`)
   - `LIVE_CONTEXT_MAX_CHARS` — optional maximum size of recent live Discord context passed to Claude (default: `140000`)
   - `SUPPRESS_MENTIONS` — optional; set to `true` to prevent bot messages from notifying users, roles, `@everyone`, or `@here` (default: `false`)
   - `MCP_READ_MESSAGES_MAX_CHARS` — optional; maximum characters returned by `read-messages` (default: `120000`, maximum: `1000000`)
   - `MCP_HISTORY_MAX_CHARS` — optional; maximum characters returned by `read-message-history` (default: `120000`, maximum: `1000000`)

3. Run it:
```bash
docker compose up -d
```

### Codex subscription provider

Claude remains the default. To use Codex, change these entries in the Compose
service's `environment` section, then rebuild and restart the service:

```env
BOT_PROVIDER=codex
CODEX_MODEL=gpt-5.6-luna
CODEX_EFFORT=medium
CODEX_HOME=/codex
AUTH_ADMIN_USER_IDS=your_discord_user_id
```

```bash
docker compose up -d --build
```

The image includes Codex CLI **0.154.0**. For a non-Docker install, install
`@openai/codex@0.154.0` and set the same variables in the bot's environment or
`.env`. Outside Docker, omit `CODEX_HOME` to use `~/.claudify-codex`.

**Login from Discord:**

1. In ChatGPT security settings, enable device-code authentication if required
   by your account or workspace. Your account must have access to Codex and the
   selected model.
2. DM the bot `!codex auth login`, or use `/codex-auth login` in a private DM.
3. Open the official OpenAI link and enter the short code **in your browser**.
   Only approve a login you initiated for this bot. Never paste a password,
   API key, or OAuth token into Discord.
4. The bot confirms completion privately after verifying ChatGPT authentication.
   Use `!codex auth status` to check, `!codex auth cancel` to cancel your pending
   login, or `!codex auth logout` to sign the bot out. Slash equivalents are
   available under `/codex-auth`.

Codex owns the OAuth flow, token persistence, and refresh through its official
[app-server](https://developers.openai.com/codex/app-server/). It does not need
an inbound callback port or a code pasted back into Discord. Login sessions
expire after `CODEX_AUTH_LOGIN_TIMEOUT_MS`, default `900000`. Auth commands are
intercepted before message logging, restricted to `AUTH_ADMIN_USER_IDS`, and
rejected in guild channels. Rejected authentication commands and their attachments
are also excluded from later conversation context and MCP message retrieval.
Existing history files are not retroactively rewritten. An empty admin list
disables authentication commands.

This is **one shared bot account**, not a separate subscription per Discord
member. Anyone permitted to use the bot consumes that account's allowance,
including background profile, server-memory, and summary work. Set
`REQUIRED_ROLE_ID` appropriately and use only an account you are authorized to
connect. Existing in-flight work may finish after logout.

`!usage` does not show Claude API-cost estimates as Codex usage. Authorized
admins can DM `!codex usage`, or use `/codex-auth usage`, for OpenAI's current
subscription allowance windows. These are account-wide limits, not bot-only
historical token totals. Claudify never purchases credits or redeems banked resets.

| Workload | Model override | Effort override |
|----------|----------------|-----------------|
| User response | `CODEX_RESPONSE_MODEL` | `CODEX_RESPONSE_EFFORT` |
| User-profile update | `CODEX_PROFILE_MODEL` | `CODEX_PROFILE_EFFORT` |
| Server-memory update | `CODEX_SERVER_MEMORY_MODEL` | `CODEX_SERVER_MEMORY_EFFORT` |
| Daily summary | `CODEX_SUMMARY_MODEL` | `CODEX_SUMMARY_EFFORT` |

Overrides inherit `CODEX_MODEL` and `CODEX_EFFORT` independently when blank,
unset, or `inherit`. Codex never inherits `BOT_MODEL` or `CLAUDE_*` settings.
Models must be explicit IDs. Claudify does not select a replacement model. If
OpenAI reports rerouting during a turn, Claudify rejects the result without
retrying or bypassing the reroute; usage or an action may already have occurred.
Effort accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`, but
the selected account/model must advertise support for the chosen value.
`default` omits the effort override. Model availability and effort support are
checked before inference. API-key accounts are refused, even if API credentials
exist elsewhere on the host.

`CODEX_RESPONSE_EFFORT_MODE=adaptive` uses `CODEX_RESPONSE_SIMPLE_EFFORT`,
default `low`, for simple turns while preserving configured effort for complex
turns. The simple setting accepts `inherit` for response effort or `default` to
omit the override. Settings are resolved once at startup; restart after changes.

Codex runs fresh, ephemeral threads with the bot's existing assembled history,
profiles, and response-envelope contract. Images are supplied as native image
inputs. Luna requires Codex Code Mode for JavaScript tool orchestration; this is
not a Node.js or shell environment. Claudify explicitly starts the Code Mode host,
disables its in-process fallback, supplies no local environments, and verifies
the returned thread environment, read-only sandbox, model, and approval policy.
Shell tools, local-file browsing, skills, hooks, plugins, and subagents are disabled.
Interactive approval requests are rejected.

Responses can use web search and authorized Discord/Morpheus MCP tools.
Background maintenance gets neither MCP nor web access. Each response uses a
short-lived, loopback-only MCP bridge that forwards only discovered authorized
tool calls with validated arguments. Resource, prompt, and other MCP operations
cannot reach the upstream servers. Upstream authentication headers stay in the
bot process rather than entering Codex configuration. This boundary does not rely
on hiding tool names from the model. Saved history is accessed through MCP rather
than unrestricted local file tools. MCP action results remain subject to the
existing Morpheus grounding checks. The configured services retain their own
permissions and may perform the external actions their authorized tools expose.

The `codex-home` volume persists credentials separately from message history and
Claude auth. Treat it as a secret, including in backups. `CODEX_HOME` must be
outside `MESSAGES_DIR` after resolving ancestor symlinks, must not itself be a
symlink, and must not contain an unrelated `config.toml`. Configure Claudify through
its environment, not a personal Codex profile. Do not mount an existing developer Codex home into the bot.

To roll back, set `BOT_PROVIDER=claude` and restart. Existing Claude settings,
credentials, and stored Discord history remain intact. No automatic cross-provider
failover occurs on authentication errors, quota exhaustion, or timeouts.

**Verification:** Run `npm test` with Node 22, matching the Docker image. The test
suite is offline. To exercise the real pinned Codex
app-server, read-only thread setup, and a harmless local MCP round trip without
logging in or running inference:

```bash
npm run build
node scripts/codex-smoke.mjs
node scripts/codex-policy-smoke.mjs
```

The policy smoke uses the real pinned CLI and production tool policy with fixed,
synthetic model responses from a local fixture. It checks allowed MCP execution,
forbidden direct/nested tool calls, and blocked upstream resource requests. It
does not perform subscription inference or contact the real model service.
The CLI may still fetch public catalog metadata during startup, so this smoke
is not completely network-isolated.

Set `CODEX_BIN` if the binary is not on PATH. A complete deployment check still
requires browser approval in Discord and a real `!ask` response, followed by an
image request and a permitted MCP action. The offline suite and unauthenticated
smoke test do not establish account-specific model access or successful login.

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

Response effort is fixed by default for backward compatibility. Set
`CLAUDE_RESPONSE_EFFORT_MODE=adaptive` to keep the response model unchanged
while routing simple turns to `CLAUDE_RESPONSE_SIMPLE_EFFORT` (default `low`).
Morpheus requests, attachments, long or multi-part prompts, code/errors,
recaps, debugging, and explicit reasoning requests retain
`CLAUDE_RESPONSE_EFFORT`. The simple-effort setting also accepts `inherit` to
use the configured response effort or `default` to omit the CLI effort flag.

For example:

```env
# Stronger user-facing responses
CLAUDE_RESPONSE_MODEL=claude-sonnet-5
CLAUDE_RESPONSE_EFFORT=high
CLAUDE_RESPONSE_EFFORT_MODE=fixed

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
npm run eval:conversation # replay conversational failures against the configured Claude model
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
