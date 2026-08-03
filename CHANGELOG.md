# Changelog

## Unreleased

### Added

- Add owner-only Discord slash commands for Claude CLI authentication.
- Add opt-in Discord mention suppression through the `SUPPRESS_MENTIONS` environment variable.

### Fixed

- Return a client error for malformed MCP request URLs instead of stopping the server.
- Force-stop timed-out Claude CLI processes before releasing their concurrency slots.
- Preserve reaction-only bot responses in saved conversation history.
- Recognize `!ask` at the command boundary so empty commands receive usage guidance and tabs can separate questions.
- Validate every `fetch-messages` link before processing MCP requests.
- Fall back to the Claude CLI default when `BOT_EFFORT` is unsupported.
- Reject empty or oversized MCP `send-message` content before calling Discord.
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
