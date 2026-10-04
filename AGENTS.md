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
pnpm biome check --write .                             # format + lint
cleo run --wait --class full-build -- pnpm run build   # build
cleo done <id> --plan                                  # tests: ZERO new failures
git diff --stat HEAD                                   # verify scope
```

Tests: record what `cleo done <id> --plan` names (`ci:<pr>`, `tool:test-affected` or a targeted `test-run:<json>`). While iterating, run single test files; never run a whole suite by hand.

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
| 16 | Bare `getActiveSession()` (T11640) | `scripts/lint-no-bare-get-active-session.mjs` | `scripts/.lint-no-bare-get-active-session-baseline.json` (0-callsite baseline, T12500) | No net-new bare `getActiveSession()` or inline newest-active selection — mutations use `resolveBoundSession`/`requireBoundSession`, reads `resolveSessionForRead` (opt-out `// get-active-session-allowed: <reason>`). |
| 17 | Per-domain DB singleton (T12041) | `scripts/lint-no-domain-db-singleton.mjs` | inline (8-violation baseline) | No net-new per-domain DB handle cache — bind through the `ProjectStore`/`GlobalStore` ports. |
| 18 | Vitest memory safety (T12087) | `scripts/lint-vitest-memory-safe.mjs` | none (zero-tolerance) | Every `vitest.config.*` MUST spread `MEMORY_SAFE_TEST_DEFAULTS`. |
| 19 | CLI startup barrel imports (T12076) | `scripts/lint-cli-startup-barrel-imports.mjs` | `scripts/.lint-cli-startup-barrel-baseline.json` (99 imports) | Repo-wide ratchet: static `@cleocode/core` barrel imports in the CLI may fall, never rise. |
| 20 | Arch-gate parity (T12122) | `scripts/lint-arch-gate-parity.mjs` | none (zero-tolerance) | The gates bundled in `cleo check arch` and THIS table name the same scripts, joined on script path, and every bundled gate is run by a `node scripts/<gate>.mjs` step in `.github/workflows/` (T12658). |
| 21 | Dual-scope unqualified reads (T12156) | `scripts/lint-dual-scope-unqualified-reads.mjs` | `scripts/.lint-dual-scope-unqualified-reads-baseline.json` | Tables resident in BOTH project and global `cleo.db` MUST be schema-qualified in SQL. |
| 22 | AI SDK surface inventory (T12169) | `scripts/lint-ai-sdk-surface.mjs` | `scripts/.lint-ai-sdk-surface-baseline.json` | No net-new module reaching the AI SDK at runtime (type-only imports do not count). |
| 23 | Agent-prompt command existence (T12308) | `scripts/lint-agent-prompt-commands.mjs` | none (zero-tolerance) | Every `cleo` command the spawn prompt emits resolves against the manifest. |
| 24 | No committed native binaries (T12382) | `scripts/lint-no-committed-native-binaries.mjs` | inline (`BASELINE`, 1 non-cant entry) | No tracked `*.node`/`*.wasm`; a cant binary can never be baselined. |
| 25 | CLI startup barrel — entrypoint graph (T12455 · T12138) | `scripts/lint-cli-startup-barrel-entrypoint.mjs` | none (zero-tolerance) | Nothing in `packages/cleo/src/cli/index.ts`'s static import graph statically imports a core barrel — use dynamic `await import()` (opt-out `// startup-barrel-allowed: <reason>`). |
| 26 | No raw negated-flag reads (T12528) | `scripts/lint-no-negated-flag-reads.mjs` | inline (`BASELINE`, 1 entry: `orchestrate.ts`, owned by PR #1577) | Read `--no-<flag>` only via `negatedFlag(args, '<name>')`, never `args['no-<flag>']`/`args.noFoo` under `packages/cleo/src/`. |
| 27 | HITL ask-tool rule delivery (T12483) | `scripts/lint-hitl-rule-delivery.mjs` | none (zero-tolerance) | The ask-tool owner-decision rule stays present on every agent surface: CLEO-INJECTION.md, `ct-cleo`, `ct-orchestrator`, and the spawn-prompt Return Format Contract. |
| 28 | Raw table writers — Gate A ratchet (T12332, T12343, T12787) | `scripts/lint-no-raw-table-writes.mjs` | `scripts/.lint-no-raw-table-writes-baseline.json` (145 sync-class sites / 53 files); inline `EXEMPT` (85 non-sync sites, per (file, table) with a reason) and `STAGED_SNAPSHOT` (3 sites, per (file, table, function)) | No net-new raw `INSERT`/`UPDATE`/`DELETE`/`REPLACE` on a classified `cleo.db` table outside the chokepoint (`openDualScopeDb` + the canonical accessors). A write to a syncing table needs its accessor, never an exemption; the one exception is a staged-snapshot site, marked `// gate-28: staged-snapshot <function>`. Non-sync (`local-only`, `derived`, `frozen-legacy`) writers are exempt per (file, table), never per file or class; an entry expires when its table becomes portable. `--strict` fails on any remaining baselined (sync-class) site; `EXEMPT` and marked `STAGED_SNAPSHOT` sites never count toward it, but a broken exemption or marker fails every mode. `--drizzle-report` lists Drizzle builder writes to syncing tables (report only). Zero tolerance, everywhere (T12787): no `INSERT OR REPLACE`/`REPLACE INTO` — REPLACE deletes the old row, so FK `ON DELETE CASCADE`/`SET NULL` hits its children; use `INSERT … ON CONFLICT … DO UPDATE`. Opt-out `// replace-allowed: <reason>` (refused for an FK-action parent or a dynamic target). |
| 29 | Skills manifest SSoT (T12648 · T12653 · D11157) | `scripts/lint-skills-manifest.mjs` | none (zero-tolerance) | SKILL.md frontmatter is the skills metadata SSoT: `name` = directory, description ≤ 1024 chars, no duplicate keys, no top-level `tier`/`core`/`category`, and `metadata.version`/`tier` (core\|on-demand\|internal)/`install` (harness\|internal). `packages/skills/skills/manifest.json` MUST equal `node scripts/skills/generate-manifest.mjs` output — never hand-edit it — and is the ONLY skills index (a `packages/skills/skills.json` fails). |
| 30 | Emitted-skill installability (T12648 · T12653 · D11157) | `scripts/lint-emitted-skills.mjs` | `scripts/.lint-emitted-skills-baseline.json` (empty) | Every skill named by `stage-guidance.ts`, `spawn-prompt.ts` (`loadSkillExcerpt`/`resolveSkillPath`), `SKILL_NAME_MAP` in `skills/types.ts`, `skill:` in `skills/dispatch.ts`, or a `.cant` `skillRef:` exists, is `metadata.install: harness` and is installed — `initCoreSkills` installs exactly the manifest's `install: harness` entries, and a tripwire fails the gate if that selection changes. Stale baseline entries fail. |
| 31 | Skill command existence (T12649 · D11157) | `scripts/lint-skill-commands.mjs` | `scripts/.lint-skill-commands-baseline.json` (empty; non-core only) | Gate 14's rules applied to every `*.md` under `packages/skills/skills/`: each `cleo <verb> [<sub>]` exists, every flag is declared, partially-flagged invocations carry required flags, `--field` pointers resolve. Core-tier skills are zero-tolerance and can never be baselined; other skills ratchet (stale entries fail). A deliberately wrong example opts out with a trailing `# cleo-cmd: negative-example`. Frontmatter is not scanned. |
| 32 | Skill coverage (T12124 · gh#1256 · D11157) | `scripts/lint-skill-coverage.mjs` | none (zero-tolerance) | Every core and LOOM-stage skill declares `metadata.covers`, and every covers glob matches a tracked file. PR mode (`--base <ref>`, run in CI): a changed covered path requires a change to that skill (on-demand skills accept a `Skill-Drift-Reviewed: <skill>: <reason>` trailer; core skills never do), and a changed skill requires a `metadata.version` bump. |
| 33 | ct-cleo thin pointer (T9148 · T12124) | `scripts/check-ct-cleo-thin.mjs` | `scripts/.check-ct-cleo-thin-baseline.json` | ct-cleo SKILL.md may not grow: non-blank lines must not rise above the baseline, no new `## ` section outside Quick Reference / Skill-Specific Extensions, the thin-pointer marker stays. Target 50 lines (`--strict`). |
| 34 | No bare `require()` in ESM (T12704) | `scripts/lint-no-esm-bare-require.mjs` | inline (`BASELINE`, 1 entry: `worktree-include.ts`, owned by PR #1679) | No bare `require(` in `packages/<pkg>/src/` of a `"type": "module"` package — it throws under Node while vitest supplies one. Use `import`/`await import()` or bind `const require = createRequire(import.meta.url)`. |
| 35 | Model call sites registered (T12663 · D11158) | `scripts/lint-model-call-sites.mjs` | `scripts/.lint-model-call-sites-baseline.json` (per rule, per file) | Every `decide()`/`askSiteDecision` site id and every file calling an LLM entry point is a row of `packages/core/src/decide/sites/registry.ts` with a generative/agent rung; a System One site runs `on` only with go-live evidence (debug and benchmark verbs exempt); chokepoint bypasses are baselined per file and may only fall. A System One site's go-live `evidenceDoc` must resolve to a tracked `docs/**/<slug>.md` mirror. Opt-out `// model-site-allowed: <reason>` (reason required) trailing the line or alone on the line above. |
| 36 | Change-journal schema rules (T12819 · T12827) | `scripts/lint-sync-schema.mjs` | none (zero-tolerance) | Nothing drops `cleo_trigger_suspend`; only `store/sync/machinery.ts` drops `_sync_*` tables; no migration SQL mentions `_sync_cap_`. Forward-only (migration folders from `20260930170000_t12819-trigger-suspend-clause` on): every owned guard/side-effect `CREATE TRIGGER` carries its `WHEN NOT EXISTS (… cleo_trigger_suspend …)` clause, migration DML is deterministic (no `datetime('now')`/`random()`), and a table-rebuild file never deletes from or re-keys an FK parent. A migration file on the base ref (`--base`, `origin/$GITHUB_BASE_REF`, else `origin/main`) is never edited or deleted (#1719). |
| 37 | Row-identity coverage (T12897 · epic T12323) | `scripts/lint-row-identity-coverage.mjs` | inline (`ROW_IDENTITY_EXEMPT_PINNED`: 96 project / 46 global, plus `ROW_IDENTITY_EXEMPT_NAMES_SHA256` of the sorted names; may only fall) | Every syncing `cleo.db` table (Gate A portable class, not `frozen-legacy`) is declared in `ROW_IDENTITY` or listed in `ROW_IDENTITY_EXEMPT` with a category, reason and `T####` task (`packages/core/src/store/row-identity-registry.ts`). Fails on a table in neither, on a stale exemption (table gone, no longer syncing, or declared), on a portable pattern rule, and when the exemption count or the names digest moves off its pin (a swap fails). PR mode `--base <ref>` (CI passes the PR base): fails when the pin rose or the exempt name set grew against the base. `--verify-tasks` (local only; CI has no task store) checks each exemption task exists and is open via the released CLI. Only `--check`, `--strict`, `--base`, `--verify-tasks` are accepted. Fresh-store twin: `store/__tests__/row-identity-gate.test.ts`. |
| 38 | Sync write-invariant registry (T12881 · spec t12859 §3.6.7) | `scripts/lint-sync-write-invariants.mjs` | `scripts/.lint-sync-write-invariants-baseline.json` (2808 untagged sites / 1095 `file :: code` keys; shrink-only; burn-down T12946) | Every rejection site on a synced write path (a module writing a portable table, or reachable from a dispatch domain's mutate handlers; tracked `.ts` under `packages/{core,cleo,playbooks,studio}/src`; TS compiler API) carries `// @sync-invariant <id>` naming an entry of `packages/contracts/src/invariants/sync-write-invariants.ts` whose tables match the site, or `none:input-shape <reason>` / `none:local-only <reason>`. Sites include `throw new`, factory `throw f()` and `return new XError` in error factories, `engineError`/`cliError`/`emitFailure`, `success:false` envelopes and code literals; silent cascades and SQL counters carry `@sync-invariant` or `@sync-side-effect`. PR / merge-queue mode `--base <ref>` (CI: the merge commit's first parent): an added or raised baseline key fails unless audited (`"audited": {"<file> :: <code>": {"reason": "T#### …", "count": n}}` approving the new count, with the count risen against the base's; an inherited, re-worded or legacy string audit justifies nothing new) or net-zero for its code over the changed files (moves, renames and newly reachable modules; credit only for sites on the base's write path, from a scan of the base tree, capped per `file :: code` at the base baseline's count); staleness is judged on changed files only. Regenerate with `--update-baseline --base origin/main` (this gate rejects `--baseline`), which applies the same rule (`--seed` overrides). Registry closure: tables classified, trigger-covered names created by a migration, post-apply checks exported with a footprint, no dead gate; `--verify-tasks` (local) checks each `pending` task, the burn-down task and every task an `audited` reason names are open. Fresh-store twin: `store/__tests__/sync-write-invariants-gate.test.ts`. |
| 39 | Built CLI startup graph (T13126) | `scripts/check-cli-startup-graph.mjs` | inline (`PROBES` budgets: `--version` 80 / `--help` 85 / `show`, `find`, `current` 500 / `list --field <miss>` 505 / `list --human` 565 / `list --describe` 465 / `session status` 600 / `briefing` 785 / `next` 735 / `add` 900 / `dash` 700 modules; may only fall) | Measures the BUILT CLI, not its source (gates 19/25 read source and stayed green while the unsplit bundle hoisted all of CORE into every call): the static graph of `packages/cleo/dist/cli/index.js` imports no `@cleocode/core`, `@cleocode/core/internal` or `@cleocode/contracts` barrel, and the probes run in a throwaway sandbox under module-count budgets and RSS ceilings (`--version`/`--help` never load a barrel, drizzle, `node:sqlite` or a model SDK, and stay under 120 MB; the store-opening probes never load the CORE barrel or a model SDK). The `require(esm)` paths are probed too, since top-level await in their graph throws `ERR_REQUIRE_ASYNC_MODULE`: `list --human` (CORE's human renderers), a missed `--field` pointer (the output-contract table) and `list --describe` (the operation describer) must load their module and exit as expected, and store-opening probes load drizzle's ES module driver, never its `.cjs` build (the driver's fallback). Needs a current `pnpm run build`; a missing or stale build fails. Lower a budget in the PR that lowers its count. |
| 40 | Contracts barrel value imports (T13126) | `scripts/lint-no-contracts-barrel-value-imports.mjs` | inline (`BASELINE`: 6 skill-covered CLI/core files; may only shrink, stale entries fail) | Runtime source of `packages/{core,cleo,runtime,caamp,nexus,git-shim,worktree}/src` imports every VALUE from `@cleocode/contracts` through the module that declares it (`@cleocode/contracts/<path>.js`), never the bare barrel, which evaluates every contracts zod schema (~40 MB of heap). Type-only imports, `export type`, and core's public barrels (`index.ts`, `internal.ts`, `contracts.ts`) are allowed; tests are exempt. Also flags dynamic `import('@cleocode/contracts')`. |

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
- **Repair (manual, owner-invoked — NOT a gate; never run it in a loop over scripts):** `scripts/migrate-rogue-worktrees.mjs` moves rogue worktrees to the canonical path. It is dry-run by default: run `--dry-run` first, then `--apply`. It refuses unknown flags (including `--check`) and never unlocks or moves a locked or in-use worktree (T12725).

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

**Enforced (gate 32, `scripts/lint-skill-coverage.mjs`, T12124):** each skill declares the code it documents in `metadata.covers` (repo globs). A PR that changes a covered path must change that skill's directory, and a changed skill must bump `metadata.version`. CI runs the PR check against the PR base; `cleo check arch` checks that every core and LOOM-stage skill declares covers and that every glob matches a tracked file.

**Core skills (`metadata.tier: core`) — no override:** `ct-cleo` · `ct-orchestrator` · `ct-lead` · `ct-task-executor` · `ct-dev-workflow` · `ct-documentor` (D11157). A covered change must update the skill.

**On-demand skills** (the LOOM-stage skills in `packages/core/src/validation/protocols/`, ct-council, ct-codebase-mapper) accept a commit trailer instead: `Skill-Drift-Reviewed: <skill>: <why no update is needed>`.

`CLEO-INJECTION.md` / `CLEO-REFERENCE.md` changes are covered by `ct-cleo`. ct-cleo's own size is ratcheted by gate 33 (`scripts/check-ct-cleo-thin.mjs`, baseline `scripts/.check-ct-cleo-thin-baseline.json`).

Every `SKILL.md` ships with metadata (enforced by gate 29):

```yaml
metadata:
  version: 2.0.0           # bump on every material change
  tier: core               # core | on-demand | internal (D11157)
  install: harness         # harness | internal
  covers:                  # code this skill documents (gate 32)
    - packages/cleo/src/cli/commands/example.ts
  lastReviewed: 2026-05-21 # ISO date
  stability: stable        # experimental | stable | deprecated
```

This frontmatter is the metadata SSoT: gate 29 fails when `packages/skills/skills/manifest.json` differs from `node scripts/skills/generate-manifest.mjs` output (T12648).

## Release & Branching (ADR-065 · SPEC-T9345 · ADR-087)

PR-gated pipeline. **NO direct pushes to `main`.** All PRs target `main` through GitHub Merge Queue.

> Deliberate exception (T12152): branch protection sets `enforce_admins: false`, so a repo admin CAN merge without `CI` — the owner's intended escape hatch, not a vulnerability or evidence the pipeline is broken. Force-pushes and deletions stay blocked; `required_status_checks.strict: false` (owner decision 2026-09-29): a PR merges once its own `CI` is green without re-running after every other merge, and main-push CI catches any break from combining PRs.

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
  -f required_status_checks[strict]=false \
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
- **Fresh clones:** `cleo init` recreates config + project-info; DBs are created empty on first access. The clone keeps the original `projectId` because `init` reads it from the tracked `.cleo/project.json` (legacy: `.cleo/project-id`).

**Exception: the identity files ARE tracked** (ADR-094 · T12325, ADR-096 · T12716, amending ADR-013 §9). `.cleo/project.json` holds `{schemaVersion, id, name}`: the **id is write-once** (created once with `O_EXCL`, never rewritten), the name changes only through `cleo project rename`. `.cleo/project-id` stays tracked as the legacy id-only mirror. The §9 hazard needed a second writer on state that changes, and neither id has one. **Commit both; never edit or regenerate an id.** A legacy project (only `.cleo/project-id`) migrates only through `cleo doctor project-identity --resolve --dry-run`, then `--resolve` — never on open, init or upgrade.
- A conflict with the `project-info.json` cache is reported, and the TRACKED id wins everywhere (ADR-096). Init and upgrade leave the cache alone; only `--resolve` re-keys it.
- A missing file is re-linked from `project-info.json` or the global registry. A new id is minted only when nothing can be re-linked, or explicitly with `cleo init --new-identity`.
- A fork inherits the id; see ADR-094 for the fork caveat.
- Check it with `cleo doctor project-identity`. It reports legacy, missing, conflicting, invalid, uncommitted or gitignored ids and registry-name drift with the exact remedy. `--resolve --dry-run` shows the plan; `--resolve` applies it. A conflict is re-keyed to the tracked id through the alias table (when both ids are registered, the cached-id row is folded into the tracked row with a `merge-identity` audit receipt), credentials sealed under the old id are re-wrapped, and the old id still resolves (T12353 · T12716).

**NEVER** `git add` any of these four files. Root and nested `.gitignore` block this; manual overrides re-open the T5158 data-loss vector.

### Memory guard — what CLEO bounds, and what it CANNOT (T12096 · T12097)

CLEO caps heap, workers and `pnpm -r` fan-out ONLY for evidence runs (`cleo verify --evidence "tool:test"`; `tool:typecheck`/`tool:lint` get the heap cap and RAM-derived slots, T13123) and `cleo run`, via `tasks/heavy-tool-env.ts`: one RAM-derived budget, which an inherited `NODE_OPTIONS` heap or worker count can tighten but never raise (only `CLEO_HEAVY_HEAP_MB` / `CLEO_HEAVY_WORKERS` ask for more, T13122). A test an agent starts itself (`pnpm test`, `npx vitest run`, `cargo test`) gets no CLEO bound, and environment variables bind only shells started after they are set — a cgroup limit on the enclosing slice is the only layer that binds running processes. A freeze with no OOM kill is throttle-and-thrash: diagnose with `journalctl -b -1 -k | grep -i oom-kill` FIRST (empty = throttling, not OOM).

```bash
cleo doctor memory-guard          # audit (read-only)
cleo doctor memory-guard --fix    # apply RAM-derived limits to app.slice
```

Limits derive from total RAM (`MemoryHigh` 72 %, `MemoryMax` 90 %); off-Linux the audit reports `supported: false`.

### The store is `cleo.db` (T12095)

The live store is `.cleo/cleo.db` (prefixed tables, `tasks_tasks`); small `.cleo/tasks.db`, large `.cleo/backups/sqlite/tasks-<ts>.db` snapshots, and an empty bare `tasks` table are normal decoys (see CLEO-INJECTION.md "Where the data lives"). `cleo doctor superseded-store` proves which store holds the data by row counts. Read-only.
