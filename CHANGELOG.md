# Changelog

## 0.2.0 — Live Developer Observatory

- The agents panel is now a session dashboard (`/agent-panel`, titled "Session"): Session, Tokens, Turns, Context, 5h and weekly limits with reset countdowns, the agent cards, and Recent activity. Two cards a row from 88 columns.
- The band gains a one-line session summary: elapsed, completed turns, live turn, session tokens.
- Turn counts and durations from `turn.start` / `turn.complete`; interrupted and failed turns are not counted.
- Token totals (input, output, cache read, cache write) from every loop's `turn.complete` usage, with an output-per-turn sparkline.
- Compaction counter from `session.compact`.
- Privacy-safe activity feed from `tool.call`: short paths, program and subcommand, host names only.
- Panel meters use theme colours, so they keep contrast on light themes.
- New [TELEMETRY.md](TELEMETRY.md): the source of every reading.

## 0.1.0 — 2026-10-20

First public release.

- `turn-meters`: 5h, week and context rings, effort meter and task bar with ETA in the band above the prompt.
- Agents panel (`/agent-panel`) with a card per agent, up to 9 plus "+N more".
- `progress` tool for multi-step work without a task list.
- Feeds from `TodoWrite` and the Task tools.
