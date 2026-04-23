# CLEO Protocol

Version: 2.6.0 | CLI-only dispatch | `cleo <command> [args]`

## Session Start (cheapest-first)

1. `cleo session status` — resume existing? (~200 tokens)
2. `cleo dash` — project overview (~500 tokens)
3. `cleo current` — active task? (~100 tokens)
4. `cleo next` — what to work on (~300 tokens)
5. `cleo show {id}` — full details for chosen task (~400 tokens)
6. `cleo orchestrate start --epic TXXX` — for epics with ≥ 5 children (~300 tokens, auto-inits LOOM)

## Work Loop

1. `cleo current` or `cleo next` → pick task
2. `cleo show {id}` → read requirements
3. Do the work (code, test, document)
4. `cleo complete {id}` → mark done
5. `cleo next` → continue or end session

## Triggers (when to call what)

| Signal | Action |
|--------|--------|
| Epic with ≥ 5 child tasks just created | Run `cleo orchestrate start <epicId>` before touching any child |
| You just ran `cleo complete <id>` for a non-trivial task | Run `cleo memory observe "..." --title "..."` with what you learned |
| Task acceptance criterion contains "test" | Propose an `AcceptanceGate` with `kind:"test"` via `cleo req add` |
| Session token budget ≈ 80% consumed | Run `cleo session end --note "..."` and hand off |
| Multiple related tasks ready in parallel | Run `cleo orchestrate ready --epic <id>` for the wave set |
| About to call `cleo complete` | First: check gates via `cleo show <id>` → run tests → then complete |

## Task Discovery

**Use `cleo find` for discovery. NEVER `cleo list` for browsing.**

| Command | ~Tokens | Use |
|---------|---------|-----|
| `cleo find "query"` | 200-400 | Search tasks (default) |
| `cleo show <id>` | 300-600 | Full details for one task |
| `cleo list --parent <id>` | 1000-5000 | Direct children only |

## Session Commands

| Goal | Command |
|------|---------|
| Check session | `cleo session status` |
| Resume context | `cleo briefing` |
| Start session | `cleo session start --scope global` |
| End session | `cleo session end --note "..."` |

## Memory (BRAIN)

3-layer retrieval — search first, then fetch:

| Step | Command | ~Tokens |
|------|---------|---------|
| Search | `cleo memory find "query"` | 50/hit |
| Context | `cleo memory timeline <id>` | 200-500 |
| Details | `cleo memory fetch <id>` | 500/entry |
| Save | `cleo memory observe "text" --title "title"` | — |
| LLM status | `cleo memory llm-status` | 50 |
| Ground-truth promote | `cleo memory verify <id>` (owner only) | 50 |

Memory context: run `cleo memory digest --brief` for live project memory summary (default mode).
Legacy file mode: set `brain.memoryBridge.mode = "file"` in config to restore `@.cleo/memory-bridge.md` injection.

## Orchestration (for epics ≥ 5 tasks)

| Goal | Command |
|------|---------|
| Initialize epic pipeline | `cleo orchestrate start <epicId>` (auto-inits LOOM research stage) |
| Get parallel-safe wave | `cleo orchestrate ready --epic <id>` |
| Get spawn prompt for a task | `cleo orchestrate spawn <taskId>` |
| Spawn without worktree (opt-out) | `cleo orchestrate spawn <taskId> --no-worktree` |
| Multi-agent IVTR loop | `cleo orchestrate ivtr <taskId> --start` |
| View epic wave plan | `cleo orchestrate waves <epicId>` |
| Grant HITL approval (paused playbook) | `cleo orchestrate approve <resumeToken>` |
| Deny HITL approval with reason | `cleo orchestrate reject <resumeToken> --reason "<r>"` |
| List awaiting HITL approvals | `cleo orchestrate pending` |

## Worktree-by-Default (T1140 · ADR-055)

Every `cleo orchestrate spawn` automatically provisions a git worktree for the
agent under `~/.local/share/cleo/worktrees/<projectHash>/<taskId>/` (D029
canonical layout via env-paths). The spawn prompt contains a
`## Worktree Setup (REQUIRED)` section that:

