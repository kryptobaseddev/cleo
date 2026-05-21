<!-- CAAMP:START -->
@~/.agents/AGENTS.md
@.cleo/project-context.json
# Run: cleo memory digest --brief
<!-- CAAMP:END -->

# CLEO Agent Code Quality Rules (MANDATORY)

These rules are NON-NEGOTIABLE. Every agent, subagent, and orchestrator MUST follow them. Violations are grounds for rejecting all work.

## Before You Write ANY Code

1. **Read first** — understand existing code, patterns, and contracts before writing
2. **Check for existing** — search for utilities, helpers, and shared code. NEVER duplicate
3. **Use contracts** — import types from `packages/contracts/src/`. NEVER inline or mock types

## Type Safety (ZERO TOLERANCE)

- **NEVER** use `any` type — find the root cause, inspect interfaces, wire correctly
- **NEVER** use `unknown` type as a shortcut — define proper types or use existing contracts
- **NEVER** use `as unknown as X` type casting chains — fix the actual type mismatch
- **NEVER** mock types or create inline type definitions — use `packages/contracts/src/`
- **ALWAYS** wire types from existing contracts or BUILD new contracts if they are genuinely missing

## Code Architecture (DRY + SOLID)

- **NEVER remove code** — ALWAYS improve existing code
- **ALWAYS** check for existing functions before creating new ones
- **ALWAYS** centralize shared logic into lib modules — no one-off helpers scattered around
- **ALWAYS** follow existing patterns in the codebase — match the style, naming, and structure
- **ALWAYS** keep imports organized and sorted (biome enforces this)

## Documentation

- **ALWAYS** add TSDoc comments (`/** ... */`) on ALL exported functions, classes, types, and constants
- **ALWAYS** update existing documentation — NEVER create new docs unless absolutely necessary
- **ALWAYS** validate with `forge-ts` when available

## Canonical Docs Routing (ADR-076 · T9796)

Every canonical document type (ADR, spec, research, handoff, note,
release-note, plan) MUST be created via `cleo docs add` — NOT a raw
`Write` to `.cleo/adrs/`, `.cleo/agent-outputs/`, or `.cleo/research/`.

The routing registry lives at `.cleo/canon.yml` (schema:
`.cleo/canon.schema.json`). It declares for each DocKind:

- `canonicalHome` — `ssot` (blob-store only) or `ssot-first` (dual-write
  via a dedicated `cleo` verb such as `cleo changeset add`).
- `publishMirror` — the human-reviewable copy written by `cleo docs publish`.
- `rawMdAllowed` — when `false`, raw `.md` additions under any
  `rawMdPaths` directory are blocked at PR-time by the CI gate.

The CI gate is `cleo check canon docs` (job: `Canon Drift Check (T9796)`).
It walks `git diff --diff-filter=A` between the PR base and `HEAD`,
flagging any NEW `*.md` that bypasses the SSoT. Existing legacy files
imported by T9791 are NEVER flagged — the gate is forward-only.

If you genuinely need a doc-kind not yet listed:
1. Add it to `packages/contracts/src/docs-taxonomy.ts` (`BUILTIN_DOC_KINDS`).
2. Add a routing entry to `.cleo/canon.yml`.
3. Re-run `pnpm --filter @cleocode/cleo run build` and the gate stays green.

## Worktree Location (ADR-055 · Saga T9800 · Decision D009)

ALL git worktrees provisioned for agent tasks MUST live under the canonical
XDG path: `<cleoHome>/worktrees/<projectHash>/<taskId>/`.

- **Linux**: `~/.local/share/cleo/worktrees/<projectHash>/<taskId>/`
- **macOS**: `~/Library/Application Support/cleo/worktrees/<projectHash>/<taskId>/`

### Banned locations

The following worktree locations are UNCONDITIONALLY FORBIDDEN:

- The project root (`/mnt/projects/cleocode/`)
- Any sibling path (`/mnt/projects/*`)
- Inside another worktree (nested worktrees)
- Inside `.claude/worktrees/` or any `.claude/` subdirectory

There is NO escape hatch — not even `CLEO_FORCE_LOCATION`.

### Enforcement

- **Runtime**: `packages/worktree/src/worktree-create.ts` throws
  `E_WT_LOCATION_FORBIDDEN` before any `git worktree add` call when the
  computed path is outside the canonical root.
- **CI gate**: `scripts/lint-worktree-location.mjs` (job: `Worktree Location Lint`)
  runs `git worktree list --porcelain` on every PR and fails on any non-primary
  worktree that is not under `<cleoHome>/worktrees/`. It also rejects a
  `worktrees/` *directory* under `<repo>/.cleo/` — only the sentinel file
  `.cleo/worktrees.json` is allowed there (D009 in-project sentinel pattern).
