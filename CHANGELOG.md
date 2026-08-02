# Changelog

## Unreleased

### Added

- Add owner-only Discord slash commands for Claude CLI authentication.
- Add opt-in Discord mention suppression through the `SUPPRESS_MENTIONS` environment variable.

### Fixed

- Reject fractional MCP limits instead of passing them to file slicing or the Discord API.
- Force-stop timed-out Claude authentication status checks that ignore termination.
- Force-stop timed-out Claude authentication processes before allowing a new login session.
- Fall back to safe defaults when context or history limit environment variables are invalid.
- Prevent simultaneous Claude requests from the same user across message and reaction triggers.
