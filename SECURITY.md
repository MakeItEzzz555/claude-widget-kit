# Security policy

## What the mods touch

- **Read:** what the Claude Code engine already exposes to mods: usage and rate-limit readings, the model and effort of each request, task titles from `TodoWrite`/Task tools/`progress`, and the agent list.
- **Write:** only the mod's own state atoms (`turn-meters.*`), kept in memory by Claude Code.
- **No network, no file access, no shell commands.** Run `claude plugin validate plugins/turn-meters` to see every engine call the mod makes.
- **Never disruptive:** every bookkeeping step is wrapped so a failure can't block a model request or a tool call.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/MakeItEzzz555/claude-widget-kit/security/advisories/new) rather than a public issue. You can expect a reply within 7 days.

## Supported versions

Only the latest release gets fixes.