- Names the worktree path and branch (`task/<taskId>`).
- States the context-isolation constraint: "authorized only within `<path>`".
- Provides `FIRST ACTION: cd <path>` so the agent initializes its cwd.

Agents MUST `cd` to the worktree path as their first action. All reads,
writes, and git operations MUST occur inside the worktree boundary. A git shim
on the PATH blocks forbidden operations (checkout, switch, force-push, etc.).

The orchestrator cherry-picks commits from the worktree branch back to main
after the agent completes — agents NEVER merge directly.

To skip provisioning (e.g. for meta-tasks that only run CLI commands), pass
`--no-worktree`. The opt-out is always logged to the audit log.

## Playbook Domain (v2026.4.93 · T910 Orchestration Coherence v4)

`.cantbook` playbooks encode multi-stage agent flows (research → spec → impl →
review, release with HITL gate, etc.) as YAML. The playbook runtime is a
deterministic state machine with HMAC-signed resume tokens for HITL gates —
see `docs/architecture/orchestration-flow.md` for the 6-layer pipeline and
`docs/adr/ADR-053-playbook-runtime.md` for the state-machine decision.

| Goal | Command |
|------|---------|
| Execute a `.cantbook` playbook | `cleo playbook run <name>` |
| Inspect run state | `cleo playbook status <runId>` |
| Resume after HITL approval | `cleo playbook resume <runId>` |

Starter playbooks ship with `@cleocode/playbooks`: `rcasd.cantbook`,
`ivtr.cantbook`, `release.cantbook`.

## Documents & Attachments

| Goal | Command |
|------|---------|
| Attach file/url to task | `cleo docs add <taskId> <file>` or `--url <url>` |
| List task attachments | `cleo docs list --task <id>` |
| Generate llms.txt summary | `cleo docs generate --for <taskId>` |

## Error Handling

Check exit code (`0` = success) and `"success"` in JSON output after every command.

| Exit | Code | Fix |
|:----:|------|-----|
| 4 | `E_NOT_FOUND` | `cleo find` to verify ID |
| 6 | `E_VALIDATION` | Check field lengths |
| 10 | `E_PARENT_NOT_FOUND` | `cleo exists <id>` |
| 80 | `E_LIFECYCLE_GATE_FAILED` | Parent epic not in implementation stage yet — advance with `cleo lifecycle complete` (now auto-syncs `tasks.pipelineStage`) |
| 83 | `E_IVTR_INCOMPLETE` | IVTR loop not released — run `cleo orchestrate ivtr <id> --next` |
| — | `E_EVIDENCE_MISSING` | `cleo verify … --evidence <atoms>` — see "Pre-Complete Gate Ritual" |
| — | `E_EVIDENCE_INSUFFICIENT` | Add missing atom kind for the gate (e.g. `commit:<sha>` + `files:<list>` for `implemented`) |
| — | `E_EVIDENCE_TESTS_FAILED` | Fix failing tests before re-verifying with `tool:pnpm-test` or `test-run:<json>` |
| — | `E_EVIDENCE_TOOL_FAILED` | Tool (biome/tsc/…) exited non-zero; fix source and re-run |
| — | `E_EVIDENCE_STALE` | Files/commits changed since `verify`; re-verify with updated evidence |
| — | `E_FLAG_REMOVED` | `cleo complete --force` removed per ADR-051. Use `--evidence` or `CLEO_OWNER_OVERRIDE=1` |

## Pre-Complete Gate Ritual (ADR-051 — evidence required)

MANDATORY before every `cleo complete <id>`. Every gate write MUST be backed by
programmatic evidence that CLEO validates against git, the filesystem, or the
toolchain. `cleo verify --all` alone is REJECTED with `E_EVIDENCE_MISSING`.

### 1. Capture evidence for each gate

