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

`cleo check arch` runs **every gate in the table below** — gate 20
(`lint-arch-gate-parity`) fails the build if the two ever disagree again. Until
T12122 they did: the runner bundled 10 of the 15 then-documented gates, so the
command reported a green that had never exercised the other five, and four
gates it *did* run were absent from this table. A tool that silently covers
part of what its documentation claims is the same defect as a filter that is
accepted and not applied — and every agent is told to run this command to
self-check before pushing.

Note that the runner's `gate-N` ids and this table's row numbers are
independent and do collide (runner `gate-6` is row 16's gate). Join on the
SCRIPT PATH, which is what gate 20 does.

`--strict` is aspirational, not a passing gate: several gates carry real
baselines, so `cleo check arch --strict` fails today by design. Baseline mode
(the default) is the one that must stay green.

CI job: `Architectural Boundary Check (SG-ARCH-SOLID T9837)` (baseline mode by default).

| # | Gate                                  | Script                                          | Baseline                                          | Rule                                                                                  |
|---|---------------------------------------|-------------------------------------------------|---------------------------------------------------|---------------------------------------------------------------------------------------|
| 1 | `defineCommand` factory SSoT (T10072) | `scripts/lint-no-raw-define-command.mjs`        | `.cleo/define-command-ssot-baseline.json`         | Only `packages/cleo/src/cli/lib/define-cli-command.ts` may import from `'citty'`.    |
| 2 | Paths SSoT (T9802 · D009)             | `scripts/lint-paths-ssot.mjs`                   | inline                                            | `env-paths`, `XDG_DATA_HOME` reads, `'/cleo/worktrees'` strings live in `packages/paths/` only. |
| 3 | DB Open Guard (T10073 · ADR-068 · T11529) | `scripts/lint-no-direct-db-open.mjs --strict` | inline (3-entry allowlist)                        | **STRICT (zero tolerance).** `new DatabaseSync(`/`new Database(` only inside the 3 canonical allowlist entries (store/, migration/, studio connections.ts) — everything else uses `openDualScopeDb`/`openCleoDb` or an inline `// db-open-allowed` marker. |
| 4 | Contracts Fan-Out (T10074)            | `scripts/lint-contracts-fan-out.mjs`            | `scripts/.lint-contracts-fan-out-baseline.json`   | `export interface`/`type` in `cleo/` or `core/` imported by >2 packages must move to `packages/contracts/`. |
| 5 | `SSoT-EXEMPT` linkage (T10075)        | `scripts/lint-no-ssot-exempt.mjs`               | inline                                            | Every `// SSoT-EXEMPT` comment must reference an open `T####` task.                  |
| 6 | CLI package boundary (T9837e)         | `scripts/lint-cli-package-boundary.mjs`         | `scripts/.lint-cli-boundary-baseline.json`        | No standalone named function >30 LOC in `packages/cleo/src/cli/commands/**/*.ts` — move helpers to `core/`. |
| 7 | Deployed template parity (T9860)      | `scripts/lint-deployed-template-parity.mjs`     | `.lint-deployed-template-parity-baseline.json`    | `.github/workflows/*` MUST match rendered output of `packages/core/templates/workflows/*.yml.tmpl`. |
| 8 | `engines.node` SSoT (T11281)          | `scripts/lint-node-engine-ssot.mjs`             | inline (root `package.json`)                      | Every `packages/*/package.json` `engines.node` MUST equal root's; `FALLBACK_MIN_NODE` in `node-version-gate.ts` matches. The Node gate reads `engines.node` at runtime — bumping the floor is one root edit. |
| 9 | Publish surface SSoT (T11400)         | `scripts/lint-publish-surface.mjs`              | inline (`EXPECTED_PUBLISH_COUNT`)                 | The `publish_pkg` list in `.github/workflows/release.yml` is the npm publish SSoT. Entry count MUST equal `EXPECTED_PUBLISH_COUNT` (18 post-E1, trending DOWN to 1 per owner decision 1); every entry is public + correctly-named; no per-platform `worktree-napi-*` stub in the list or on disk. To shrink: delete the line **and** decrement the constant in the same PR. |
| 10 | Contracts purity (T11418)            | `scripts/lint-no-runtime-in-contracts.mjs`      | `scripts/.lint-no-runtime-in-contracts-baseline.json` | `packages/contracts/` is types-only. NO net-new exported runtime helper (a bodied function/arrow that isn't a type guard `: x is T`, zod schema, or const data). Pre-existing helpers are baselined and migrate OUT under E5 (T11392); `--strict` passes once contracts is pure. Tighten after a migration with `--update-baseline`. |
| 11 | Tools-vs-Skills boundary (T11409)    | `scripts/lint-tools-vs-skills-boundary.mjs`     | `scripts/.lint-tools-vs-skills-boundary-baseline.json` | Atomic tool primitives are DEFINED only under `packages/core/src/tools` + `packages/contracts/src/tools` (per `ATOMIC_TOOL_BOUNDARY` in `boundary.ts`); harness/provider packages (`mcp-adapter`/`caamp`/`cleo-os`) CONSUME, never redefine. NO net-new out-of-home primitive definition. Tighten with `--update-baseline` after migrating one into `core/src/tools`. |
| 12 | Crate publish guard (T11389)         | `scripts/lint-no-crate-publish.mjs`             | inline (`ALLOWLIST`)                              | Zero crates.io publishes (owner decision): every `crates/<name>/Cargo.toml` MUST declare `publish = false`. A crate omitting it (Cargo default = publishable) or `publish = true` fails. For a deliberate external crate, set `publish = true` **and** add it to `ALLOWLIST`. |
| 13 | LLM Chokepoint Guard (T11783)         | `scripts/lint-llm-chokepoint.mjs`               | `scripts/.lint-llm-chokepoint-baseline.json`      | LLM resolution + client/transport construction live ONLY in the chokepoint (`resolveLLMForSystem`/`role-resolver.ts`/`api-mode.ts` + the single `model-runner.ts` + `transports/**`). Forbidden out-of-chokepoint (6 rule classes, each baselined): `new *Transport(`, AI-SDK `create{Anthropic,OpenAI,OpenAICompatible,GoogleGenerativeAI}(`, raw `new {Anthropic,OpenAI}(`, `process.env.*_API_KEY` reads, hardcoded model-id literals (core resolution/consumer code), `resolveCredentials(` for inline client construction. Structural fix for E9 resolver divergence (PR #954). Per-line opt-out `// llm-resolve-allowed: <reason>`. |
| 14 | Injection Command Existence (T12069)   | `scripts/lint-injection-commands.mjs`           | inline (`RETIRED_COMMAND_ALLOWLIST`)              | Every `cleo <verb> [<sub>]` named in `packages/core/templates/CLEO-INJECTION.md` MUST resolve against the CLI's command manifest. That template is injected verbatim into EVERY spawned agent and is phrased as instruction, so a documented-but-missing command burns a turn and — worse — teaches the agent the whole subsystem is broken. Measured 2026-08-06: 5 of 7 "first-reach" Nexus commands did not exist (`nexus report`/`brain find`/`compare`/`shared`/`synthesize`, plus `nexus admin`). Parses manifest + command modules from SOURCE (never `dist/`), so CI needs no build. A verb named while documenting its own REMOVAL goes in `RETIRED_COMMAND_ALLOWLIST` with rationale. |
| 15 | Workflow Command Existence (T12093)    | `scripts/lint-workflow-cleo-commands.mjs`       | none (zero-tolerance)                             | Gate 14's rule, applied to `.github/workflows/*.yml` + `packages/core/templates/workflows/*.yml.tmpl`. Every `cleo <verb> [<sub>]` in a `run:` block MUST resolve against the command manifest. Worse than gate 14's case because the failure is delayed and expensive: `release-prepare.yml` ran `cleo version-bump` (never existed) and then `cleo release changelog` (no such sub-verb), each at the END of `Prepare bump-PR`, so every dispatch cost a full green preflight (~21 min) to discover ONE of them — and the shipped template carried the same break into every consuming project since PR #868. Scans `run:` only (a `name:` is a display string) and anchors the match so `@cleocode/cleo exec …` is not read as `cleo exec`. |
| 16 | Bare `getActiveSession()` (T11640)     | `scripts/lint-no-bare-get-active-session.mjs`   | inline (11-callsite baseline)                     | No NET-NEW bare `getActiveSession()` callsite — use `resolveCurrentSession`, which honours the session-scope cascade instead of silently binding whatever session happens to be active. |
| 17 | Per-domain DB singleton (T12041)       | `scripts/lint-no-domain-db-singleton.mjs`       | inline (8-violation baseline)                     | No NET-NEW per-domain DB handle cache. Bind through the `ProjectStore`/`GlobalStore` ports so `cleo health` can enumerate every handle (the E6 cutover, ADR-068). |
| 18 | Vitest memory safety (T12087)          | `scripts/lint-vitest-memory-safe.mjs`           | none (zero-tolerance)                             | **ZERO TOLERANCE.** Every `vitest.config.*` MUST spread `MEMORY_SAFE_TEST_DEFAULTS` (worker cap + heap cap). An unbounded fork pool froze this machine twice, and it only ever bites LOCALLY — CI runners have 2-4 cores, so the unsafe default passes there and takes down the developer instead. |
| 19 | CLI startup barrel imports (T12076)    | `scripts/lint-cli-startup-barrel-imports.mjs`   | inline (106-import ratchet)                       | Ratchet, not zero-tolerance: the count of static `@cleocode/core` barrel imports in the CLI may fall but never rise. Each one forces the full 1266-module core graph to load before any command runs (measured 2.54 s for the barrel vs 0.12 s for a deep module). **Repo-wide scope** — pairs with row 23, which is narrow and absolute over the entrypoint's reachable graph. Neither subsumes the other: a barrel import inside a lazily-loaded command belongs to THIS gate and is correctly invisible to row 23. |
| 20 | Arch-gate parity (T12122)              | `scripts/lint-arch-gate-parity.mjs`             | none (zero-tolerance)                             | **The gate on the gates.** The gate list bundled into `cleo check arch` and THIS table MUST name the same set of scripts. Measured 2026-09-12: the runner bundled 10 while this table documented 15, drifting in both directions — so every agent told to run `cleo check arch` before pushing got a green covering two-thirds of the documented gates. Joins on script PATH, never gate number (the two numbering schemes already collide: runner `gate-6` is row 16's gate, not row 6's). |
| 21 | Dual-scope unqualified reads (T12156) | `scripts/lint-dual-scope-unqualified-reads.mjs` | `scripts/.lint-dual-scope-unqualified-reads-baseline.json` | Tables resident in BOTH the project and global `cleo.db` MUST be schema-qualified in SQL. `openDualScopeDb` performs no ATTACH — the second schema comes from `ensureGlobalRegistryAttached()` in `store/nexus-sqlite.ts`, which binds the global file onto the PROJECT handle as `nexus_global`. Because `bindProjectDomain` shares ONE path-keyed native handle across every project-scope domain, that attach is process-global and retroactive: a domain bound before anything touched nexus has its own handle gain a second schema (measured — same native object, `["main"]` → `["main","nexus_global"]`). A bare `FROM <table>` then resolves by SQLite search order and returns a confident number that never says which file it read (project `__drizzle_migrations` = 108, global = 14; the bare query answers 108). Deliberately NARROW: nexus registry tables resolve by bare name through that fall-through ON PURPOSE, so "qualify everything" would break them. The ambiguous set is derived from `schema/cleo-shared/` plus an explicit infra list (`__drizzle_migrations`, `_writer_leases`, `_writer_queue`, `brain_schema_meta` — the last is raw-SQL and undeclarable from source). |
| 22 | AI SDK surface inventory (T12169) | `scripts/lint-ai-sdk-surface.mjs` | `scripts/.lint-ai-sdk-surface-baseline.json` | Every module that reaches the AI SDK at RUNTIME is recorded; a net-new entrant fails. `ai@6`'s `logWarnings` emits its one-time banner with `console.info` — **stdout** — which lands after the LAFS envelope and breaks ADR-086. Deliberately an INVENTORY, not a per-module rule: the stdout guard is installed once at the CLI's envelope funnel, so requiring every module to install it would contradict that design. What actually failed was a module reaching the SDK with nobody asking the coverage question — `memory/llm-backend-resolver.ts` builds its client by `await import('@ai-sdk/openai-compatible')`, imports `ai` only as `import type` (erased at runtime), and never loads the LLM chokepoint the guard was first installed at. A TYPE-ONLY import is not a reach and does not trip the gate — treating it as one is what made that module look covered. |
| 23 | CLI startup barrel — entrypoint graph (T12138) | `scripts/lint-cli-startup-barrel-entrypoint.mjs` | none (zero-tolerance) | **ZERO TOLERANCE, and deliberately narrower than row 19.** No module reachable from `packages/cleo/src/cli/index.ts`'s STATIC import graph may statically import a CORE barrel. `cli/index.ts` runs on EVERY invocation — `cleo --version` and `--help` included — so anything it reaches transitively is loaded before a single argument is parsed. Measured 2026-09-12 against the core the installed CLI actually resolves: `cleo --version` 1.31 s, bare Node boot 0.01 s, importing `@cleocode/core/internal` alone 1.14 s — so **~87% of CLI startup was one barrel import**, reached for ONE function (`buildCommandGroups`). The narrow module costs 0.09 s. Dynamic `await import(...)` at point of use is always fine; that is the prescribed pattern. Row 19 is the REPO-WIDE ratchet over the same invariant and the two are complementary, not redundant: a barrel import in a lazily-loaded command costs nothing until that command runs (row 19's business), while one reachable from the entrypoint is paid unconditionally (this row's), which is why a ratchet is too weak here and zero is the only defensible number. `index.ts` already carried a comment saying this must not happen — a comment is not a gate, the import was added anyway in a different file, and nothing noticed. Per-line opt-out `// startup-barrel-allowed: <reason>`. |

**Common modes (all gates):** `--strict` zero-tolerance · `--baseline` regenerate · default fail-on-net-add.

**Per-line opt-outs (trailing comment):** `// define-command-ssot-allowed`, `// db-open-allowed: <reason>`, `// fan-out-ok: <reason>`, `// ssot-exempt-ok: <reason>`, `// cli-boundary-ok: <reason>`, `// cli-boundary-file-ok: <reason>` (first 20 lines), `// llm-resolve-allowed: <reason>`.

**Exempt by convention (CLI package boundary, row 6):** functions named `*Command` / `make*Command` (citty factory helpers).

### DB Open Guard — canonical allowlist (row 3)

Reduced to **3 path entries** after the E6 store-rewrite cascade (T11521–T11528) routed every per-domain accessor through `openDualScopeDb` (T11529 · E6-L9). The gate now runs in `--strict` mode (zero tolerance).

| Location                                              | Reason                                          |
|-------------------------------------------------------|-------------------------------------------------|
| `packages/core/src/store/**`                          | The chokepoint (incl. `dual-scope-db.ts`)       |
| `packages/core/src/migration/**`                      | Schema bootstrapping (pre-chokepoint)           |
| `packages/studio/src/lib/server/db/connections.ts`    | Per-project ProjectContext opens (pre-port)     |

Test files (`__tests__/`, `.test.ts`, `.spec.ts`) may open raw for seeding and are matched by a regex, not the canonical allowlist. Every other legitimate raw open (external claude-mem migration source, hot-path conduit, per-project nexus graph DBs) now carries an inline `// db-open-allowed: <reason>` marker at the call site instead of a directory-wide entry.

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

**Convention:** when you edit a path declared in the coverage map (`packages/skills/internal/skill-coverage.yml`), update the corresponding skill in the same PR — or acknowledge via commit trailer `Skill-Drift-Acknowledged: <reason>`.

> ⚠️ **NOT ENFORCED — this is a convention, not a gate (T12124 · GH #1256).**
> There is no `Skill Drift Check` job and no `E_SKILL_DRIFT_UNACKNOWLEDGED`
> error: no script reads the coverage map, no workflow runs the check, and the
> map itself holds exactly one entry (`cleo-validator`, tier 2) pointing at
> paths its own comment says do not exist. The tier-0 skills listed below have
> **no coverage entries at all**, so the "no trailer override" rule below
> protects nothing today.
>
> This warning is here because the previous wording asserted a CI gate that
> does not exist, and a false assurance is worse than none — it removes the
> vigilance that would otherwise substitute for the missing mechanism. The risk
> is not theoretical: `CLEO-INJECTION.md`, a tier-0 artifact injected verbatim
> into every spawned agent, had drifted into describing bare `cleo show {id}`
> as the "full task record" (it withholds `description`), which is the sentence
> that produced the GH #1243 data-loss incident. **Until the gate exists, treat
> skill updates as a manual responsibility on every PR.**
>
> Building it is tracked in T12124 · GH #1256.

**Tier-0 skills — trailer override is not permitted BY CONVENTION (unenforced, see above):**

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

> **One deliberate exception, stated so nobody later "discovers" it as a vulnerability.** Branch
> protection runs with `enforce_admins: false` — the setting the snippet further down this section
> sets explicitly — so a repository admin CAN merge without the required `CI` check. That is the
> owner's intended escape hatch, not a gap. Everything else is closed: `allow_force_pushes: false`,
> `allow_deletions: false`, `required_status_checks.strict: true`. The invariant is therefore "no
> direct pushes **for non-admins**", and an agent should not treat admin bypass as evidence the
> pipeline is broken. Verified 2026-09-12 (T12152 · the AGENTS.md enforcement audit).

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
- **Fresh clones:** `cleo init` recreates config + project-info; DBs are created empty on first access.

**NEVER** `git add` any of these four files. Root and nested `.gitignore` block this; manual overrides re-open the T5158 data-loss vector.

### Memory guard — what CLEO bounds, and what it CANNOT (T12096 · T12097)

`cleo verify --evidence "tool:test"` spawns the project's own test command, so
CLEO injects a ceiling there (`resources/heavy-tool-env.ts`: heap cap, worker
cap, `pnpm -r` fan-out cap). That covers evidence runs and **nothing else**.

A test an agent starts itself — `pnpm test`, `npx vitest run`, `cargo test` —
never enters a CLEO process, so no CLEO-side bound can apply. Measured
2026-08-10: that path drove `app.slice` to 48.1 GiB against a `MemoryHigh` of
exactly 48 GiB; the kernel reclaimed hard, thrashed 7.7 GiB of zram, and the
desktop locked up. **There was no OOM kill** — a throttle-and-thrash freeze logs
nothing, which is why repeated OOM hunts found nothing. Diagnose with
`journalctl -b -1 -k | grep -i oom-kill` FIRST; an empty result means the
mechanism is throttling, not OOM.

Environment variables are NOT a fix for this: they bind only shells started
after they are set. The five heaviest tabs that day all predated the profile
edit. A cgroup limit on the enclosing slice is the only layer that binds
processes already running — proven by applying `MemoryHigh` to a live scope 12
minutes after its creation and observing it take effect immediately.

```bash
cleo doctor memory-guard          # audit (read-only)
cleo doctor memory-guard --fix    # apply RAM-derived limits to app.slice
```

Recommendations derive from total RAM (`MemoryHigh` 72 %, `MemoryMax` 90 %), so a
16 GiB laptop is not handed a 45 GiB ceiling. Off-Linux the audit reports
`supported: false` rather than guessing.

### The store is `cleo.db`, and three things say otherwise (T12095)

Post-E6 (ADR-068) the project store is **`.cleo/cleo.db`** with task rows in
PREFIXED tables (`tasks_tasks`, `tasks_sessions`, …). Three leftovers make a
healthy project look corrupt, and an agent that reasons about `.db` file sizes
instead of asking the CLI will believe all three:

| Artefact | Reality |
|----------|---------|
| `.cleo/tasks.db` — small, months old | The **pre-migration** store. The migration does not delete it, so it survives under the name every doc used to mean "live". |
| `.cleo/backups/sqlite/tasks-<ts>.db` — ~100× larger | Snapshots **of `cleo.db`**. `openTasksDbForSnapshot` routes through the dual-scope chokepoint; the `tasks-` prefix is a legacy label kept for the rotation regex. `restore backup --file tasks.db` is therefore correct *and* misleading. |
| A bare `tasks` table inside `cleo.db`, 0 rows | An empty relic beside the populated `tasks_tasks`. A direct SQL probe finds the decoy. |

So a 408 KB `tasks.db` beside 58 MB `tasks-*.db` snapshots is the NORMAL layout
of a migrated project — measured 2026-08-09 in a project with 1,123 intact tasks,
where an agent spent a session theorising truncation, rotation, and then that the
real store might be `llmtxt.db`.

`cleo doctor superseded-store` answers it in one call: it names each superseded
file and proves which store holds the data by counting rows in both. Read-only.
