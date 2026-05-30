<!-- CAAMP:START -->
@~/.agents/AGENTS.md
@.cleo/project-context.json
# Run: cleo memory digest --brief
<!-- CAAMP:END -->

# CLEO Project Rules (MANDATORY)

Rules below are NON-NEGOTIABLE for this repo. Protocol surface (sessions, tasks, memory, orchestration, evidence gates) is in CLEO-INJECTION.md and not duplicated here.

## Code Quality

**Type safety (zero tolerance).** NEVER `any`, `unknown` as a shortcut, `as unknown as X` casting chains, or inline/mocked types. Use `packages/contracts/src/` — build new contracts if genuinely missing.

**DRY + SOLID.** Read existing code first. Search for existing utilities before writing new ones. Centralize shared logic into lib modules. Match existing style, naming, and structure. Keep imports sorted (biome enforces).

**Documentation.** Add TSDoc (`/** ... */`) on ALL exported functions, classes, types, constants. Update existing docs — never create new ones unless necessary. Validate with `forge-ts` when available.

**Anti-patterns (instant rejection).** Claiming "tests pass" without running them. Workarounds instead of root-cause fixes. Skipping biome/lint. Creating new files when extension would do. `catch (err: unknown)`. `console.log` in production. Imports without circular-dep check. Modifying test expectations to match broken code.

## Quality Gates (before completing)

```bash
pnpm biome check --write .   # format + lint
pnpm run build               # build
pnpm run test                # ZERO new failures
git diff --stat HEAD         # verify scope
```

ANY failure → fix before completing.

## Package Boundary (verify before creating/relocating files)

| Package                 | Purpose                                                |
|-------------------------|--------------------------------------------------------|
| `packages/core/`        | SDK — runtime primitives, domain logic, store, memory, sentient, gc |
| `packages/cleo/`        | CLI ONLY — thin dispatch + command handlers           |
| `packages/contracts/`   | Shared types — envelope, operations, errors           |
| `packages/cleo-os/`     | Harness — Pi/Claude-Code adapters, CleoOS runtime     |
| `packages/caamp/`       | Agent manifest packaging (CAAMP)                      |
| `packages/studio/`      | Frontend Studio (SvelteKit)                           |
| `packages/lafs/`        | LAFS envelope spec + validator                        |
| `packages/cant/`        | .cant DSL + parser                                    |
| `packages/llmtxt-core/` | llmtxt BlobOps/AgentSession primitives                |

Anti-patterns: SDK code in `cleo/` because files exist there · cross-package types declared inline instead of in `contracts/` · harness-specific code in `core/` · CLI handlers reaching into OS concerns.

When introducing modules, include the acceptance criterion:
> "Code placed in `packages/xxx/` per Package-Boundary Check — verified against AGENTS.md"

Existing violations → separate relocation task, do not pile on.

## SSoT & Architectural Gates (Saga T9831 · SG-ARCH-SOLID · T9837)

Run all gates at once:

```bash
cleo check arch          # baseline mode — regressions only
cleo check arch --strict # zero-tolerance
```

CI job: `Architectural Boundary Check (SG-ARCH-SOLID T9837)` (baseline mode by default).

