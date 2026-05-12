## BRANCH ISOLATION PROTOCOL (MANDATORY)

CLEO_AGENT_CWD=/home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T1241

FIRST ACTION: cd /home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T1241

You are working on branch: task/T1241
You MUST NOT run any of these git commands:
  git checkout, git switch, git branch -b/-D, git reset --hard,
  git worktree add/remove, git rebase, git stash pop, git push --force

A git shim is active on your PATH that will exit 77 if you attempt these.
Your working directory is: /home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T1241
All your commits must land on YOUR branch only.

# CLEO Subagent Spawn — T1241

> **Task**: T1241 · **Protocol**: implementation · **Tier**: 1 · **Generated**: 2026-04-22T13:12:31.949Z

Self-contained spawn prompt. Return ONLY the one-line message from **Return Format Contract**.


## Task Identity

- **ID**: `T1241`
- **Title**: HOTFIX v2026.4.111: systemic — move starter-bundle out of cleo-os + resolver fallback + CI green
- **Description**: Owner-directive 2026-04-22: v2026.4.110 shipped 3 regressions I claimed green. Fix SYSTEMICALLY not symptomatically. Per D035 (just filed): packages/cleo-os/starter-bundle/ is architectural violation — universal agents MUST live in packages/agents/ and seed-install MUST read from there. 

CI failure evidence: 5 tests in orchestrate-engine-composer.test.ts + orchestrate-engine.test.ts. AssertionError: expected E_ATOMICITY_NO_SCOPE received E_AGENT_NOT_FOUND. Root cause: I1 removed cleo-prime/cleo-dev/cleo-historian/cleo-db-lead/cleo-rust-lead/cleoos-opus-orchestrator from packages/agents/seed-agents/ (correct per owner). Classifier picks them. Resolver walks 4 tiers. CI clean env has zero registry rows + zero fs matches. E_AGENT_NOT_FOUND surfaces BEFORE atomicity gate can reject. Tests expect atomicity error.

Deliverables (systemic not symptomatic):

A. RELOCATE packages/cleo-os/starter-bundle/ → packages/agents/seed-agents/. The 4 files (cleo-orchestrator.cant code-worker.cant dev-lead.cant docs-worker.cant) either merge INTO the *-generic.cant templates OR become additional templates with {{variable}} placeholders. team.cant → packages/agents/team-generic.cant. starter/ subdirectory pattern → packages/agents/starter/ at root.

B. ROUTE seed-install: packages/core/src/agents/seed-install.ts reads from packages/agents/ via new SDK helper resolveStarterBundle() in core. NEVER from packages/cleo-os/. Applies variable-substitution.ts during copy to .cleo/cant/agents/. packages/cleo-os/ retains ONLY harness-adapter code (Claude Code AGENT.md wrapper belongs at packages/agents/harness-adapters/claude-code/).

C. RESOLVER ULTIMATE FALLBACK: packages/core/src/store/agent-resolver.ts — when all 4 tiers fail for a classified agent name (project + global + packaged + synthetic), fall back to synthesizing ResolvedAgent from packages/agents/cleo-subagent.cant (universal protocol base). Document as 5th tier 'universal-base' in DEPRECATED_ALIASES-adjacent map. Emit warning but NEVER E_AGENT_NOT_FOUND if cleo-subagent is reachable.

D. FIX 5 FAILING TESTS: via fallback from (C) they will now pass — classifier picks cleo-prime, resolver falls through to universal base, atomicity gate fires expected E_ATOMICITY_NO_SCOPE. Verify locally + verify CI green after push.

E. REGISTRY CLEANUP: after relocation the old packages/cleo-os paths in agents registry rows become stale. Add migration step that re-points project-tier rows to packages/agents/ paths. cleo agent doctor must return 0 warnings post-migration.

F. DOCS: update ADR-055 with D035 addendum, CHANGELOG entry for v2026.4.111, docs/meta-agents.md cross-ref to D035 if needed.

G. RELEASE: bump to 2026.4.111, push, verify CI green, install globally, verify cleo --version.

Work in worktree per D029. All paths via paths.ts + platform-paths.ts + env-paths per D026. Package-Boundary Check enforced.
- **Type**: task
- **Size**: large
- **Priority**: critical
- **Status**: pending
- **Parent Epic**: `T1232`
- **Pipeline Stage**: research
- **Labels**: hotfix, v2026.4.111, systemic, architecture, ci-green, d035

### Acceptance Criteria

- packages/cleo-os/starter-bundle/ moved to packages/agents/ (deleted from cleo-os) — or kept as read-only re-export shim with deprecation warning
- packages/core/src/agents/seed-install.ts reads from packages/agents/ ONLY (zero imports from packages/cleo-os/)
- packages/core/src/agents/resolveStarterBundle.ts SDK helper ships + is used by seed-install
- packages/core/src/store/agent-resolver.ts has 5th-tier universal-base fallback pointing at packages/agents/cleo-subagent.cant
- All 5 failing tests green locally AND in CI after push (orchestrate-engine-composer.test.ts + orchestrate-engine.test.ts)
- Fresh project test: mkdir /tmp/fresh && cd /tmp/fresh && git init && cleo init → .cleo/cant/agents/ has 4 substituted starter agents with {{variable}} values resolved from project-context.json (not literal {{placeholder}})
- cleo agent doctor returns 0 warnings post-migration
- D035 filed + ADR-055 updated with addendum
- CHANGELOG v2026.4.111 entry explicit about the architectural move + resolver fallback
- biome ci clean + pnpm build full green + pnpm test zero new failures
- v2026.4.111 tagged + pushed + globally installed + cleo --version returns 2026.4.111


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

- **Orchestrator Session**: `ses_20260422131135_5149eb`
- Log every mutation (task start/complete, memory observe, verify) against THIS session. Do not start a new one unless explicitly told.
- If the session has ended by the time you run, the orchestrator will hand you a new one via `cleo orchestrate handoff`.

## File Paths (absolute — do not guess)

| Purpose | Absolute Path |
|---------|---------------|
| Agent output directory | `/mnt/projects/cleocode/.cleo/agent-outputs` |
| Manifest (JSONL) | `/mnt/projects/cleocode/.cleo/agent-outputs/MANIFEST.jsonl` |
| RCASD workspace (T1241) | `/mnt/projects/cleocode/.cleo/rcasd/T1241` |
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
cleo verify T1241 --gate implemented \
  --evidence "commit:$(git rev-parse HEAD);files:<comma-separated-paths>"

# testsPassed — tool run or vitest json
cleo verify T1241 --gate testsPassed --evidence "tool:pnpm-test"
#  OR
cleo verify T1241 --gate testsPassed --evidence "test-run:/tmp/vitest-out.json"

# qaPassed — biome + tsc exit 0
cleo verify T1241 --gate qaPassed --evidence "tool:biome;tool:tsc"

# documented — docs path
cleo verify T1241 --gate documented --evidence "files:docs/<path>.md"

# cleanupDone — summary note
cleo verify T1241 --gate cleanupDone --evidence "note:<summary>"

# securityPassed — scan or waiver
cleo verify T1241 --gate securityPassed --evidence "tool:security-scan"
#  OR
cleo verify T1241 --gate securityPassed --evidence "note:no network surface"
```

### Step 2 — then complete

```bash
cleo memory observe "<concise learning>" --title "<title>"
cleo complete T1241
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
