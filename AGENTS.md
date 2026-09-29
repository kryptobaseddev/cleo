<!-- CAAMP:START -->
@~/.agents/AGENTS.md
@.cleo/project-context.json
# Run: cleo memory digest
<!-- CAAMP:END -->

# CLEO Project Rules (MANDATORY)

Rules below are NON-NEGOTIABLE for this repo. Protocol surface (sessions, tasks, memory, orchestration, evidence gates) is in CLEO-INJECTION.md and not duplicated here.

## Instruction architecture

Protocol source: `packages/core/templates/CLEO-INJECTION.md` (installed to the CLEO templates dir; `~/.agents/AGENTS.md` points there). This file owns repo rules; CAAMP owns managed blocks; provider adapters own delivery; `packages/skills/skills/` ct-* skills own workflow detail. A literal `@path` is not proof a file loaded — unverified delivery needs a self-contained managed bootstrap. Keep user text outside managed blocks unchanged. When changing instruction behavior, check packaged, installed, global, project, provider, skill, bridge and spawn surfaces, run command-existence and delivery regressions, and mark live Codex/Claude/Kimi evaluations unverified unless run.

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

| Package | Purpose |
|---|---|
| `packages/core/` | SDK — runtime primitives, domain logic, store, memory, sentient, gc |
| `packages/cleo/` | CLI ONLY — thin dispatch + command handlers |
| `packages/contracts/` | Shared types — envelope, operations, errors |
| `packages/cleo-os/` | Harness — Pi/Claude-Code adapters, CleoOS runtime |
| `packages/caamp/` | Agent manifest packaging (CAAMP) |
| `packages/studio/` | Frontend Studio (SvelteKit) |
| `packages/lafs/` | LAFS envelope spec + validator |
| `packages/cant/` | .cant DSL + parser |
| `packages/llmtxt-core/` | llmtxt BlobOps/AgentSession primitives |

Anti-patterns: SDK code in `cleo/` because files exist there · cross-package types declared inline instead of in `contracts/` · harness-specific code in `core/` · CLI handlers reaching into OS concerns.

When introducing modules, include the acceptance criterion:
> "Code placed in `packages/xxx/` per Package-Boundary Check — verified against AGENTS.md"

Existing violations → separate relocation task, do not pile on.

## SSoT & Architectural Gates (Saga T9831 · SG-ARCH-SOLID · T9837)

`cleo check arch` runs every gate below in baseline mode (regressions only) — it MUST stay green before pushing. `cleo check arch --strict` is zero-tolerance and fails today by design (real baselines). CI job: `Architectural Boundary Check (SG-ARCH-SOLID T9837)`. Runner `gate-N` ids and these row numbers are independent — join on SCRIPT PATH (gate 20 does).

Full rationale per gate: `cleo docs fetch arch-gates-rationale` (git mirror: `docs/spec/arch-gates-rationale.md`)