| # | Gate                                  | Script                                          | Baseline                                          | Rule                                                                                  |
|---|---------------------------------------|-------------------------------------------------|---------------------------------------------------|---------------------------------------------------------------------------------------|
| 1 | `defineCommand` factory SSoT (T10072) | `scripts/lint-no-raw-define-command.mjs`        | `.cleo/define-command-ssot-baseline.json`         | Only `packages/cleo/src/cli/lib/define-cli-command.ts` may import from `'citty'`.    |
| 2 | Paths SSoT (T9802 · D009)             | `scripts/lint-paths-ssot.mjs`                   | inline                                            | `env-paths`, `XDG_DATA_HOME` reads, `'/cleo/worktrees'` strings live in `packages/paths/` only. |
| 3 | DB Open Guard (T10073 · ADR-068)      | `scripts/lint-no-direct-db-open.mjs`            | inline                                            | `new DatabaseSync(`/`new Database(` only inside `packages/core/src/store/` — others use `openCleoDb(role, cwd)`. |
| 4 | Contracts Fan-Out (T10074)            | `scripts/lint-contracts-fan-out.mjs`            | `scripts/.lint-contracts-fan-out-baseline.json`   | `export interface`/`type` in `cleo/` or `core/` imported by >2 packages must move to `packages/contracts/`. |
| 5 | `SSoT-EXEMPT` linkage (T10075)        | `scripts/lint-no-ssot-exempt.mjs`               | inline                                            | Every `// SSoT-EXEMPT` comment must reference an open `T####` task.                  |
| 6 | CLI package boundary (T9837e)         | `scripts/lint-cli-package-boundary.mjs`         | `scripts/.lint-cli-boundary-baseline.json`        | No standalone named function >30 LOC in `packages/cleo/src/cli/commands/**/*.ts` — move helpers to `core/`. |
| 7 | Deployed template parity (T9860)      | `scripts/lint-deployed-template-parity.mjs`     | `.lint-deployed-template-parity-baseline.json`    | `.github/workflows/*` MUST match rendered output of `packages/core/templates/workflows/*.yml.tmpl`. |
| 8 | `engines.node` SSoT (T11281)          | `scripts/lint-node-engine-ssot.mjs`             | inline (root `package.json`)                      | Every `packages/*/package.json` `engines.node` MUST equal root's; `FALLBACK_MIN_NODE` in `node-version-gate.ts` matches. The Node gate reads `engines.node` at runtime — bumping the floor is one root edit. |
| 9 | Publish surface SSoT (T11400)         | `scripts/lint-publish-surface.mjs`              | inline (`EXPECTED_PUBLISH_COUNT`)                 | The `publish_pkg` list in `.github/workflows/release.yml` is the npm publish SSoT. Entry count MUST equal `EXPECTED_PUBLISH_COUNT` (18 post-E1, trending DOWN to 1 per owner decision 1); every entry is public + correctly-named; no per-platform `worktree-napi-*` stub in the list or on disk. To shrink: delete the line **and** decrement the constant in the same PR. |
| 10 | Contracts purity (T11418)            | `scripts/lint-no-runtime-in-contracts.mjs`      | `scripts/.lint-no-runtime-in-contracts-baseline.json` | `packages/contracts/` is types-only. NO net-new exported runtime helper (a bodied function/arrow that isn't a type guard `: x is T`, zod schema, or const data). Pre-existing helpers are baselined and migrate OUT under E5 (T11392); `--strict` passes once contracts is pure. Tighten after a migration with `--update-baseline`. |

**Common modes (all gates):** `--strict` zero-tolerance · `--baseline` regenerate · default fail-on-net-add.

**Per-line opt-outs (trailing comment):** `// define-command-ssot-allowed`, `// db-open-allowed: <reason>`, `// fan-out-ok: <reason>`, `// ssot-exempt-ok: <reason>`, `// cli-boundary-ok: <reason>`, `// cli-boundary-file-ok: <reason>` (first 20 lines).

**Exempt by convention (Gate 6):** functions named `*Command` / `make*Command` (citty factory helpers).

### DB Open Guard — canonical allowlist (Gate 3)

| Location                                              | Reason                                          |
|-------------------------------------------------------|-------------------------------------------------|
| `packages/core/src/store/**`                          | The chokepoint                                  |
| `packages/core/src/migration/**`                      | Schema bootstrapping                            |
| `packages/core/src/memory/claude-mem-migration.ts`    | One-shot memory migration                       |
| `packages/core/src/memory/graph-memory-bridge.ts`     | Hot-path conduit open                           |
| `packages/core/src/conduit/**`                        | Core-owned conduit infrastructure               |
| `packages/core/src/upgrade.ts`                        | One-shot historical migration                   |
| `packages/core/src/init.ts`                           | Bootstrap before chokepoint exists              |
| `packages/core/src/agents/seed-install.ts`            | One-shot global install                         |
| `packages/core/src/orchestration/classify.ts`         | JSDoc `@example` blocks only                    |
| `packages/core/src/nexus/**`                          | Per-project graph DBs (non-CLEO metadata)       |
| `packages/brain/src/db-connections.ts`                | Package-boundary constraint (no core dep)       |
| `packages/studio/src/lib/server/db/connections.ts`    | Per-project ProjectContext opens                |
| Test files (`__tests__/`, `.test.ts`, `.spec.ts`)     | May open raw for seeding                        |

Bypassing the chokepoint causes pragma drift (vs `specs/sqlite-pragmas.json`), WAL/lock contention, and topology opacity (`cleo health` cannot enumerate the handle).

### `SSoT-EXEMPT` exception comments (Gate 5 · T10075)

Valid formats:

```ts
// SSoT-EXEMPT:<reason> (T####)
// SSoT-EXEMPT: reason T####
// SSoT-EXEMPT:reason — tracked in T####
```

The `T####` MUST NOT be terminal (`completed`/`cancelled`/`deleted`). Per-line opt-out: trailing `// ssot-exempt-ok: <reason>`. To add a legitimate exemption: file a follow-up `cleo add --type task --title "Remove SSoT-EXEMPT in <file>"`, use that ID in the comment.

## Canonical Docs Routing (ADR-076 · T9796)

Canonical docs (ADR, spec, research, handoff, note, release-note, plan) — create via `cleo docs add`, NEVER raw `Write`. Routing registry: `.cleo/canon.yml` (schema `.cleo/canon.schema.json`). Per-DocKind fields: `canonicalHome` (`ssot` or `ssot-first`), `publishMirror`, `rawMdAllowed`.

CI gate: `cleo check canon docs` (`Canon Drift Check (T9796)`) — walks `git diff --diff-filter=A` PR-base→HEAD, flags new `*.md` bypassing the SSoT (forward-only; legacy files imported by T9791 never flagged).

**New doc kind:** add to `packages/contracts/src/docs-taxonomy.ts` (`BUILTIN_DOC_KINDS`) → add routing entry to `.cleo/canon.yml` → `pnpm --filter @cleocode/cleo run build`.

## Docs Storage Surfaces (T11052 — implementation details)

Three storage surfaces. Agents MUST NOT navigate/read/write them directly — use the agent-facing CLI surface in CLEO-INJECTION.md (`cleo docs add|fetch|list|status|publish|generate|list-types`).

| Surface             | Location                                                                        | Contents                                                                       |
|---------------------|---------------------------------------------------------------------------------|--------------------------------------------------------------------------------|
| Attachment rows     | `.cleo/attachments/index.db` + `.cleo/attachments/sha256/<prefix>/<hash>.<ext>` | Per-task attachments (local-file, url, blob, llms-txt, llmtxt-doc)             |
| Blob manifest       | `.cleo/blobs/manifest.db` + `.cleo/blobs/blobs/<sha>`                           | Content-addressed doc SSoT (ADR, spec, research, handoff, note, plan, changeset) |
| Publication ledger  | `.cleo/docs-publications.json`                                                  | Slug → on-disk mirror path; drives the pre-commit drift hook                   |

Bypassing creates unreachable blobs and triggers drift alerts.

## Worktree Subsystem (ADR-055 · D009 · Saga T9800)

### Canonical path

`<cleoHome>/worktrees/<projectHash>/<taskId>/`:
- Linux: `~/.local/share/cleo/worktrees/<projectHash>/<taskId>/`
- macOS: `~/Library/Application Support/cleo/worktrees/<projectHash>/<taskId>/`

### Banned locations (no escape hatch — not even `CLEO_FORCE_LOCATION`)

- Project root (`/mnt/projects/cleocode/`)
- Any sibling (`/mnt/projects/*`)
- Inside another worktree
- Inside `.claude/worktrees/` or any `.claude/` subdir

### Enforcement

- **Runtime:** `packages/worktree/src/worktree-create.ts` throws `E_WT_LOCATION_FORBIDDEN` before `git worktree add`.
- **CI gate:** `scripts/lint-worktree-location.mjs` (`Worktree Location Lint`) — also rejects a `worktrees/` directory under `<repo>/.cleo/` (only the sentinel file `.cleo/worktrees.json` is allowed there).
- **Migration:** `scripts/migrate-rogue-worktrees.mjs` (`--dry-run` first).

See Epic T9809 (`E-WT-PROVISIONING-LOCATION-GUARDS`).

### `.worktreeinclude` (T9983 · Saga T9977)

Per-project file listing files copied into agent worktrees on provisioning (env files, IDE settings, lockfiles, caches).

- **Canonical:** `<projectRoot>/.worktreeinclude` — reader: `packages/worktree/src/worktree-include.ts` (delegates to `@cleocode/worktree-napi`).
- **Legacy:** `<projectRoot>/.cleo/worktree-include` — read for ONE deprecation cycle with one-time `DeprecationWarning`.
- **Migration:** `cleo doctor --migrate-worktree-include [--dry-run]` (backs legacy up to `.cleo/backups/worktree-include-<iso8601>.bak`).

`cleo init` / `cleo upgrade` write the canonical file from `packages/core/templates/worktreeinclude`. When only the legacy file exists, the scaffolder skips — migration is always explicit.

### External worktrees (Claude Code Agent `isolation:worktree`)

Claude Code Agent spawns under `.claude/worktrees/<sessionId>/` bypass the CLEO SSoT. Adopt them immediately:

```bash
cleo worktree adopt .claude/worktrees/<sessionId>
cleo worktree adopt /path/to/worktree --source manual --task-id T####
```

After adoption: surfaces in `cleo worktree list` tagged `source: claude-agent`, audit entry in `.cleo/audit/worktree-lifecycle.jsonl`, subject to auto-cleanup. Sentinel index `.cleo/worktrees.json` is gitignored and advisory.

## Skill Maintenance (Saga T9799 · Epic T9960)

Canonical `ct-*` skills under `packages/skills/skills/` describe how CLEO works to every spawned agent. When code changes but skill text doesn't, agents act on stale instructions.

**Rule:** when you edit a path declared in the coverage map (`packages/skills/internal/skill-coverage.yml`), update the corresponding skill in the same PR — or acknowledge via commit trailer `Skill-Drift-Acknowledged: <reason>`. CI gate: `Skill Drift Check` (fails with `E_SKILL_DRIFT_UNACKNOWLEDGED`).

**Tier-0 skills — NO trailer override permitted:**

- `ct-cleo` — CLI protocol + session lifecycle
- `ct-orchestrator` — spawn/delegation contract
- `ct-task-executor` — worker contract
- `ct-dev-workflow` — commit / branch / release flow
- `ct-documentor` — docs SSoT routing
- `CLEO-INJECTION.md` — protocol injected into every spawn prompt

**Tier-1 LOOM-stage skills** (one per stage in `packages/core/src/validation/protocols/`): trailer override permitted.

Every `SKILL.md` ships with metadata (documentation, not enforcement):

```yaml
metadata:
  version: 2.0.0           # bump on every material change
  lastReviewed: 2026-05-21 # ISO date
  stability: stable        # experimental | stable | deprecated
```

## Release & Branching (ADR-065 · SPEC-T9345 · ADR-087)

PR-gated pipeline. **NO direct pushes to `main`.** All PRs target `main` through GitHub Merge Queue.

**Verbs:** `plan` → `open` → `reconcile` (or `rollback`). The legacy `start`/`verify`/`publish` verbs were removed in T9540; the `ship` shim was deleted in T10103.

**Branches:** `feat/T####-<slug>` or `task/T####-<slug>` (feature) · `release/v<version>` (cut by `release-prepare` GHA workflow).

**Per-task evidence gating (ADR-051):** record gates individually BEFORE `cleo complete` — atom grammar in CLEO-INJECTION.md.

**Shipping:**

```bash
cleo release plan v2026.MM.N --epic TXXXX        # or --tasks TXXXX,TYYYY
cleo release open v2026.MM.N                     # dispatches release-prepare; --commit-plan to bundle
cleo release pr-status v2026.MM.N                # poll PR + CI
git tag -a v2026.MM.N -m "Release v2026.MM.N"    # explicit — auto-tag is retired
git push origin v2026.MM.N
cleo release reconcile v2026.MM.N                # backfills provenance tables
```

**One-shot smoke:** `cleo release ship-e2e-smoke <version> --epic <id>` — plan → open → wait-for-PR → wait-for-tag → verify-npm-published. Dry-run by default; `--execute` for real mutations.

**Branch protection (owner-once):**

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

Runbooks: `docs/release/merge-queue-runbook.md`, `docs/release/verb-matrix.md`, `docs/release/branch-protection-setup.md`.

## Runtime Data Safety (ADR-013 §9)

`.cleo/tasks.db`, `.cleo/brain.db`, `.cleo/config.json`, `.cleo/project-info.json` are **not tracked in git** — committing them risks data loss on branch switch (git overwrites the live file while SQLite WAL sidecars desync).

- **Manual snapshot:** `cleo backup add` — `VACUUM INTO` (SQLite) + atomic tmp-then-rename (JSON).
- **Auto snapshot:** `cleo session end` → `vacuumIntoBackupAll` writes timestamped snapshots under `.cleo/backups/sqlite/` (10 per DB, oldest rotated out).
- **List:** `cleo backup list`
- **Restore:** `cleo restore backup --file tasks.db` (or brain.db / config.json / project-info.json)
- **Fresh clones:** `cleo init` recreates config + project-info; DBs are created empty on first access.

**NEVER** `git add` any of these four files. Root and nested `.gitignore` block this; manual overrides re-open the T5158 data-loss vector.
