# CLEO Codex Subagent Package

## What this is
A drop-in wrapper for running Codex subagents under CLEO’s orchestrator protocol with deterministic prompting, manifest compliance, and optional git worktree isolation.

## Package contents
- `scripts/codex-subagent.sh` (launcher)
- `claudedocs/codex-subagents-agent-doc.md` (LLM-first protocol)
- `claudedocs/cleo-codex-subagent-package/INTEGRATION.md`
- `claudedocs/cleo-codex-subagent-package/TEST_NOTES.md`
- `claudedocs/cleo-codex-subagent-package/TROUBLESHOOTING.md`

## Compatibility
- CLEO: `cleo orchestrator spawn` workflow
- Codex CLI: `codex exec` (stdin prompt)
- Shell: `bash`
- Git: required only for `--worktree`

## Quick start
```
TASK_ID=T005
TASK_JSON='{"task_id":"T005","objective":"...","constraints":["..."],"acceptance_tests":["..."],"output":{"files_expected":[]}}'

scripts/codex-subagent.sh \
  --id ${TASK_ID}S \
  --cleo-task "$TASK_ID" --task-json "$TASK_JSON" \
  --approval never --sandbox workspace-write \
  --worktree --repo /path/to/REAL_GIT_REPO \
  --foreground
```

## Required outcomes
- Subagent writes output file to `claudedocs/agent-outputs/`
- Subagent appends one JSONL entry to `claudedocs/agent-outputs/MANIFEST.jsonl`
- Subagent returns the exact response required by the protocol block

## Notes
- `--cleo-task` requires `jq` to extract the prompt from `cleo orchestrator spawn`.
- If you do not want `jq`, pipe a plain prompt via stdin instead.
