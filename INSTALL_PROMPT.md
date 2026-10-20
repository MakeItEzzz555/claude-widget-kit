# One-click install prompt

Paste this into Claude Code:

```text
Install Claude Widget Kit (https://github.com/MakeItEzzz555/claude-widget-kit) for me.

1. Run `claude --version` and tell me the version.
2. Run: claude plugin marketplace add MakeItEzzz555/claude-widget-kit
3. Run: claude plugin install turn-meters@claude-widget-kit
4. Run `claude plugin list` and confirm turn-meters@claude-widget-kit is installed and enabled. If another installed mod already draws the band above the prompt, tell me which one, because the band shows one mod at a time.
5. Tell me to run /reload-plugins, and that /agent-panel opens the agents panel (it docks in the fullscreen layout, at 144+ columns).

Do not change any other settings, and do not install anything else.
```

## Shell only

```bash
claude plugin marketplace add MakeItEzzz555/claude-widget-kit && claude plugin install turn-meters@claude-widget-kit
```
