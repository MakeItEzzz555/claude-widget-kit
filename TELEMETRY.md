# Telemetry: where every number comes from

Checked against Claude Code **2.1.304**'s mod API (`claude-code.d.ts`). Nothing is estimated except the task ETA, which is always labelled `est.`.

| Reading | Source | Notes |
|---|---|---|
| 5h / week left, reset countdown | `session.measure` and `$.session.usage()` `rateLimits[]` (`kind` `five_hour` / `seven_day`, `percentUsed`, `resetsAt`) | No countdown when `resetsAt` is absent; "Waiting for rate limits" off a subscription |
| Context left, tokens / window | `context.percent`, `context.tokens`, `context.window` | The status line's own figures |
| Compactions | `session.compact` results that are not a skip, on the main loop, `trigger` other than `precompute` | |
| Session elapsed | `$.session.usage().startedAt` | A resumed session counts from its first launch, as Claude Code does |
| Live turn | `turn.start` on the main loop (no `agentId`) | Cleared at its `turn.complete` |
| Completed turns, avg, last | main-loop `turn.complete` with `reason` `answer` or `refusal`, `durationMs` | Interrupted or failed turns stop the timer and are not counted. No denominator |
| Tokens | every `turn.complete` `usage`: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` | Main loop and agents. The total is input + cache read + cache write + output |
| Output per turn | main-loop `turn.complete` `usage.output_tokens` | Sparkline |
| Effort and model | `turn.step` `model`, `effort` per loop | |
| Agents | `$.agent.list()` (`id`, `description`, `type`, `status`) | Refreshed on spawns, agent turn ends and every 10 s while agents run |
| Tasks + ETA | `TodoWrite`, `TaskCreate` / `TaskUpdate` / `TaskList` results, the `progress` tool | ETA = pace of finished tasks × tasks left |
| Recent activity | `tool.call` after the tool ran: `Read`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Bash`, `Grep`, `Glob`, `Agent`, `WebFetch`, `WebSearch`, `mcp__<server>__<tool>`; `isError` | Other tools are left out. A failure shows "failed", never a test count |

Never shown, because the API does not report them: a turn quota, agent progress percentages without a task list, test pass/fail counts. Cost is available (`$.session.usage().cost`) but deliberately left out: it is a list-price estimate, not a bill.
