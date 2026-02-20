# Codex Subagents — CLEO Agent Protocol (LLM-First)

## PURPOSE
- Build a purpose‑built Codex subagent system for CLEO tasks and agent-outputs manifest protocol
- Zero external dependencies beyond: `bash`, `codex`, `cleo`, `git` (only if worktrees enabled)

## HARD RULES (LLM)
- MUST preserve CLEO protocol block from `cleo orchestrator spawn`
- MUST append, not replace, CLEO prompt when adding task JSON
- MUST write agent outputs + manifest entry (per protocol block)
- MUST return EXACT response string specified in protocol block
- MUST use worktrees for parallel agents touching git
- MUST NOT edit CLEO source code (read-only allowed)
- MUST NOT pass `-` or `--` as a prompt argument (wrapper uses stdin)

## ENTRYPOINT
`scripts/codex-subagent.sh`

## COMMAND SURFACE
```
codex-subagent.sh [spawn] [options] [PROMPT]
codex-subagent.sh status [--id ID] [--outdir DIR]
codex-subagent.sh heartbeat [--id ID] [--outdir DIR]
codex-subagent.sh collect --id ID [--outdir DIR]
codex-subagent.sh stop --id ID [--outdir DIR]
```

## SPAWN FLAGS (CANONICAL)
```
--id ID                         # default nanoid(21)
--outdir DIR                    # default .codex-subagents
--cd DIR                        # agent working root
--model MODEL                   # optional
--sandbox MODE                  # read-only|workspace-write|danger-full-access
--approval POLICY               # untrusted|on-failure|on-request|never
--yolo                          # alias for --dangerously-bypass-approvals-and-sandbox
--full-auto                     # alias for --full-auto
--cleo                          # require SUBAGENT PROTOCOL in prompt
--require-protocol              # hard-fail if prompt lacks SUBAGENT PROTOCOL
--cleo-task TASK_ID             # generate prompt via cleo orchestrator spawn
--cleo-template NAME            # optional template for cleo spawn
--foreground                    # wait for completion
--timeout SECONDS               # kill agent after timeout
--heartbeat-interval SECONDS    # write heartbeat while running
--task-json JSON                # JSON payload (string)
--task-file FILE                # JSON payload file
--task-json-append              # append JSON to existing prompt
--task-json-replace             # replace prompt with JSON-only prompt
--worktree                      # create isolated git worktree+branch
--repo DIR                      # git repo root
--branch-prefix STR             # default codex
--worktree-base DIR             # default <repo>/.codex-worktrees
```

## INPUTS
### 1) Deterministic CLEO prompt (preferred)
Requires `jq` on PATH.
```
scripts/codex-subagent.sh --cleo-task T005 --task-json "$TASK_JSON"
```

### 2) CLEO spawn prompt (stdin)
```
cleo orchestrator spawn T005 --json | jq -r '.result.prompt' \
  | scripts/codex-subagent.sh --cleo --task-json "$TASK_JSON"
```

### 2) Task JSON (STRICT)
- MUST be valid JSON (single object)
- MUST be appended to prompt (do NOT replace)

```
{
  "task_id": "T005",
  "objective": "...",
  "constraints": ["..."],
  "acceptance_tests": ["..."],
  "output": {
    "files_expected": ["..."]
  }
}
```

## CLEO PROTOCOL (NON-NEGOTIABLE)
Source: `cleo orchestrator spawn <TASK_ID> --json` prompt
- MUST include "SUBAGENT PROTOCOL" block
- MUST follow output paths defined in block:
  - OUTPUT_DIR: `claudedocs/agent-outputs`
  - MANIFEST_PATH: `claudedocs/agent-outputs/MANIFEST.jsonl`
- MUST append exactly one JSONL entry to MANIFEST
- MUST return exact response string specified in block

## AGENT OUTPUTS (MANIFEST SPEC)
Schema: `/mnt/projects/claude-todo/schemas/research-manifest.schema.json`
Required fields:
- id (pattern: `<slug>-YYYY-MM-DD`)
- file (pattern: `YYYY-MM-DD_<slug>.md`)
- title
- date (YYYY-MM-DD)
- status: `complete|partial|blocked|archived`
- topics: string[]
- key_findings: string[3..7]
- actionable: boolean

Optional fields (use when applicable):
- linked_tasks: ["T###", ...]
- needs_followup: ["T###" | "BLOCKED:reason", ...]
- agent_type: research|implementation|validation|documentation|analysis
- files_modified: ["path", ...]
- tests_run: [{test,result,details?}, ...]
- documentation_artifacts: ["path", ...]
- audit: {...}  # if protocol requires

## OUTPUT ARTIFACTS (LOCAL)
Created by wrapper:
- `.codex-subagents/<id>.jsonl` (events)
- `.codex-subagents/<id>.stderr`
- `.codex-subagents/<id>.last.json`
- `.codex-subagents/<id>.task.json` (if task JSON provided)
- `.codex-subagents/<id>.heartbeat` (if heartbeat enabled)
- `.codex-subagents/index.tsv` (registry)

## REGISTRY FORMAT
`.codex-subagents/index.tsv` fields:
1. id
2. pid
3. started_utc
4. workdir
5. last_message_path
6. repo (empty if not worktree)
7. branch (empty if not worktree)

## GIT ISOLATION (MANDATORY FOR PARALLEL)
- Use `--worktree` for each agent
- Creates:
  - branch: `<branch-prefix>/<id>`
  - worktree: `<repo>/.codex-worktrees/<id>`
- No branch checkout collisions across terminals

Cleanup:
```
git -C <repo> worktree remove <repo>/.codex-worktrees/<id>
git -C <repo> branch -D <branch-prefix>/<id>
```

## SANDBOX / APPROVAL MODES
Recommended (CLEO):
```
--approval never --sandbox workspace-write --worktree --cleo
```
Inspect only:
```
--approval never --sandbox read-only
```
Unsafe:
```
--yolo
```

## HEARTBEAT / TIMEOUT
Heartbeat:
```
scripts/codex-subagent.sh --heartbeat-interval 30 ...
```
Timeout:
```
scripts/codex-subagent.sh --timeout 1800 ...
```
Behavior:
- heartbeat file updated while PID alive
- timeout writes `.codex-subagents/<id>.timeout` and kills PID

## WORKFLOWS
### Spawn (CLEO-compliant)
```
task_json='{"task_id":"T005","objective":"...","constraints":["..."],"acceptance_tests":["..."],"output":{"files_expected":[]}}'

scripts/codex-subagent.sh \
  --id T005D \
  --cleo-task T005 --task-json "$task_json" \
  --approval never --sandbox workspace-write \
  --worktree --repo /path/to/REAL_GIT_REPO \
  --foreground
```

### Status / Collect / Stop
```
scripts/codex-subagent.sh status --id T005D
scripts/codex-subagent.sh collect --id T005D
scripts/codex-subagent.sh stop --id T005D
```

## FAILURE HANDLING
- Missing `.last.json`:
  - Inspect `.jsonl` and `.stderr`
  - Re-spawn with same CLEO prompt + task JSON
- Prompt missing protocol:
  - use `--cleo` to hard-fail if protocol missing
- Worktrees not created:
  - ensure `--worktree` AND `--repo` points to a git repo

## KNOWN CONSTRAINTS
- Some environments reap background processes when parent exits
- Use `--foreground` for deterministic runs in those environments

## NON‑NEGOTIABLE RETURN MESSAGE
- MUST match the protocol block in the CLEO prompt
- DO NOT return task output in the response
- All substantive output goes to `claudedocs/agent-outputs/*` + manifest entry
