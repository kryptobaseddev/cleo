## BRANCH ISOLATION PROTOCOL (MANDATORY)

CLEO_AGENT_CWD=/home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T1238

FIRST ACTION: cd /home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T1238

You are working on branch: task/T1238
You MUST NOT run any of these git commands:
  git checkout, git switch, git branch -b/-D, git reset --hard,
  git worktree add/remove, git rebase, git stash pop, git push --force

A git shim is active on your PATH that will exit 77 if you attempt these.
Your working directory is: /home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T1238
All your commits must land on YOUR branch only.

# CLEO Subagent Spawn — T1238

> **Task**: T1238 · **Protocol**: implementation · **Tier**: 1 · **Generated**: 2026-04-22T11:31:41.414Z

Self-contained spawn prompt. Return ONLY the one-line message from **Return Format Contract**.


## Task Identity

- **ID**: `T1238`
- **Title**: I2: Variable substitution engine + contracts types + spawn-time integration
- **Description**: Implementation Lead I2. See R2-VARIABLE-SYNTAX-DESIGN.md in .cleo/agent-outputs/T-AGENTS-PRE-WAVE/. Implement mustache {{var}} substitution with dot-notation at cleo orchestrate spawn time. Deliverables: (1) packages/contracts/src/operations/variable-substitution.ts — VariableResolver SubstitutionResult SubstitutionContext types per R2 §4. (2) packages/core/src/agents/variable-substitution.ts — SDK implementation with resolver chain: bindings → session → project-context.json → env → default → missing. Strict vs lenient mode. Dot-notation path access ({{context.foo.bar}}). Recursion prevention. Regex: /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g. (3) Integration point: packages/cleo/src/dispatch/engines/orchestrate-engine.ts — invoke substitution during spawn prompt composition (orchestrateSpawnExecute flow). (4) Unit tests with R2's 3 test vectors. (5) E2E test: template agent + project context → resolved agent in spawn prompt. Work in worktree ~/.local/share/cleo/worktrees/<hash>/T1238 per D029. Return commit sha + file list.
- **Type**: task
- **Size**: medium
- **Priority**: critical
- **Status**: pending
- **Parent Epic**: `T1232`
- **Pipeline Stage**: research
- **Labels**: i2, implementation, variable-substitution, sdk-first

### Acceptance Criteria

- packages/contracts/src/operations/variable-substitution.ts exports typed interfaces
- packages/core/src/agents/variable-substitution.ts ships SDK with resolver chain
- Integration hook in orchestrate-engine.ts substitutes at spawn-time (not install-time)
- Unit tests pass for all 3 R2 test vectors
- E2E test: template with 5+ variables → fully-resolved output
- Package-Boundary Check: zero cross-package relative src/ imports
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
| RCASD workspace (T1238) | `/mnt/projects/cleocode/.cleo/rcasd/T1238` |
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
cleo verify T1238 --gate implemented \
  --evidence "commit:$(git rev-parse HEAD);files:<comma-separated-paths>"

# testsPassed — tool run or vitest json
cleo verify T1238 --gate testsPassed --evidence "tool:pnpm-test"
#  OR
cleo verify T1238 --gate testsPassed --evidence "test-run:/tmp/vitest-out.json"

# qaPassed — biome + tsc exit 0
cleo verify T1238 --gate qaPassed --evidence "tool:biome;tool:tsc"

# documented — docs path
cleo verify T1238 --gate documented --evidence "files:docs/<path>.md"

# cleanupDone — summary note
cleo verify T1238 --gate cleanupDone --evidence "note:<summary>"

# securityPassed — scan or waiver
cleo verify T1238 --gate securityPassed --evidence "tool:security-scan"
#  OR
cleo verify T1238 --gate securityPassed --evidence "note:no network surface"
```

### Step 2 — then complete

```bash
cleo memory observe "<concise learning>" --title "<title>"
cleo complete T1238
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
