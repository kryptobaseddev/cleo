## BRANCH ISOLATION PROTOCOL (MANDATORY)

CLEO_AGENT_CWD=/home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T1239

FIRST ACTION: cd /home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T1239

You are working on branch: task/T1239
You MUST NOT run any of these git commands:
  git checkout, git switch, git branch -b/-D, git reset --hard,
  git worktree add/remove, git rebase, git stash pop, git push --force

A git shim is active on your PATH that will exit 77 if you attempt these.
Your working directory is: /home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T1239
All your commits must land on YOUR branch only.

# CLEO Subagent Spawn — T1239

> **Task**: T1239 · **Protocol**: implementation · **Tier**: 1 · **Generated**: 2026-04-22T12:05:03.366Z

Self-contained spawn prompt. Return ONLY the one-line message from **Return Format Contract**.


## Task Identity

- **ID**: `T1239`
- **Title**: I3: Meta-agent + seed-install refactor + playbook agent-dispatcher
- **Description**: Implementation Lead I3. See R4-META-AGENT-DESIGN.md in .cleo/agent-outputs/T-AGENTS-PRE-WAVE/. Depends on I1 (templates exist) and I2 (substitution engine). Deliverables from R4 Phase 1+2: (1) CREATE packages/agents/meta/ directory with agent-architect.cant (use R4 §2 draft body — 652 lines of design). (2) Update packages/agents/package.json files[] to include 'meta/'. (3) REFACTOR packages/core/src/agents/seed-install.ts — replace static file copy with agent-architect invocation that reads project-context.json + templates → emits customized agents to .cleo/cant/agents/. Preserve fallback: if agent-architect unavailable copy templates as-is. (4) CREATE packages/core/src/playbooks/agent-dispatcher.ts — AgentDispatcher interface for playbook runtime. Resolution: meta-tier > project > global > packaged > fallback. (5) Wire agent-dispatcher into packages/playbooks/src/runtime.ts so playbook agentic nodes can invoke meta-agents. (6) Tests: seed-install with agent-architect fixture project-context.json emits expected customized agents. Work in worktree ~/.local/share/cleo/worktrees/<hash>/T1239 per D029. Return commit sha + file list.
- **Type**: task
- **Size**: large
- **Priority**: critical
- **Status**: pending
- **Parent Epic**: `T1232`
- **Pipeline Stage**: research
- **Labels**: i3, implementation, meta-agent, dispatcher, playbook

### Acceptance Criteria

- packages/agents/meta/agent-architect.cant exists with R4 draft body
- packages/core/src/agents/seed-install.ts invokes agent-architect when available falls back to static copy
- packages/core/src/playbooks/agent-dispatcher.ts ships AgentDispatcher interface
- packages/playbooks/src/runtime.ts wired to AgentDispatcher — agentic nodes can invoke meta-agents
- Test: seed-install with fixture project-context.json → customized agents emitted to .cleo/cant/agents/
- Test: playbook node with agent: agent-architect dispatches correctly
- Package-Boundary Check pass
- biome + build + test green


## Return Format Contract (MANDATORY)

On completion, return EXACTLY ONE of these strings and nothing else:

```
Implementation complete. See MANIFEST.jsonl for summary.
Implementation partial. See MANIFEST.jsonl for details.
Implementation blocked. See MANIFEST.jsonl for blocker details.
```

Do NOT include the actual findings or code diffs in the response. Everything that matters goes to:

1. The output file in the **File Paths** section
2. The pipeline manifest (via `cleo` or `mutate pipeline.manifest.append`)
3. The task record itself (gates, status, notes)

## Session Linkage

- **Orchestrator Session**: `ses_20260422110418_acfe24`
- Log every mutation (task start/complete, memory observe, verify) against THIS session. Do not start a new one unless explicitly told.
- If the session has ended by the time you run, the orchestrator will hand you a new one via `cleo orchestrate handoff`.

## File Paths (absolute — do not guess)

| Purpose | Absolute Path |
|---------|---------------|
| Agent output directory | `/mnt/projects/cleocode/.cleo/agent-outputs` |
| Manifest (JSONL) | `/mnt/projects/cleocode/.cleo/agent-outputs/MANIFEST.jsonl` |
| RCASD workspace (T1239) | `/mnt/projects/cleocode/.cleo/rcasd/T1239` |
| Test-run captures | `/mnt/projects/cleocode/.cleo/test-runs` |

## Stage-Specific Guidance — Implementation (IVTR)

**Objective**: Write code that satisfies every acceptance criterion.

Deliverables:
- Source changes under `packages/<pkg>/src/`
- Tests under `packages/<pkg>/src/**/__tests__/*.test.ts` (vitest)
- TSDoc comments on every exported function/class/type
- Commit atomically (one feature/fix per commit) with conventional commit messages

Quality Bar:
- NEVER `any` or `unknown` shortcuts — see `@~/.agents/AGENTS.md` code-quality rules
- Import types from `@cleocode/contracts` — never inline/mock
- `pnpm biome check --write .` must show no warnings
- `pnpm run build` must succeed (full dep graph)
- `pnpm run test` must show zero new failures

## Evidence-Based Gate Ritual (MANDATORY · ADR-051 · T832)

Every gate write MUST carry programmatic evidence. CLEO validates evidence against git, the filesystem, and the toolchain. `cleo verify --all` without `--evidence` is REJECTED with `E_EVIDENCE_MISSING`.

### Step 1 — capture evidence per gate

```bash
# implemented — commit + file list
cleo verify T1239 --gate implemented \
  --evidence "commit:$(git rev-parse HEAD);files:<comma-separated-paths>"

# testsPassed — tool run or vitest json
cleo verify T1239 --gate testsPassed --evidence "tool:pnpm-test"
#  OR
cleo verify T1239 --gate testsPassed --evidence "test-run:/tmp/vitest-out.json"

# qaPassed — biome + tsc exit 0
cleo verify T1239 --gate qaPassed --evidence "tool:biome;tool:tsc"

# documented — docs path
cleo verify T1239 --gate documented --evidence "files:docs/<path>.md"

# cleanupDone — summary note
cleo verify T1239 --gate cleanupDone --evidence "note:<summary>"

# securityPassed — scan or waiver
cleo verify T1239 --gate securityPassed --evidence "tool:security-scan"
#  OR
cleo verify T1239 --gate securityPassed --evidence "note:no network surface"
```

### Step 2 — then complete

```bash
cleo memory observe "<concise learning>" --title "<title>"
cleo complete T1239
```

On `complete`, CLEO re-validates every hard atom (commit reachable, file sha256, test-run hash). Tampering → `E_EVIDENCE_STALE` — re-run verify with updated evidence.

**Forbidden**: `cleo complete --force` (REMOVED per ADR-051). `cleo verify --all` without `--evidence` (REJECTED). `note:` as the only atom on `implemented` or `testsPassed` (INSUFFICIENT).

## Quality Gates (run before every `cleo complete`)

```bash
pnpm biome ci .        # full repo, strict — same as CI
pnpm run build         # full dep graph build
pnpm run test          # zero new failures vs main
git diff --stat HEAD   # verify the diff matches the story
```

If ANY gate fails, fix it before completing. Do not bypass. Do not `--no-verify`. Do not amend published commits.

## CLEO Protocol (tier 1 — dedup pointer)

> Protocol: CLEO-INJECTION.md already loaded via AGENTS.md harness (v2.6.0). See https://github.com/kryptobaseddev/cleocode/blob/main/packages/cleo/AGENTS.md
