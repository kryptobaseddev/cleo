---
id: t13419-ask-tool-audit
tasks: [T13419]
kind: fix
summary: CAAMP ask-tool map re-audited against current harnesses; six new native tools, Kilo renamed, alternate names recorded
---

`PROVIDER_ASK_TOOLS` (T12482) was researched on 2026-09-27. A re-audit on
2026-10-10 against vendor docs and the installed binaries (codex-cli 0.162.1,
opencode v2.0.26, kimi 2.1.1, Claude Code 2.1.296) found eleven stale rows.

- New native tools: VS Code and GitHub Copilot agent mode
  (`vscode_askQuestions`), Qwen Code (`ask_user_question`), Continue CLI
  (`AskQuestion`) and Antigravity (`ask_question`). Zed is now verified `none`.
- Kilo Code is built on opencode now and calls `question`;
  `ask_followup_question` is the legacy extension's name.
- Cursor's `AskQuestion` is no longer limited to plan mode.
- Codex, opencode and Claude Code caveats are current (root-thread-only,
  ACP rendering, `-p` needs a permission host).

`ProviderAskTool` gains an optional `additionalToolNames` field for a harness
that exposes more than one name (Codex's `request_user_input_async`, Kilo's
legacy name), so the Stop-hook transcript scan (T13420) recognises every ask
call.
