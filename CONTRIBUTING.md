# Contributing

1. **One folder per mod** under `plugins/`, plus an entry in `.claude-plugin/marketplace.json`.
2. **Band widgets go into `turn-meters`.** The band above the prompt draws one mod's tree at a time.
3. **Pure logic in its own module** (like `hooks/meters.ts`) with tests next to it.
4. **Never disturb the session.** Wrap state bookkeeping so a failure can't block a request or a tool call.
5. **Checks:** `claude plugin validate .` and `claude plugin test plugins/<mod>` must pass.

Ideas waiting for an owner are in [IDEAS.md](IDEAS.md). Open an issue before a large change.
