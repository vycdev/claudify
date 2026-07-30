# Changelog

## Unreleased

### Added

- Add owner-only Discord slash commands for Claude CLI authentication.
- Add opt-in Discord mention suppression through the `SUPPRESS_MENTIONS` environment variable.

### Fixed

- Clear timed-out Claude authentication sessions even when the CLI does not exit after termination is requested.
- Fall back to safe defaults when context or history limit environment variables are invalid.
- Prevent simultaneous Claude requests from the same user across message and reaction triggers.
