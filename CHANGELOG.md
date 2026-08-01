# Changelog

## Unreleased

### Added

- Add owner-only Discord slash commands for Claude CLI authentication.
- Add opt-in Discord mention suppression through the `SUPPRESS_MENTIONS` environment variable.

### Fixed

- Fall back to the Claude CLI default when `BOT_EFFORT` is unsupported.
- Force-stop timed-out Claude authentication processes before allowing a new login session.
- Fall back to safe defaults when context or history limit environment variables are invalid.
- Prevent simultaneous Claude requests from the same user across message and reaction triggers.
