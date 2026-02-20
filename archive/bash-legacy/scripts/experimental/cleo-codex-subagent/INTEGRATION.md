# Integrate with CLEO orchestrator spawn

## Recommended integration path
Use `--cleo-task` so the wrapper generates the protocol prompt directly from CLEO and appends the task JSON without overwriting it.

```
TASK_ID=T005
TASK_JSON='{"task_id":"T005","objective":"...","constraints":["..."],"acceptance_tests":["..."],"output":{"files_expected":[]}}'

scripts/codex-subagent.sh \
  --cleo-task "$TASK_ID" \
  --task-json "$TASK_JSON" \
  --cleo --require-protocol \
  --approval never --sandbox workspace-write \
  --worktree --repo /path/to/REAL_GIT_REPO
```

## Deterministic prompt flow
- `cleo orchestrator spawn <TASK_ID> --json` provides the protocol block.
- Wrapper appends task JSON after the protocol block.
- Wrapper sends the full prompt via stdin to `codex exec`.

## CLEO protocol compliance rules
- Subagent MUST write output file to `claudedocs/agent-outputs/`.
- Subagent MUST append one JSONL entry to `claudedocs/agent-outputs/MANIFEST.jsonl`.
- Subagent MUST return the exact response string from the protocol block.
- If any of these fail, the orchestrator MUST respawn.

## Git isolation (parallel subagents)
- Use `--worktree` with a real git repo.
- Each subagent gets its own branch and worktree to avoid checkout collisions.

```
--worktree --repo /path/to/REAL_GIT_REPO --branch-prefix codex
```

## Minimal integration changes for CLEO developers
- Add `scripts/codex-subagent.sh` to the CLEO repo.
- Document the wrapper in CLEO orchestrator docs as a supported spawn backend.
- Provide a sample `cleo orchestrator spawn` + `codex-subagent.sh` command.