- **Migration tool**: `scripts/migrate-rogue-worktrees.mjs` detects and moves
  rogue worktrees. Use `--dry-run` to preview before executing.

See Epic **T9809** (`E-WT-PROVISIONING-LOCATION-GUARDS`) for full context.

## Quality Gates (MUST PASS BEFORE COMPLETING)

Run these IN ORDER before marking any task complete:

```bash
# 1. Format and lint
pnpm biome check --write .

# 2. Build
pnpm run build

# 3. Test — verify ZERO new failures
pnpm run test

# 4. Verify your changes
git diff --stat HEAD
```

If ANY gate fails, FIX IT before completing. Do NOT mark a task done with failing gates.

## Anti-Patterns (INSTANT REJECTION)

- Claiming "tests pass" without actually running `pnpm run test`
- Using workarounds instead of fixing root causes
- Skipping biome/lint checks
- Creating new files when existing files should be extended
- Using `catch (err: unknown)` — use proper error types
- Leaving `console.log` in production code
- Adding imports without checking if they break circular dependencies
- Modifying test expectations to match broken code instead of fixing the code

## Paths SSoT (T9802 / SG-WORKTREE-CANON)

`packages/paths/` is the **ONLY** source of worktree and `.cleo` XDG path
resolution per Council verdict D009. Three patterns are CI-gated by
`scripts/lint-paths-ssot.mjs` (job `paths-ssot-lint`):

| Anti-pattern | Replacement |
|---|---|
| `import envPaths from 'env-paths'` outside `packages/paths/` | `getCleoHome()` / `getCleoPlatformPaths()` from `@cleocode/paths` |
| `process.env['XDG_DATA_HOME'] ?? join(...)` | `getCleoHome()` from `@cleocode/paths` |
| Hand-rolled `'/cleo/worktrees'` string | `resolveWorktreeRootForHash()` / `getCleoWorktreesRoot()` from `@cleocode/paths` |

Sentinel index path (D009 hybrid verdict): `resolveWorktreeIndexPath(projectRoot)`
returns `<projectRoot>/.cleo/worktrees.json` — the canonical per-project worktree
registry consumed by T9805 lifecycle hooks.

**Phase 1 (T9802 PR, current):** lint baseline established at 17 existing violations
(all `hand-rolled-xdg-read`, zero new). CI fails on net-add. Allowlisted legacy:
`packages/paths/src/platform-paths.ts` (SSoT itself) and
`packages/cleo-os/src/postinstall.ts` (bootstrap, runs before `@cleocode/paths` installs).

**Phase 2 (follow-up):** sweep all 17 baseline violations to zero across
`packages/cleo-os`, `packages/core`, `packages/adapters`, `packages/cant`, and
`packages/cleo`. Track as a follow-up child of T9802.

## Package-Boundary Check (MANDATORY)

Before creating or relocating ANY source file, verify the correct package by the
canonical layering contract:

| Package                    | Purpose                                           |
|----------------------------|---------------------------------------------------|
| `packages/core/`           | SDK — runtime primitives, domain logic, store, memory, sentient, gc |
| `packages/cleo/`           | CLI ONLY — thin dispatch + CLI command handlers   |
| `packages/contracts/`      | Shared types — envelope, operations, errors       |
| `packages/cleo-os/`        | Harness — Pi/Claude-Code adapters, CleoOS runtime |
| `packages/caamp/`          | Agent agent-manifest packaging (CAAMP)            |
| `packages/studio/`         | Frontend Studio (SvelteKit)                       |
| `packages/lafs/`           | LAFS envelope spec + validator                    |
| `packages/cant/`           | .cant DSL + parser                                |
| `packages/llmtxt-core/`    | llmtxt BlobOps/AgentSession primitives            |

Anti-patterns:
- ❌ Adding runtime/SDK code to `packages/cleo/` because files already exist there
- ❌ Placing cross-package shared types inline instead of in `packages/contracts/`
- ❌ Harness-specific code in `packages/core/` (belongs in `packages/cleo-os/`)
- ❌ CLI command handlers reaching into OS-level concerns (belongs in cleo-os)

When a task introduces new modules, the orchestrator MUST include an acceptance criterion of the form:
"Code placed in <packages/xxx/> per Package-Boundary Check — verified against AGENTS.md"

If existing files violate the boundary, flag as a separate cleanup task (e.g., T1015-style relocation epic). Do NOT continue appending to the wrong package.

