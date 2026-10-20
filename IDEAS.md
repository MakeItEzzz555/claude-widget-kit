# Widget ideas

Next mods for the pack. Each lists the Claude Code events it would use, so it can be built on today's mod API. ⭐ marks the ones that would look best in a short demo video. New band widgets join `turn-meters`, because the band above the prompt holds one mod's tree at a time. Panels and toasts can be separate mods.

| # | Widget | What it shows | Built from | Effort |
|---|---|---|---|---|
| 1 | ⭐ **Reset countdown** | "5h resets in 1 h 12 min" under each ring | `session.measure` rate-limit reset times | S |
| 2 | ⭐ **Token burn sparkline** | `▁▂▅█▃` tokens per turn over the last 20 turns | `turn.step` usage | S |
| 3 | **Cache-hit meter** | Share of input read from the prompt cache | `turn.step` `cache_read_input_tokens` | S |
| 4 | ⭐ **Tool timeline** | A one-line strip of the last tools used, coloured by kind (read, edit, bash, MCP), ✗ on failures | `tool.call` | M |
| 5 | ⭐ **Files touched** | Files edited this session with a dot per edit, newest first | `tool.call` for `Edit`/`Write` (paths only) | M |
| 6 | ⭐ **Test pulse** | Last test run as a green/red badge with pass/fail counts | `tool.call` `Bash` results matching a test runner | M |
| 7 | **Permission waiting** | The band pulses when a tool call is waiting for your approval | permission events | M |
| 8 | **Session cost** | Approximate spend this session, from token counts and a price table | `turn.step` usage | S |
| 9 | **Context compaction alert** | A toast before the context compacts, with the % left | `session.measure` context | S |
| 10 | ⭐ **Agent tree** | The agents panel drawn as a tree, with each agent's token spend | `agent.list`, `turn.step` with `agentId` | M |
| 11 | **Focus timer** | A pomodoro in the band, `/focus 25` to start | `command.run`, `clock.every` | S |
| 12 | **Git pulse** | Branch, ahead/behind, lines changed | `clock.every` + `git` | S |
| 13 | **MCP health** | Which MCP servers are connected, and calls per server | MCP tool calls | M |
| 14 | **Hook log** | The last hooks that fired, and how long each took | `tool.call` pre/post | M |
| 15 | **Done chime** | A sound or desktop notification when a long turn finishes | `turn.complete` | S |
| 16 | **Theme presets** | `/meters theme mono|neon|calm` colour sets, respecting accessibility | `command.run` | S |

Principles: zero dependencies, nothing ever disturbs a model request or tool call, no prompts or outputs on screen, hide a widget when its data is missing.
