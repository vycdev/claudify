# Changelog

## Unreleased

### Added

- Add current-week and current-month usage aggregates with UTC date ranges and per-model breakdowns.
- Add owner-only Discord slash commands for Claude CLI authentication.
- Add opt-in Discord mention suppression through the `SUPPRESS_MENTIONS` environment variable.
- Add typed per-workload model and effort routing for responses, profile updates, server-memory updates, and daily summaries, with legacy global fallbacks and workload-aware logs.

### Fixed

- Advertise the supported HTTP method when rejecting unsupported MCP requests.
- Keep `!usage blocks` billing-window selection and displayed times in UTC regardless of the host timezone.
- Preserve line indentation when MCP clients read saved message history or pending messages.
- Match the generated MCP endpoint hostname to the server's IPv4 loopback listener.
- Strip inherited `CLAUDECODE` markers from Claude CLI subprocesses so Claudify can launch them from Claude Code-managed environments.
- Reject required prompt values that contain no non-whitespace content.
- Match legacy MCP history channel filters exactly instead of including similarly named channels.
- Preserve URL-only embeds returned by the MCP `fetch-messages` tool.
- Reject impossible calendar dates in MCP saved-history filters.
- Fetch Discord messages linked from guild thread and announcement channels.
- Reject `fetch-messages` links that use insecure or non-Discord origins.
- Match Unicode search terms when retrieving relevant saved-history snippets.
- Keep historical daily and monthly usage embeds within Discord's field limit when many models are present.
- Keep astral Unicode characters intact when long Discord responses are split across messages.
- Prevent mixed reaction replies from narrating the bot's internal choice to react while preserving natural reaction-plus-text responses.
- Reject empty MCP `react-to-message` emoji values before calling Discord.
- Run Discord-initiated Claude login in a pseudo-terminal so the CLI accepts submitted OAuth codes.
- Isolate saved history and summaries by Discord channel ID in dedicated storage namespaces so same-named channels do not share automatic context.
- Reject fractional MCP limits instead of passing them to file slicing or the Discord API.
- Return a client error for malformed MCP request URLs instead of stopping the server.
- Force-stop timed-out Claude CLI processes before releasing their concurrency slots.
- Preserve reaction-only bot responses in saved conversation history.
- Recognize `!ask` at the command boundary so empty commands receive usage guidance and tabs can separate questions.
- Validate every `fetch-messages` link before processing MCP requests.
- Fall back to the Claude CLI default when `BOT_EFFORT` is unsupported.
- Reject empty or oversized MCP `send-message` content before calling Discord.
- Reject whitespace-only MCP `send-message` content before calling Discord.
- Reject MCP HTTP requests from untrusted browser origins.
- Honor zero history limits when a question matches saved-history snippets.
- Reject Discord message links whose server ID does not match the fetched channel.
- Keep long fenced code blocks valid when Discord responses are split across messages.
- Match MCP history date filters against the log date suffix instead of dates embedded in channel names.
- Force-stop timed-out Claude authentication status checks that ignore termination.
- Force-stop timed-out Claude authentication processes before allowing a new login session.
- Fall back to the default cooldown when `COOLDOWN_MS` exceeds Node's supported timer range.
- Fall back to safe defaults when context or history limit environment variables are invalid.
- Prevent simultaneous Claude requests from the same user across message and reaction triggers.
- Serialize overlapping profile and server-memory updates to avoid losing newer context.
- Filter pending MCP history by its saved Discord channel name or ID.