## Task Hierarchy

**Canonical source:** `.cleo/adrs/ADR-073-above-epic-naming.md` §1 (Task Hierarchy Charter).
This section is a human-facing pointer — DO NOT redefine tier semantics, sizing, or
ownership here. All edits to the charter happen in ADR-073.

| Tier    | Prefix | Storage                                  | Scope-of-change                                    | Owner (ADR-070)       |
|---------|--------|------------------------------------------|----------------------------------------------------|------------------------|
| Saga    | `SG-`  | `type='epic'` + `label='saga'`           | Theme grouping ≥2 Epics across ≥2 releases         | Orchestrator (read)    |
| Epic    | `E-`   | `type='epic'`                            | One releasable slice; ≥1 PR to `main`              | Orchestrator (HITL)    |
| Task    | `T-`   | `type='task'`                            | One atomic PR-sized change; single wave            | Phase Lead             |
| Subtask | (none) | `type='subtask'`                         | One commit; ≤2 files; contributes to Task's PR     | Worker (leaf)          |

**Storage rule (I1):** All IDs stored as `T####`; `type` column discriminates tier; `label='saga'`
elevates Epic to Saga. Prefixes are DISPLAY + import-mapping only (I2). See ADR-073 §1.2 for the
8 invariants (I1–I8) and §1.3 for the lifecycle decision table.

## Sentient / Tier-2 Proposals

The `cleo sentient` subsystem manages autonomous task proposals.

- `cleo sentient status` — Show daemon status, kill-switch state, and tick stats.
- `cleo sentient propose enable` — Enable Tier-2 proposal generation.
- `cleo sentient propose disable` — Disable Tier-2 proposal generation.
- `cleo sentient propose list` — List all Tier-2 proposals (status=proposed).
- `cleo sentient propose accept <id>` — Accept a proposal.
- `cleo sentient propose reject <id>` — Reject a proposal.

Tier-2 proposals are **disabled by default**. Enable them with `cleo sentient propose enable`.
The kill-switch (`cleo sentient kill`) is always respected regardless of Tier-2 state.

## Release & Branching (ADR-065, SPEC-T9345)

All releases flow through a PR-gated pipeline. Direct pushes to `main` are
prohibited. The current pipeline uses the 4-verb model — `plan` → `open` →
`reconcile` (or `rollback`) — introduced by SPEC-T9345 and finalized when
T9540 removed the legacy `start` / `verify` / `publish` verbs.

### Branch Conventions

- **Feature work**: `feat/T####-<slug>` or `task/T####-<slug>` branches
- **Release branches**: cut by the `release-prepare` GitHub Actions workflow
  (dispatched by `cleo release open`) as `release/v<version>`
- **Main branch**: receives merges only from reviewed, CI-green PRs

### Shipping a Release

```bash
# 1. Plan — build the canonical Release Plan envelope.
#    Writes `.cleo/release/v<version>.plan.json` and persists one row in
#    `releases` with status='planned'. Read-mostly: no git mutations,
#    no `gh` calls, no network.
cleo release plan v2026.MM.N --epic TXXXX

# 2. Open — dispatch the release-prepare GHA workflow. The workflow cuts
#    `release/v<version>`, commits changelog + version bump, pushes the
#    branch, and opens the PR. `releases.status` advances to 'pr-opened'.
#    Use `--commit-plan` to commit the plan file in the same step.
cleo release open v2026.MM.N

# 3. (Optional) Poll PR + CI status while the workflow runs.
cleo release pr-status v2026.MM.N

# 4. Reconcile — after the PR merges and the release-publish workflow
#    pushes the tag, reconcile backfills the 11 provenance tables.
#    Typically invoked by the publish workflow itself; can be run
#    manually with --from-workflow=false.
cleo release reconcile v2026.MM.N
```

### Per-task evidence gating

Per-task quality gates are no longer batched at release time. The legacy
`cleo release verify` verb was removed in T9540; each task's gates must be
recorded individually via the ADR-051 evidence-based ritual BEFORE
completion:

```bash
# Per-task — runs once per gate, with programmatic evidence.
cleo verify T#### --gate implemented --evidence "commit:<sha>;files:..."
cleo verify T#### --gate testsPassed --evidence "tool:test"
cleo verify T#### --gate qaPassed --evidence "tool:lint;tool:typecheck"
cleo verify T#### --gate documented --evidence "files:..."

# Then mark the task done. CLEO re-validates every hard atom on complete.
cleo complete T####
```

