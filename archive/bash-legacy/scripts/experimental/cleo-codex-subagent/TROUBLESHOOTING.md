# Troubleshooting

## error: unexpected argument '-\n' found
Cause: prompt passed as CLI arg (e.g., `-` or `---`).
Fix: use stdin-only prompt flow. Wrapper now does this by default.

## No output in `claudedocs/agent-outputs/`
Cause: protocol block missing or overwritten.
Fix: use `--cleo` and do not replace the prompt. Task JSON should be appended.

## MANIFEST.jsonl empty
Cause: subagent never wrote manifest entry.
Fix: respawn with CLEO prompt intact; confirm `SUBAGENT PROTOCOL` block present.

## Worktrees not created
Cause: missing `--worktree` or invalid `--repo`.
Fix: pass `--worktree --repo /path/to/REAL_GIT_REPO`.

## Subagent dies immediately
Cause: codex CLI rejected arguments; check `.codex-subagents/<id>.stderr`.
Fix: avoid prompt args; rely on stdin.

## Subagent stuck or long-running
Cause: large context or waiting on external command.
Fix: add `--timeout` and `--heartbeat-interval`.
