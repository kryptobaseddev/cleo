## BRANCH ISOLATION PROTOCOL (MANDATORY)

CLEO_AGENT_CWD=/home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T1237

FIRST ACTION: cd /home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T1237

You are working on branch: task/T1237
You MUST NOT run any of these git commands:
  git checkout, git switch, git branch -b/-D, git reset --hard,
  git worktree add/remove, git rebase, git stash pop, git push --force

A git shim is active on your PATH that will exit 77 if you attempt these.
Your working directory is: /home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T1237
All your commits must land on YOUR branch only.

# CLEO Subagent Spawn — T1237

> **Task**: T1237 · **Protocol**: implementation · **Tier**: 1 · **Generated**: 2026-04-22T11:31:39.428Z

Self-contained spawn prompt. Return ONLY the one-line message from **Return Format Contract**.


## Task Identity

- **ID**: `T1237`
- **Title**: I1: Content relocation + legacy delete + 4 generic templates + native-loader update
- **Description**: Implementation Lead I1. See R1-AGENT-ARCHITECTURE-AUDIT.md and R3-CONTENT-AUDIT.md in .cleo/agent-outputs/T-AGENTS-PRE-WAVE/. Owner directive: cleo-project-specific personas MUST NOT ship. Deliverables: (1) DELETE .cleo/agents/ directory (R1 confirms legacy/dead — D-008 in doctor). (2) REMOVE from packages/agents/seed-agents/: cleo-prime.cant cleo-dev.cant cleo-historian.cant cleo-db-lead.cant cleo-rust-lead.cant cleoos-opus-orchestrator.cant (keep only cleo-subagent.cant which is universal protocol base). (3) CREATE in packages/agents/seed-agents/ 4 generic templates using R3's drafted bodies with {{variable}} placeholders per R2 syntax: orchestrator-generic.cant dev-lead-generic.cant code-worker-generic.cant docs-worker-generic.cant. Variables: {{tech_stack}} {{project_domain}} {{test_command}} {{build_command}} {{repo_structure}} {{team_size}}. (4) ENSURE .cleo/cant/agents/ has all 6 cleo-project personas (cleo-prime cleo-dev cleo-historian cleo-rust-lead cleo-db-lead cleoos-opus-orchestrator) — copy from current packages/agents/seed-agents/ before deletion. (5) PROMOTE cleo-subagent.cant to packages/agents/ root (from packages/agents/seed-agents/) — its the universal base. (6) UPDATE packages/cant/src/native-loader.ts per R1 recommendations. (7) UPDATE packages/agents/package.json files[] to reflect new structure. (8) UPDATE packages/agents/README.md to describe new layout. Work in worktree ~/.local/share/cleo/worktrees/<hash>/T1237 per D029. Return commit sha + file list.
- **Type**: task
- **Size**: large
- **Priority**: critical
- **Status**: pending
- **Parent Epic**: `T1232`
- **Pipeline Stage**: research
- **Labels**: i1, implementation, relocation, templates, substrate

### Acceptance Criteria

- .cleo/agents/ directory deleted
- packages/agents/seed-agents/ contains exactly: cleo-subagent.cant (or promoted out) + 4 generic templates with {{placeholders}}
- .cleo/cant/agents/ has all 6 cleo-project personas (verified via cleo agent list --tier project)
- cleo agent doctor returns zero orphans/warnings
- packages/agents/README.md accurately describes new structure
- packages/agents/package.json files[] matches new tree
- packages/cant/src/native-loader.ts per R1 recommendations
- biome + build + test green in worktree
- Regression: cleo orchestrate spawn with cleo-prime/cleo-dev/etc still resolves via project tier


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
| RCASD workspace (T1237) | `/mnt/projects/cleocode/.cleo/rcasd/T1237` |
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
cleo verify T1237 --gate implemented \
  --evidence "commit:$(git rev-parse HEAD);files:<comma-separated-paths>"

# testsPassed — tool run or vitest json
cleo verify T1237 --gate testsPassed --evidence "tool:pnpm-test"
#  OR
cleo verify T1237 --gate testsPassed --evidence "test-run:/tmp/vitest-out.json"

# qaPassed — biome + tsc exit 0
cleo verify T1237 --gate qaPassed --evidence "tool:biome;tool:tsc"

# documented — docs path
cleo verify T1237 --gate documented --evidence "files:docs/<path>.md"

# cleanupDone — summary note
cleo verify T1237 --gate cleanupDone --evidence "note:<summary>"

# securityPassed — scan or waiver
cleo verify T1237 --gate securityPassed --evidence "tool:security-scan"
#  OR
cleo verify T1237 --gate securityPassed --evidence "note:no network surface"
```

### Step 2 — then complete

```bash
cleo memory observe "<concise learning>" --title "<title>"
cleo complete T1237
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
