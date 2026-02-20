# Test notes and findings

## What we observed
- Subagents returned `status/summary/artifacts` when the CLEO protocol block was missing.
- `claudedocs/agent-outputs/MANIFEST.jsonl` remained empty when protocol block was dropped.
- Prompts starting with `---` or a lone `-` caused `codex exec` to error when passed as CLI args.
- Background subagents can be reaped in some environments; foreground runs were reliable.
- Worktrees were not created when `--worktree` or a valid git repo were missing.

## Changes made to address this
- Prompt is always delivered via stdin to `codex exec` (no CLI parsing issues).
- Task JSON is appended to CLEO prompt by default (protocol preserved).
- `--cleo` enforces presence of `SUBAGENT PROTOCOL`.
- `--cleo-task` generates prompt from `cleo orchestrator spawn`.
- Added heartbeat and timeout controls.

## Risks to monitor
- Protocol drift if CLEO changes the protocol block format.
- Missing `jq` when using `--cleo-task`.
- Worktree creation fails when `--repo` is not a git repo.

## Suggested validation checks
- After each subagent, verify manifest entry exists:
  - `jq -s '.[] | select(.id == "<id>")' claudedocs/agent-outputs/MANIFEST.jsonl`
- Verify output file exists at path described in manifest entry.
