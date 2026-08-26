# Changelog

## Unreleased

### Added

- Add persistent, authenticated Morpheus MCP configuration for Claude-powered Discord responses.
- Add current-week and current-month usage aggregates with UTC date ranges and per-model breakdowns.
- Add owner-only Discord slash commands for Claude CLI authentication.
- Add opt-in Discord mention suppression through the `SUPPRESS_MENTIONS` environment variable.
- Add typed per-workload model and effort routing for responses, profile updates, server-memory updates, and daily summaries, with legacy global fallbacks and workload-aware logs.

### Fixed

- Require a text response for `!ask` commands even when their prompt is phrased without a question mark.
- Keep batched memory context isolated for same-named Discord channels.
- Bound persisted profile and server-memory files when loading them into Claude context without splitting surrogate pairs.
- Trim surrounding whitespace from configured Discord role IDs.
- Preserve astral Unicode characters when `!profile` and `!guild` responses are split into Discord messages.
- Preserve the original Discord API error when an MCP reaction fails and no matching custom emoji exists.
- Preserve multibyte UTF-8 characters when Claude subprocess output is split across stream chunks.
- Bound downloaded attachment filenames to filesystem-safe byte lengths while preserving path validation.
- Advertise the MCP saved-history date format in the tool schema so clients can validate it before calling the server.
- Fall back to channel-name matching when a numeric channel name collides with a channel ID in another server.
- Format the current time in Claude response prompts in UTC regardless of the host timezone.
- Bound recent live Discord context passed to Claude so deep-context requests cannot contribute unbounded live-message input.
- Support announcement and other guild text-based channels in MCP channel tools.
- Reject symbolic-link attachment destinations instead of following them when saving downloads.
- Avoid corrupting astral Unicode characters when profile or server-memory updates reach their storage limits.
- Advertise the supported HTTP method when rejecting unsupported MCP requests.
- Keep `!usage blocks` billing-window selection and displayed times in UTC regardless of the host timezone.
- Preserve line indentation when MCP clients read saved message history or pending messages.
- Match the generated MCP endpoint hostname to the server's IPv4 loopback listener.
- Strip inherited `CLAUDECODE` markers from Claude CLI response and authentication subprocesses so Claudify can launch them from Claude Code-managed environments.
- Reject required prompt values that contain no non-whitespace content.
- Match legacy MCP history channel filters exactly instead of including similarly named channels.
- Preserve URL-only embeds returned by the MCP `fetch-messages` tool.
- Reject impossible calendar dates in MCP saved-history filters.
- Fetch Discord messages linked from guild thread and announcement channels.
- Reject `fetch-messages` links that use insecure or non-Discord origins.
- Match Unicode search terms when retrieving relevant saved-history snippets.
- Keep historical daily and monthly usage embeds within Discord's field limit when many models are present.
- Keep astral Unicode characters intact when long Discord responses are split across messages.
- Reject non-numeric Discord message IDs in MCP reaction requests before contacting Discord.
- Keep literal reaction syntax inside fenced code blocks from triggering bot reactions.
- Bound `read-messages` MCP responses so large live-history requests retain the newest messages without producing unbounded output.
- Bound `!usage` ccusage subprocess lifetime so a hung usage query is terminated and reported instead of keeping the request pending.
- Normalize whitespace and `#` display prefixes in MCP server and channel identifiers before lookup.
- Generate daily summaries for days containing a complete single exchange.
- Bound loaded daily summaries to the configured history recap character budget.
- Prevent profile responses from triggering Discord mentions from stored profile text.
- Route bot message and reaction triggers from Discord threads through the same request handling as regular text channels.
- Prevent mixed reaction replies from narrating the bot's internal choice to react while preserving natural reaction-plus-text responses.
- Restrict Claude authentication slash commands to private DMs, matching text-command security behavior.
- Reject empty MCP `react-to-message` emoji values before calling Discord.
- Run Discord-initiated Claude login in a pseudo-terminal so the CLI accepts submitted OAuth codes.
- Reject a pending Claude login immediately when the owner cancels before the login URL is available.
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
- Reject MCP HTTP request bodies larger than 1 MiB before handing them to the transport.
- Honor zero history limits when a question matches saved-history snippets.
- Reject Discord message links whose server ID does not match the fetched channel.
- Keep long fenced code blocks valid when Discord responses are split across messages.
- Match MCP history date filters against the log date suffix instead of dates embedded in channel names.
- Force-stop timed-out Claude authentication status checks that ignore termination.
- Treat failed Claude authentication status commands as unauthenticated even if they emit stale authenticated JSON.
- Force-stop timed-out Claude authentication processes before allowing a new login session.
- Bound `read-message-history` MCP responses so large history requests retain the newest entries without producing unbounded output.
- Fall back to the default cooldown when `COOLDOWN_MS` exceeds Node's supported timer range.
- Fall back to safe defaults when context or history limit environment variables are invalid.
- Prevent simultaneous Claude requests from the same user across message and reaction triggers.
- Serialize overlapping profile and server-memory updates to avoid losing newer context.
- Ignore symlinked files and directories when calculating storage statistics.
- Bound MCP attachment downloads before writing them to disk.
- Ignore symlinked and other non-regular entries when reading MCP history or pending files.
- Filter pending MCP history by its saved Discord channel name or ID.
- Reject blank MCP saved-history channel filters instead of silently reading every channel.
- Filter pending MCP history by the saved message timestamp when a date is requested.