See "Pre-Complete Gate Ritual (ADR-051)" in the protocol injection for the
full atom grammar and tool-resolution rules.

### Rules

- **NO direct pushes to `main`** — the pipeline enforces this
- `gh` CLI must be authenticated (`gh auth status`)
- Branch model is configurable: `cleo config set release.branchModel feat-to-main`
- To check in-flight PR CI status: `cleo release pr-status <version>`
- `cleo release ship` is **[DEPRECATED]** — it forwards to `plan` + `open`
  but emits a deprecation warning and will be removed no earlier than the
  third release cycle after T9498. Prefer the explicit two-verb invocation.

### Branch Protection

Owner runs once to enforce protection at the GitHub level:

```bash
gh api -X PUT repos/:owner/:repo/branches/main/protection \
  -f required_status_checks[strict]=true \
  -f required_status_checks[contexts][]=CI \
  -f required_status_checks[contexts][]="Lockfile Check" \
  -f required_status_checks[contexts][]="Contracts Dep Lint" \
  -f enforce_admins=false \
  -f required_pull_request_reviews[required_approving_review_count]=0 \
  -f restrictions=null
```

See `docs/release/branch-protection-setup.md` for full setup guide.

## Runtime Data Safety (ADR-013 §9)

`.cleo/tasks.db`, `.cleo/brain.db`, `.cleo/config.json`, and
`.cleo/project-info.json` are **not tracked in git** — committing them
risks data loss on branch switch because git overwrites the live file
while SQLite's WAL sidecars remain out of sync.

- **Manual snapshot**: `cleo backup add` captures all four files using
  `VACUUM INTO` (SQLite) + atomic tmp-then-rename (JSON).
- **Auto snapshot**: every `cleo session end` triggers
  `vacuumIntoBackupAll` which writes `tasks-YYYYMMDD-HHmmss.db` and
  `brain-YYYYMMDD-HHmmss.db` under `.cleo/backups/sqlite/` (10 snapshots
  per DB, oldest rotated out).
- **List snapshots**: `cleo backup list`
- **Restore**: `cleo restore backup --file tasks.db` (or brain.db /
  config.json / project-info.json)
- **Fresh clones**: `cleo init` recreates config.json and
  project-info.json from code defaults. `tasks.db` and `brain.db` are
  created empty on first database access.

NEVER run `git add .cleo/tasks.db`, `.cleo/brain.db`, `.cleo/config.json`,
or `.cleo/project-info.json` — the root and nested `.gitignore` files
are configured to block this, but manual overrides will re-open the
T5158 data-loss vector.

## Worktree Subsystem (T9800 Saga — ADR-055 / D009)

CLEO manages agent worktrees through two complementary mechanisms:

### Canonical CLEO-spawned worktrees

Created by `cleo orchestrate spawn` via `packages/worktree/` SSoT. These
live under `~/.local/share/cleo/worktrees/<projectHash>/<taskId>/` (XDG
canonical layout, D029). They are automatically listed, classified, and
cleaned up via `cleo worktree list|prune`.

### External worktrees (Claude Code Agent `isolation:worktree`)

Claude Code Agent tool spawns with `isolation:worktree` create directories
under `.claude/worktrees/<sessionId>/` **outside** the CLEO SSoT. These
bypass `cleo orchestrate spawn` entirely.

**Solution: Option B (Adopt)**  
CLEO cannot modify the Claude Code harness directly. Instead, external
worktrees are registered post-hoc using `cleo worktree adopt`.

#### Adopt command

```bash
# Register a Claude Code Agent worktree in the CLEO SSoT
cleo worktree adopt .claude/worktrees/<sessionId>

# With explicit source classification
cleo worktree adopt .claude/worktrees/<sessionId> --source claude-agent

# With explicit task ID association
cleo worktree adopt /path/to/worktree --source manual --task-id T9804
```

After adoption:
- The worktree appears in `cleo worktree list` tagged with `source: claude-agent`.
- An audit entry is appended to `.cleo/audit/worktree-lifecycle.jsonl`.
- The worktree is subject to the same auto-cleanup rules as CLEO-spawned worktrees.

#### Sentinel index

Adopted worktrees are tracked in `.cleo/worktrees.json` (council D009 hybrid
pattern). This file is gitignored and advisory — integrity does not depend on it.

**IMPORTANT**: Agents that use `isolation:worktree` MUST call `cleo worktree adopt`
immediately after the worktree is created if they want the worktree to surface in
`cleo worktree list` and receive lifecycle cleanup hooks. AC4 and AC5 validation
(real-world 5-agent test + `.claude/worktrees/` depopulation) are handled by T9808.