```bash
# implemented — commit + file list
cleo verify T### --gate implemented \
  --evidence "commit:<sha>;files:path/a.ts,path/b.ts"

# testsPassed — vitest JSON or direct tool
cleo verify T### --gate testsPassed --evidence "tool:pnpm-test"
#   OR
cleo verify T### --gate testsPassed --evidence "test-run:/tmp/vitest-out.json"

# qaPassed — biome + tsc exit 0
cleo verify T### --gate qaPassed --evidence "tool:biome;tool:tsc"

# documented — docs files or URL
cleo verify T### --gate documented --evidence "files:docs/spec.md"

# securityPassed — scan or waiver
cleo verify T### --gate securityPassed --evidence "tool:security-scan"
#   OR with justification
cleo verify T### --gate securityPassed --evidence "note:no network surface"

# cleanupDone — summary
cleo verify T### --gate cleanupDone --evidence "note:removed dead branches"
```

### 2. Then complete

```bash
cleo complete T###
```

On complete, CLEO re-validates every hard atom (commit reachable, file sha256
match, test-run hash match). Tampering → `E_EVIDENCE_STALE`, re-verify required.

### 3. Record learnings

```bash
cleo memory observe "..." --title "..."
```

### Emergency override (audited)

```bash
CLEO_OWNER_OVERRIDE=1 \
CLEO_OWNER_OVERRIDE_REASON="incident 1234 hotfix" \
  cleo verify T### --all --evidence "note:owner-approved"
```

All overrides append a line to `.cleo/audit/force-bypass.jsonl`. Use sparingly.

### Anti-patterns to avoid

- ❌ Calling `cleo complete` without verifying tests actually ran
- ❌ `cleo verify --all` without `--evidence` (REJECTED post-ADR-051)
- ❌ `cleo complete --force` (REMOVED post-ADR-051)
- ❌ Skipping `cleo memory observe` on non-trivial tasks
- ❌ Self-attesting without programmatic proof
- ❌ Modifying files after `cleo verify` but before `cleo complete` (caught by staleness check)

## Spawn Prompt Contents (what subagents receive) — T882 / v2.6.0

`cleo orchestrate spawn <taskId>` returns a fully-resolved, self-contained
prompt. Subagents never re-resolve protocol content; everything required is
embedded. Three tiers control content depth:

| Tier | Contents |
|------|----------|
| `0` | Task identity · file paths · session linkage · stage guidance · evidence gates · quality gates · return format · protocol pointer |
| `1` | tier 0 + full **CLEO-INJECTION.md embed** (this document) — **default** |
| `2` | tier 1 + **ct-cleo** + **ct-orchestrator** skill excerpts + **SUBAGENT-PROTOCOL-BLOCK** + anti-patterns |

Invoke with an explicit tier:

```bash
cleo orchestrate spawn T1234 --tier 0   # minimal (quick workers)
cleo orchestrate spawn T1234            # tier 1 (default)
cleo orchestrate spawn T1234 --tier 2   # full (autonomous workers)
```

Every spawn prompt contains these required sections — orchestrators can
programmatically assert their presence before dispatching a subagent:

- `## Task Identity`
- `## File Paths (absolute — do not guess)`
- `## Session Linkage`
- `## Stage-Specific Guidance`
- `## Evidence-Based Gate Ritual (MANDATORY · ADR-051 · T832)`
- `## Quality Gates`
- `## Return Format Contract (MANDATORY)`

## Rules

- No time estimates — use `small`, `medium`, `large` sizing
- Token budget: avoid `cleo list` without `--parent`, avoid `cleo help --tier 2` before tier 0
- Do not read full task details for tasks you won't work on

## Memory Protocol (JIT)

Pull context on demand — don't pre-load everything:

| Need | Command |
|------|---------|
| Prior decisions | `cleo memory find "<topic>" --type decision` |
| Known patterns | `cleo memory find "<domain>" --type pattern` |
| Timeline context | `cleo memory timeline <id>` |
| Full details | `cleo memory fetch <id>` |
| Code context | `cleo nexus context <symbol>` |
| Impact analysis | `cleo nexus impact <symbol>` |

Budget: 3 JIT calls per task phase. More = task is underspecified.

## Escalation

- Load **ct-cleo** skill for full protocol details
- Load **ct-orchestrator** skill for multi-agent workflows