| # | Gate | Script | Baseline | Rule |
|---|---|---|---|---|
| 1 | `defineCommand` factory SSoT (T10072) | `scripts/lint-no-raw-define-command.mjs` | `.cleo/define-command-ssot-baseline.json` | Only `packages/cleo/src/cli/lib/define-cli-command.ts` may import from `'citty'`. |
| 2 | Paths SSoT (T9802 · D009) | `scripts/lint-paths-ssot.mjs` | inline | `env-paths`, `XDG_DATA_HOME` reads and `'/cleo/worktrees'` strings live in `packages/paths/` only. |
| 3 | DB Open Guard (T10073 · ADR-068 · T11529) | `scripts/lint-no-direct-db-open.mjs --strict` | inline (3-entry allowlist) | **STRICT:** `new DatabaseSync(`/`new Database(` only in the allowlist below; elsewhere use `openDualScopeDb`/`openCleoDb` or `// db-open-allowed: <reason>`. |
| 4 | Contracts Fan-Out (T10074) | `scripts/lint-contracts-fan-out.mjs` | `scripts/.lint-contracts-fan-out-baseline.json` | `export interface`/`type` in `cleo/` or `core/` imported by >2 packages moves to `packages/contracts/`. |
| 5 | `SSoT-EXEMPT` linkage (T10075) | `scripts/lint-no-ssot-exempt.mjs` | inline | Every `// SSoT-EXEMPT` comment references an open `T####` task. |
| 6 | CLI package boundary (T9837e) | `scripts/lint-cli-package-boundary.mjs` | `scripts/.lint-cli-boundary-baseline.json` | No standalone named function >30 LOC in `packages/cleo/src/cli/commands/**/*.ts` — move helpers to `core/`. |
| 7 | Deployed template parity (T9860) | `scripts/lint-deployed-template-parity.mjs` | `.lint-deployed-template-parity-baseline.json` | `.github/workflows/*` MUST match rendered `packages/core/templates/workflows/*.yml.tmpl`. |
| 8 | `engines.node` SSoT (T11281) | `scripts/lint-node-engine-ssot.mjs` | inline (root `package.json`) | Every `packages/*/package.json` `engines.node` and `FALLBACK_MIN_NODE` equal root's — bump the floor with one root edit. |
| 9 | Publish surface SSoT (T11400) | `scripts/lint-publish-surface.mjs` | inline (`EXPECTED_PUBLISH_COUNT`) | `publish_pkg` in `.github/workflows/release.yml` is the npm publish SSoT: count equals `EXPECTED_PUBLISH_COUNT` (shrink both in one PR), entries public and correctly named, no `worktree-napi-*` stubs. |
| 10 | Contracts purity (T11418) | `scripts/lint-no-runtime-in-contracts.mjs` | `scripts/.lint-no-runtime-in-contracts-baseline.json` | `packages/contracts/` is types-only: no net-new exported runtime helper (type guards, zod schemas and const data are fine). |
| 11 | Tools-vs-Skills boundary (T11409) | `scripts/lint-tools-vs-skills-boundary.mjs` | `scripts/.lint-tools-vs-skills-boundary-baseline.json` | Atomic tool primitives are defined only in `packages/core/src/tools` + `packages/contracts/src/tools`; harness/provider packages consume, never redefine. |
| 12 | Crate publish guard (T11389) | `scripts/lint-no-crate-publish.mjs` | inline (`ALLOWLIST`) | Every `crates/<name>/Cargo.toml` declares `publish = false`, unless deliberately `publish = true` **and** in `ALLOWLIST`. |
| 13 | LLM Chokepoint Guard (T11783) | `scripts/lint-llm-chokepoint.mjs` | `scripts/.lint-llm-chokepoint-baseline.json` | LLM resolution and client/transport construction live only in the chokepoint (`resolveLLMForSystem`/`role-resolver.ts`/`api-mode.ts`/`model-runner.ts`/`transports/**`); opt-out `// llm-resolve-allowed: <reason>`. |
| 14 | Injection Command Existence (T12069) | `scripts/lint-injection-commands.mjs` | inline (`RETIRED_COMMAND_ALLOWLIST`) | Every `cleo <verb> [<sub>]` in `packages/core/templates/CLEO-INJECTION.md` resolves against the CLI command manifest. |
| 15 | Workflow Command Existence (T12093) | `scripts/lint-workflow-cleo-commands.mjs` | none (zero-tolerance) | Every `cleo <verb> [<sub>]` in a `run:` block of `.github/workflows/*.yml` or `packages/core/templates/workflows/*.yml.tmpl` resolves against the manifest. |
| 16 | Bare `getActiveSession()` (T11640) | `scripts/lint-no-bare-get-active-session.mjs` | `scripts/.lint-no-bare-get-active-session-baseline.json` (4-callsite baseline, T12500) | No net-new bare `getActiveSession()` or inline newest-active selection — mutations use `resolveBoundSession`/`requireBoundSession`, reads `resolveSessionForRead` (opt-out `// get-active-session-allowed: <reason>`). |
| 17 | Per-domain DB singleton (T12041) | `scripts/lint-no-domain-db-singleton.mjs` | inline (8-violation baseline) | No net-new per-domain DB handle cache — bind through the `ProjectStore`/`GlobalStore` ports. |
| 18 | Vitest memory safety (T12087) | `scripts/lint-vitest-memory-safe.mjs` | none (zero-tolerance) | Every `vitest.config.*` MUST spread `MEMORY_SAFE_TEST_DEFAULTS`. |
| 19 | CLI startup barrel imports (T12076) | `scripts/lint-cli-startup-barrel-imports.mjs` | inline (106-import ratchet) | Repo-wide ratchet: static `@cleocode/core` barrel imports in the CLI may fall, never rise. |
| 20 | Arch-gate parity (T12122) | `scripts/lint-arch-gate-parity.mjs` | none (zero-tolerance) | The gates bundled in `cleo check arch` and THIS table name the same scripts, joined on script path. |
| 21 | Dual-scope unqualified reads (T12156) | `scripts/lint-dual-scope-unqualified-reads.mjs` | `scripts/.lint-dual-scope-unqualified-reads-baseline.json` | Tables resident in BOTH project and global `cleo.db` MUST be schema-qualified in SQL. |
| 22 | AI SDK surface inventory (T12169) | `scripts/lint-ai-sdk-surface.mjs` | `scripts/.lint-ai-sdk-surface-baseline.json` | No net-new module reaching the AI SDK at runtime (type-only imports do not count). |
| 23 | Agent-prompt command existence (T12308) | `scripts/lint-agent-prompt-commands.mjs` | none (zero-tolerance) | Every `cleo` command the spawn prompt emits resolves against the manifest. |
| 24 | No committed native binaries (T12382) | `scripts/lint-no-committed-native-binaries.mjs` | inline (`BASELINE`, 1 non-cant entry) | No tracked `*.node`/`*.wasm`; a cant binary can never be baselined. |
| 25 | CLI startup barrel — entrypoint graph (T12455 · T12138) | `scripts/lint-cli-startup-barrel-entrypoint.mjs` | none (zero-tolerance) | Nothing in `packages/cleo/src/cli/index.ts`'s static import graph statically imports a core barrel — use dynamic `await import()` (opt-out `// startup-barrel-allowed: <reason>`). |
| 26 | No raw negated-flag reads (T12528) | `scripts/lint-no-negated-flag-reads.mjs` | inline (`BASELINE`, 1 entry: `orchestrate.ts`, owned by PR #1577) | Read `--no-<flag>` only via `negatedFlag(args, '<name>')`, never `args['no-<flag>']`/`args.noFoo` under `packages/cleo/src/`. |
| 27 | HITL ask-tool rule delivery (T12483) | `scripts/lint-hitl-rule-delivery.mjs` | none (zero-tolerance) | The ask-tool owner-decision rule stays present on every agent surface: CLEO-INJECTION.md, `ct-cleo`, `ct-orchestrator`, and the spawn-prompt Return Format Contract. |
| 28 | Raw table writers — Gate A ratchet (T12332) | `scripts/lint-no-raw-table-writes.mjs` | `scripts/.lint-no-raw-table-writes-baseline.json` (226 sites / 72 files) | No net-new raw `INSERT`/`UPDATE`/`DELETE`/`REPLACE` on a classified `cleo.db` table outside the chokepoint (`openDualScopeDb` + the canonical accessors); write through the table's accessor. |
| 29 | Skills manifest SSoT (T12648 · D11157) | `scripts/lint-skills-manifest.mjs` | none (zero-tolerance) | SKILL.md frontmatter is the skills metadata SSoT: `name` = directory, description ≤ 1024 chars, no duplicate keys or top-level `tier`, and `metadata.version`/`tier` (core\|on-demand\|internal)/`install` (harness\|internal). `packages/skills/skills/manifest.json` MUST equal `node scripts/skills/generate-manifest.mjs` output — never hand-edit it. |
| 30 | Emitted-skill installability (T12648 · D11157) | `scripts/lint-emitted-skills.mjs` | `scripts/.lint-emitted-skills-baseline.json` | Every skill named by `stage-guidance.ts`, `spawn-prompt.ts` (`loadSkillExcerpt`/`resolveSkillPath`) or a `.cant` `skillRef:` exists, is `metadata.install: harness` and is actually installed; `metadata.install` matches what `initCoreSkills` installs. Stale baseline entries fail. |
| 35 | Model call sites registered (T12663 · D11158) | `scripts/lint-model-call-sites.mjs` | `scripts/.lint-model-call-sites-baseline.json` (per rule, per file) | Every `decide()`/`askSiteDecision` site id and every file calling an LLM entry point is a row of `packages/core/src/decide/sites/registry.ts` with a generative/agent rung; a System One site runs `on` only with go-live evidence (debug verb exempt); chokepoint bypasses are baselined per file and may only fall. A System One site's go-live `evidenceDoc` must resolve to a tracked `docs/**/<slug>.md` mirror. Opt-out `// model-site-allowed: <reason>` (reason required) trailing the line or alone on the line above. |

**Common modes (all gates):** `--strict` zero-tolerance · `--baseline` regenerate · default fail-on-net-add.

**Per-line opt-outs (trailing comment):** `// define-command-ssot-allowed`, `// db-open-allowed: <reason>`, `// fan-out-ok: <reason>`, `// ssot-exempt-ok: <reason>`, `// cli-boundary-ok: <reason>`, `// cli-boundary-file-ok: <reason>` (first 20 lines), `// llm-resolve-allowed: <reason>`, `// startup-barrel-allowed: <reason>`, `// model-site-allowed: <reason>` (gate 35; also accepted alone on the line above).

**Exempt by convention (CLI package boundary, row 6):** functions named `*Command` / `make*Command` (citty factory helpers).

### DB Open Guard — canonical allowlist (row 3)

| Location | Reason |
|---|---|
| `packages/core/src/store/**` | The chokepoint (incl. `dual-scope-db.ts`) |
| `packages/core/src/migration/**` | Schema bootstrapping (pre-chokepoint) |
| `packages/studio/src/lib/server/db/connections.ts` | Per-project ProjectContext opens (pre-port) |

Test files (`__tests__/`, `.test.ts`, `.spec.ts`) may open raw for seeding (regex match). Every other legitimate raw open carries an inline `// db-open-allowed: <reason>` marker. Bypassing the chokepoint causes pragma drift (vs `specs/sqlite-pragmas.json`), WAL/lock contention, and handles `cleo health` cannot enumerate.

### `SSoT-EXEMPT` exception comments (Gate 5 · T10075)

Valid formats: `// SSoT-EXEMPT:<reason> (T####)` · `// SSoT-EXEMPT: reason T####` · `// SSoT-EXEMPT:reason — tracked in T####`. The `T####` MUST NOT be terminal (`completed`/`cancelled`/`deleted`). Per-line opt-out: trailing `// ssot-exempt-ok: <reason>`. To add a legitimate exemption: file a follow-up `cleo add --type task --title "Remove SSoT-EXEMPT in <file>"`, use that ID in the comment.

## Canonical Docs Routing (ADR-076 · T9796)

Canonical docs (ADR, spec, research, handoff, note, release-note, plan) — create via `cleo docs add`, NEVER raw `Write`. Routing registry: `.cleo/canon.yml` (schema `.cleo/canon.schema.json`). Per-DocKind fields: `canonicalHome` (`ssot` or `ssot-first`), `publishMirror`, `rawMdAllowed`.

CI gate: `cleo check canon docs` (`Canon Drift Check (T9796)`) — walks `git diff --diff-filter=A` PR-base→HEAD, flags new `*.md` bypassing the SSoT (forward-only; legacy files imported by T9791 never flagged).

**LAFS envelope contract:** `docs/specs/LAFS-ENVELOPE-CONTRACT.md` (SSoT slug `lafs-envelope-contract`, owner T11113).

**New doc kind:** add to `packages/contracts/src/docs-taxonomy.ts` (`BUILTIN_DOC_KINDS`) → add routing entry to `.cleo/canon.yml` → `pnpm --filter @cleocode/cleo run build`.

## Docs Storage Surfaces (T11052 — implementation details)

Agents MUST NOT navigate/read/write these directly — use `cleo docs add|fetch|list|status|publish|generate|list-types`. Bypassing creates unreachable blobs and triggers drift alerts.

| Surface | Location | Contents |
|---|---|---|
| Attachment rows | `.cleo/attachments/index.db` + `.cleo/attachments/sha256/<prefix>/<hash>.<ext>` | Per-task attachments (local-file, url, blob, llms-txt, llmtxt-doc) |
| Blob manifest | `.cleo/blobs/manifest.db` + `.cleo/blobs/blobs/<sha>` | Content-addressed doc SSoT (ADR, spec, research, handoff, note, plan, changeset) |
| Publication ledger | `.cleo/docs-publications.json` | Slug → on-disk mirror path; drives the pre-commit drift hook |

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

Canonical `ct-*` skills under `packages/skills/skills/` describe how CLEO works to every spawned agent; stale skill text means agents act on stale instructions.

**Convention:** when you edit a path declared in the coverage map (`packages/skills/internal/skill-coverage.yml`), update the corresponding skill in the same PR — or acknowledge via commit trailer `Skill-Drift-Acknowledged: <reason>`.

> ⚠️ **NOT ENFORCED — convention, not a gate (T12124 · GH #1256).** No script or workflow reads the coverage map, and the tier-0 skills have no coverage entries. **Treat skill updates as a manual responsibility on every PR** (history: `cleo docs fetch arch-gates-rationale`, appendix).

**Tier-0 skills — trailer override is not permitted BY CONVENTION (unenforced):** `ct-cleo` (CLI protocol + session lifecycle) · `ct-orchestrator` (spawn/delegation contract) · `ct-task-executor` (worker contract) · `ct-dev-workflow` (commit / branch / release flow) · `ct-documentor` (docs SSoT routing) · `CLEO-INJECTION.md` (protocol injected into every spawn prompt).

**Tier-1 LOOM-stage skills** (one per stage in `packages/core/src/validation/protocols/`): trailer override permitted.

Every `SKILL.md` ships with metadata (enforced by gate 29):

```yaml
metadata:
  version: 2.0.0           # bump on every material change
  tier: core               # core | on-demand | internal (D11157)
  install: harness         # harness | internal
  lastReviewed: 2026-05-21 # ISO date
  stability: stable        # experimental | stable | deprecated
```

This frontmatter is the metadata SSoT: gate 29 fails when `packages/skills/skills/manifest.json` differs from `node scripts/skills/generate-manifest.mjs` output (T12648).

## Release & Branching (ADR-065 · SPEC-T9345 · ADR-087)

PR-gated pipeline. **NO direct pushes to `main`.** All PRs target `main` through GitHub Merge Queue.

> Deliberate exception (T12152): branch protection sets `enforce_admins: false`, so a repo admin CAN merge without `CI` — the owner's intended escape hatch, not a vulnerability or evidence the pipeline is broken. Force-pushes and deletions stay blocked; `required_status_checks.strict: true`.

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

`.cleo/cleo.db`, `.cleo/brain.db`, `.cleo/config.json`, `.cleo/project-info.json` are **not tracked in git** — committing them risks data loss on branch switch (git overwrites the live file while SQLite WAL sidecars desync).

- **Manual snapshot:** `cleo backup add` — `VACUUM INTO` (SQLite) + atomic tmp-then-rename (JSON).
- **Auto snapshot:** `cleo session end` → `vacuumIntoBackupAll` writes timestamped snapshots under `.cleo/backups/sqlite/` (10 per DB, oldest rotated out).
- **List:** `cleo backup list`
- **Restore:** `cleo restore backup --file tasks.db` (or brain.db / config.json / project-info.json)
- **Fresh clones:** `cleo init` recreates config + project-info; DBs are created empty on first access. The clone keeps the original `projectId` because `init` reads it from the tracked `.cleo/project-id`.

**One exception: `.cleo/project-id` IS tracked** (ADR-094, amending ADR-013 §9 · T12325). It holds the write-once portable project identity. CLEO creates it once with `O_EXCL` and never rewrites it, so git has nothing to overwrite. The §9 hazard needed a second writer and state that changes, and this file has neither. **Commit it; never edit or regenerate it.**
- A conflict with `project-info.json` is reported, and the local id is kept.
- A missing file is re-linked from `project-info.json` or the global registry. A new id is minted only when nothing can be re-linked, or explicitly with `cleo init --new-identity`.
- A fork inherits the id; see ADR-094 for the fork caveat.
- Check it with `cleo doctor project-identity`. It reports missing, conflicting, invalid, uncommitted or gitignored ids with the exact remedy. `--resolve --dry-run` shows the plan; `--resolve` applies it. A conflict is re-keyed to the tracked id through the alias table, so no registry row is lost and the old id still resolves (T12353).

**NEVER** `git add` any of these four files. Root and nested `.gitignore` block this; manual overrides re-open the T5158 data-loss vector.

### Memory guard — what CLEO bounds, and what it CANNOT (T12096 · T12097)

CLEO caps heap, workers and `pnpm -r` fan-out ONLY for evidence runs (`cleo verify --evidence "tool:test"`, via `resources/heavy-tool-env.ts`). A test an agent starts itself (`pnpm test`, `npx vitest run`, `cargo test`) gets no CLEO bound, and environment variables bind only shells started after they are set — a cgroup limit on the enclosing slice is the only layer that binds running processes. A freeze with no OOM kill is throttle-and-thrash: diagnose with `journalctl -b -1 -k | grep -i oom-kill` FIRST (empty = throttling, not OOM).

```bash
cleo doctor memory-guard          # audit (read-only)
cleo doctor memory-guard --fix    # apply RAM-derived limits to app.slice
```

Limits derive from total RAM (`MemoryHigh` 72 %, `MemoryMax` 90 %); off-Linux the audit reports `supported: false`.

### The store is `cleo.db` (T12095)

The live store is `.cleo/cleo.db` (prefixed tables, `tasks_tasks`); small `.cleo/tasks.db`, large `.cleo/backups/sqlite/tasks-<ts>.db` snapshots, and an empty bare `tasks` table are normal decoys (see CLEO-INJECTION.md "Where the data lives"). `cleo doctor superseded-store` proves which store holds the data by row counts. Read-only.
