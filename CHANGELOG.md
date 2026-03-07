# Changelog

## [v2026.3.19] (2026-03-07)

Fix release pipeline: wire version bump as step 0 so VERSION + package.json + CHANGELOG.md land in one commit before the tag.

### Changes
- **Wire --bump-version into releaseShip() pipeline and fix release notes content**: bumpVersionFromConfig() exists but is never called by releaseShip(). VERSION and package.json are bumped manually after the tag, backwards and erro... (T5617)
---
## [v2026.3.18] (2026-03-07)

### Features
- **Create normalizeTaskId() SSoT utility with validation and tests**: Create SSoT utility function `normalizeTaskId()` in src/core/tasks/task-id-utils.ts that accepts any task ID format and returns canonical "T1234". ... (T5587)
- **Implement normalization across all task operations**: Implement normalizeTaskId() across all identified operations. Update task lookup functions to normalize input before querying database. Ensure epic... (T5589)
- **Implement automatic PR creation for protected branches**: Implement automatic PR creation when branch protection blocks direct push. Use GitHub CLI (gh) if available, or provide clear manual instructions. ... (T5591)
- **Implement multi-channel release support (@latest/@beta/@alpha)**: Add release channel support to pipeline: @latest for main branch, @beta for develop branch, @alpha for feature branches. Update release gates to va... (T5592)

### Bug Fixes
- **MCP response payload optimization — ranked blockedTasks, compact admin help, domain pagination**: Reduce MCP response sizes and improve data quality across domains: - admin help: compact domain-grouped format by default (~85% token reduction), v... (T5584)

### Documentation
- **Add agent guidance and workflow visualization to release command**: Enhance release.ship output with clear agent guidance and next steps. Add --guided flag for step-by-step mode. Show progress through workflow stage... (T5593)
---
## [2026.3.17] - 2026-03-07

### Added
- **GitFlow branch detection and PR automation (T5586)** — Channel resolution from branch name (`@latest`/`@beta`/`@alpha`), automatic PR creation via `gh` CLI when branch protection is detected, `--guided` and `--channel` flags on `release ship`, `release.channel.show` query operation.

### Fixed
- **Layer 1 gate validator domain-aware status validation (T5598, closes #55)** — `validateLayer1Schema` was checking all `status` params against `TASK_STATUSES` regardless of domain. Operations like `pipeline.stage.record` with valid lifecycle statuses (`in_progress`, `not_started`, etc.) were incorrectly rejected. Validator is now domain-aware for pipeline, admin, session, and manifest operations. Reported by @DanielViholm.
- **Admin stats and dashboard counts include archived/cancelled tasks (T5597)** — `getDashboard` and `getProjectStats` now query the database directly for accurate counts. Archived tasks, cancelled tasks, and `grandTotal` are exposed in the summary; cancelled tasks excluded from actionable distributions.

### Security
- **Normalize task ID input across all MCP and CLI operations (T5585)** — `normalizeTaskId()` added to `id-generator.ts`; accepts `1234`, `t1234`, or `T1234` and returns canonical `T1234`. Sanitizer coverage extended to `parentId`, `newParentId`, `relatedId`, `targetId`, `addDepends`, and `removeDepends` fields.

---

## [2026.3.16] - 2026-03-07

### Performance
- **Batch saveArchive() transaction + bulk dependency updates (T5584)** — Wrapped saveArchive() in `BEGIN IMMEDIATE/COMMIT` SQLite transaction; replaced N×M individual dependency updates with single batch DELETE + INSERT via `batchUpdateDependencies()`.

### Fixed
- **Lifecycle transition ID uniqueness (T5584)** — Appended random nonce to `lifecycle_transitions.id`; rapid stage advances within the same millisecond no longer cause UNIQUE constraint failures. Root cause of CI failures across all platforms.
- **Hook error loop hardening (T5584)** — Blanket `try-catch` around `observeBrain()` in `error-hooks.ts`; all errors silently suppressed to prevent re-entrant hook firing.
- **Changelog double-write bug (T5584)** — `releaseShip` was calling `writeChangelogSection` twice with the full changelog string (including header) as body; removed the redundant call.

### Changed
- **Iterative findDescendants — stack safety (T5584)** — Replaced recursive closure in task deletion with iterative queue-based BFS; eliminates call-stack overflow risk for deep task hierarchies.

---

## [2026.3.15] - 2026-03-06

This release consolidates the CLEO release engine, migrates pipeline and release manifests to SQLite, adds contributor project detection, and hardens MCP payloads and CI.

### Added
- **Release engine consolidation (T5582)** — `release.ship` composite MCP operation + CI CHANGELOG gate; the release pipeline is now a first-class CLEO operation
- **Changelog writer (T5579)** — Section-aware changelog merge with custom-log block support
- **Release manifests → SQLite (T5580)** — `releases.json` migrated to `release_manifests` SQLite table with provenance wiring
- **Pipeline manifest → SQLite (T5581)** — JSONL pipeline manifest migrated to `pipeline_manifest` SQLite table for transactional writes
- **Release pipeline E2E tests (T5583)** — Full end-to-end coverage of the release pipeline operations
- **Contributor project detection (T5576, ADR-029)** — Auto-detects CLEO source repo, routes to `cleo-dev` MCP channel; `ensureContributorMcp` writes project-level `.mcp.json`
- **Project context detection (T5363)** — `admin.detect` operation; validation and hardening of project context scaffolding
- **CI/CD consolidation (T5508)** — Release workflow consolidated to single job; ADR-016 updated with OIDC trusted publisher docs

### Changed
- **Legacy release cleanup (T5578)** — Deleted legacy release index + provenance; all release ops now require DataAccessor
- **Startup scaffolding refactor (T4783)** — Health-check system unified; startup flow split between global (postinstall) and project (`cleo init`)
- **CAAMP 1.7.0** — env-paths upgraded to OS-aware platform paths
- **MCP payload optimization (T5584)** — Reduced response sizes, ranked `blockedTasks` by priority, fixed pipeline gateway classification

### Fixed
- **Audit logging (T4848)** — Zod runtime validation added to all audit log inserts
- **Symlink resolution in contributor detection (T5576)** — `detectEnvMode` now resolves symlinks before comparing paths
- **dryRun guard in release.ship (T5582)** — Guard moved before `writeChangelogSection` to prevent changelog writes in dry-run mode

---

## [2026.3.14] - 2026-03-06

This is a major stable release promoting the full `2026.3.13-beta` cycle to `@latest`. It covers 55 commits
across 13 feature themes: Warp/BRAIN evolution, Hook infrastructure, Sticky Notes domain, Zero-Legacy
compliance closure, Unified Audit Logging, CLI-to-Dispatch migration progress, Sharing→NEXUS restructure,
Memory domain clean break, MCP tool naming standardization, Storage hardening, hierarchy limit removal,
OpenCode spawn adapter + Tessera engine, and the Conduit protocol specification.

### Warp + BRAIN Progress Update (T5373)

The largest single-commit feature in this cycle:

- **Warp protocol chains** — Unyielding structural chains that hold Tapestries together; synthesis of composable workflow shape and LOOM quality gates (T5407)
- **BRAIN Phases 1-2** — Already shipped in prior releases (native `brain.db`, observation storage, 3-layer retrieval API, and FTS5-backed retrieval flow)
- **BRAIN Phase 3** — Scaffolding landed in this cycle (`sqlite-vec` extension loading and PageIndex graph tables), but semantic/vector intelligence remains gated
- **BRAIN Phases 4-5** — Planned and not shipped in this stable release

#### Universal Hook Infrastructure (T5237)

A full event-driven hook system wired throughout CLEO's lifecycle. Hooks are best-effort (failures are
logged, not propagated), priority-ordered, and dispatched in parallel via `Promise.allSettled`. All eight
hooks feed observations into BRAIN automatically.

| Hook Event | CLEO Internal Event | What It Captures | Brain Auto-Observe |
|------------|--------------------|-----------------|--------------------|
| `onSessionStart` | `session.start` | Session name, scope, and agent identity at session open | Yes — `discovery` type |
| `onSessionEnd` | `session.end` | Session duration and list of tasks completed | Yes — `change` type |
| `onToolStart` | `task.start` | Task ID and title when work begins on a task | Yes — `change` type |
| `onToolComplete` | `task.complete` | Task ID, title, and final status (`done`/`archived`/`cancelled`) | Yes — `change` type |
| `onFileChange` | `file.change` | File path, change type (`write`/`create`/`delete`), and size; 5-second dedup prevents noise from rapid successive writes | Yes — `change` type |
| `onError` | `system.error` | Error code, message, domain, operation, and gateway; infinite-loop guard prevents `onError → observeBrain → onError` cycles | Yes — `discovery` type |
| `onPromptSubmit` | `prompt.submit` | Gateway, domain, operation, and source agent when a prompt hits a gateway | Opt-in only (`CLEO_BRAIN_CAPTURE_MCP=true`) |
| `onResponseComplete` | `response.complete` | Gateway, domain, operation, success/failure, duration (ms), and error code | Opt-in only (`CLEO_BRAIN_CAPTURE_MCP=true`) |

**Infrastructure details:**
- `src/core/hooks/registry.ts` — Singleton `HookRegistry` with `register()`, `dispatch()`, `setConfig()`, `listHandlers()` APIs
- `src/core/hooks/types.ts` — Typed payload interfaces per event; `CLEO_TO_CAAMP_HOOK_MAP` maps internal events to CAAMP event names
- `src/core/hooks/provider-hooks.ts` — Provider capability discovery: `getHookCapableProviders(event)`, `getSharedHookEvents(providerIds[])`
- All five handler modules auto-register on import — no manual wiring required
- Per-event and global enable/disable via `hooks.setConfig()`
- `CLEO_BRAIN_CAPTURE_MCP=true` env var opts into MCP prompt/response capture (off by default — too noisy for normal operation)

### Sticky Notes Domain (T5267-T5275, T5261, T5363)

Complete sticky notes system shipped as a first-class MCP domain:

- **Storage migration** — `sticky_notes` moved from tasks.db schema to brain.db `brain_sticky_notes` (T5267)
- **Full MCP domain** — `sticky.add`, `sticky.find`, `sticky.show`, `sticky.pin`, `sticky.archive`, `sticky.list` (T5267-T5275)
- **Permanent deletion** — `sticky.archive.purge` operation for hard-delete of archived stickies (T5363)
- **Canon synthesis workflows** — Cross-session context capture and sticky-to-memory promotion (T5261)

### Sharing → NEXUS Restructure (T5276)

- All `sharing.*` operations fully restructured under `nexus.share.*`
- NEXUS analysis queries exposed: cross-project analytics, dependency graphs, activity summaries (T5348)
- Orchestrate handoff composite op added: `orchestrate.handoff` for clean agent-to-agent handoff (T5347)

### Zero-Legacy Compliance Closure (T5244)

Hard cutover away from all legacy interfaces — backward-compat shims fully removed:

- **Registry & Dispatch** — Removed 5 backward-compat alias ops: `admin.config.get`, `tasks.reopen`,
  `tools.issue.create.{bug,feature,help}` (T5245). Registry: 256 canonical operations (was 212 pre-refactor)
- **MCP Gateways** — Non-canonical domain names now return `E_INVALID_DOMAIN` (T5246).
  Removed legacy domain types: `sharing`, `validate`, `lifecycle`, `release`, `system`, `issues`, `skills`, `providers`
- **CLI** — Removed legacy CLI aliases: `restore --reopen/--unarchive/--uncancel`, `find --search`,
  `memory-brain recall --search` (T5249)
- **Parity Gate CI** — `tests/integration/parity-gate.test.ts` — 7 tests that enforce canonical domain/op counts
  as a hard CI gate (T5251)

### Unified Audit Logging (T5318, T5317)

- **Unified audit log architecture** — Single structured logger replaces scattered JSONL fallbacks (T5318)
- **Startup instrumentation** — Server startup events, project hash, and bootstrap state recorded on init (T5284)
- **JSONL fallbacks removed** — `todo-log.jsonl` / `tasks-log.jsonl` runtime paths decommissioned;
  runtime now uses SQLite audit log + structured logger exclusively (T5317)
- **Logs cleanup** — `logs.cleanup` wired to lifecycle prune operation (T5339)
- **Health checks** — `audit_log` table checks added to doctor --comprehensive (T5338)
- **MCP startup errors** — Startup errors now route through the structured logger (T5336)

### CLI-to-Dispatch Migration Progress (T5323)

- Dispatch migration progressed with targeted command coverage and test hardening
- `cancel` and `unlink` were wired through dispatch (previously missing)
- Verb standards were audited and aligned to `docs/specs/VERB-STANDARDS.md`
- Remaining migration scope is tracked in open T5323 child phases for next cycle

### Memory Domain Clean Break (T5241)

- `search` verb eliminated — `find` is canonical everywhere in memory domain
- All legacy `brain.*` operation aliases removed from registry
- `memory.*` naming finalized: `memory.find`, `memory.timeline`, `memory.fetch`, `memory.observe`
- Clean break from all pre-cutover operation names

### MCP Tool Naming Standardization (T5507)

- `cleo_query` / `cleo_mutate` renamed to `query` / `mutate` throughout all source, docs, tests, and configs
- Backward-compat normalization layer in `src/dispatch/adapters/mcp.ts` accepts both forms during transition
- All 10 canonical MCP domain names enforced at gateway level

### Storage & Migration Hardening

- **drizzle-brain in npm package** — `drizzle-brain/` migrations now correctly included in published package (T5319)
- **Legacy JSON task paths removed** — All `tasks.json` runtime read/write paths eliminated (T5284)
- **Legacy migration imports decommissioned** — CLI/core/system use `core/system/storage-preflight` (T5305)
- **Dead migration script removed** — `dev/archived/todo-migration.ts` deleted (T5303)
- **21 test files migrated** — All `tasks.json` fixture usage replaced with `tasks.db` helpers
- **Upgrade path decoupled** — Runtime migration path delinked from legacy preflight (T5305)

### Hierarchy: maxActiveSiblings Limit Removed (T5413)

- The default 32 sibling limit has been removed — no artificial cap on concurrent sibling tasks
- Projects requiring a limit can configure `maxActiveSiblings` explicitly in `.cleo/config.json`

### Build System

- **Centralized build config** — `src/config/build-config.ts` provides single source of truth for build metadata
- **Package issue templates** — GitHub issue templates added for bug reports and feature requests

### Bug Fixes

- Resolve stale test assertions and SQLite regression in inject-generate (T5298)
- Eliminate critical tasks.json legacy references across upgrade, doctor, and system commands (T5293-T5297)
- Stabilize hooks and SQLite fixtures in test suite (T5317)
- Migrate release engine tests from tasks.json to SQLite (T5251)
- Include drizzle-brain migrations in npm package (T5319)
- Stabilize CI test performance and parity gate timing (T5311)
- Wire logs cleanup to prune lifecycle correctly (T5339)
- Add audit_log health checks to comprehensive doctor (T5338)
- Pass projectHash correctly to logger initialization (T5335)
- Reconcile tasks.json checks in upgrade path (T5299)
- Remove marker debt and add active gate enforcement (T5320-T5322)
- Drop unused logOperation path arg (T4460)

### Documentation

- CLEO-OPERATION-CONSTITUTION.md: +7 verbs (check/verify/validate/timeline/convert/unlink/compute), +6 ops (T5250)
- VERB-STANDARDS.md: `convert` verb added, verb count enforced at 37 (T5250)
- Nexus ops table synced to current implementation (T5350)
- Tessera ops canonicalized in framework docs (T5346)
- ADR-019 amendment link corrected (T5340)
- Cleanup matrix added, dead script refs retired (T5317)
- MCP gateway names updated: `cleo_query`/`cleo_mutate` → `query`/`mutate` throughout (T5361, T5507)

### OpenCode Spawn Adapter + Tessera Engine (T5236, T5239)

- **OpenCode spawn adapter** — `src/core/spawn/adapters/opencode-adapter.ts` — CLEO can now spawn
  subagents into OpenCode environments using the OpenCode CLI, with project-local agent definition sync
  for provider-native spawning. Adds to the existing Claude Code adapter (T1114, T5236)
- **Chain-store search API** — `ChainFindCriteria` added to `src/core/lifecycle/chain-store.ts` — query
  Warp chains by text, category, tessera archetype, and limit
- **Tessera engine hardening** — Major update to the Warp chain execution engine with improved gate
  resolution, chain validation integration, and instance lifecycle tracking
- **Default chain definition** — `src/core/lifecycle/default-chain.ts` updated with standard RCASD-IVTR+C
  stage defaults for new chain instances
- **Chain validation tests** — `src/core/validation/__tests__/chain-validation.test.ts` — comprehensive
  coverage for chain structure, gate ordering, and validation edge cases
- **API codegen** — `src/api-codegen/generate-api.ts` (575 lines) — generates typed API clients directly
  from the dispatch registry; produces TypeScript interfaces and operation call stubs
- **New Drizzle migration** — `drizzle/20260306001243_spooky_rage/` — schema migration for chain and
  session-related table updates
- **Domain test coverage expansion** — Comprehensive dispatch domain tests added:
  - `src/dispatch/domains/__tests__/check.test.ts` — 137 lines covering all check domain operations
  - `src/dispatch/domains/__tests__/orchestrate.test.ts` — 110 lines covering orchestrate domain
  - `src/dispatch/domains/__tests__/pipeline.test.ts` — 229 lines covering pipeline domain ops
  - `src/core/sessions/__tests__/index.test.ts` — 84 lines covering session lifecycle
  - `src/core/sessions/__tests__/session-memory-bridge.test.ts` — 68 lines for session↔BRAIN bridge
  - `src/core/hooks/__tests__/registry.test.ts` and `provider-hooks.test.ts` — hook system coverage
- **dev/archived/ purged** — All ~50 legacy Bash scripts removed from `dev/archived/`:
  compliance checks, benchmarks, bump/release scripts, schema tools, and lib/ Bash helpers.
  The `dev/` directory is now TypeScript-only
- **New dev utilities** — `dev/check-todo-hygiene.sh` and `dev/check-underscore-import-hygiene.mjs`
  for ongoing codebase hygiene checks

### NEXUS reconcile CLI (T5368)

- `cleo nexus reconcile` CLI subcommand added — reconciles local project state with the NEXUS registry,
  detecting and resolving drift between local `.cleo/` state and registered project entries

### Specification Consolidation (T5239, T5492-T5506)

Major doc surgery: deleted superseded specs, updated all active specs to [IMPLEMENTED]/[TARGET] markers,
created T5492-T5506 epics for all gated/target items.

**Deleted (superseded or consolidated):**
- `CLEO-OPERATIONS-REFERENCE.md` — superseded by `CLEO-OPERATION-CONSTITUTION.md`
- `CLEO-STRATEGIC-ROADMAP-SPEC.md` — consolidated into `docs/ROADMAP.md`
- `VITEST-V4-MIGRATION-PLAN.md` — migration complete
- `CAAMP-1.6.1-API-INTEGRATION.md`, `CAAMP-CLEO-INTEGRATION-REQUIREMENTS.md` — consolidated
- `T5236-CAAMP-SPAWN-ADAPTER-DESIGN.md`, `T5237-UNIVERSAL-HOOKS-DESIGN.md` — consolidated

**Updated with [IMPLEMENTED]/[TARGET] clarity:**
- `ROADMAP.md` — [IMPLEMENTED] / [TARGET] markers with epic references
- `VERB-STANDARDS.md` — `purge` verb added (now 38 canonical verbs)
- `CLEO-OPERATION-CONSTITUTION.md` — synced to 256 operations
- `MCP-SERVER-SPECIFICATION.md` — 10 canonical domains, 256 ops, MCP-only BRAIN
- `MCP-AGENT-INTERACTION-SPEC.md` — refreshed progressive disclosure framework
- `PORTABLE-BRAIN-SPEC.md` — portability section and NEXUS sync notes added
- `CLEO-METRICS-VALIDATION-SYSTEM-SPEC.md` — Bash refs removed, TypeScript docs
- `CLEO-DATA-INTEGRITY-SPEC.md` — partially implemented status marked

**New:**
- `CAAMP-INTEGRATION-SPEC.md` — unified CAAMP integration reference with [TARGET] sections
- `CLEO-AUTONOMOUS-RUNTIME-SPEC.md` — specification for autonomous runtime behaviors
- `CLEO-AUTONOMOUS-RUNTIME-IMPLEMENTATION-MAP.md` — implementation tracking map
- `CLEO-API.md` — API reference document

### Conduit Protocol Specification (T5524)

- **`docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md`** (429 lines) — Formal specification for the CLEO
  Conduit protocol: the structured channel through which agents pass context, observations, and control
  signals between CLEO operations and external systems
- **`docs/specs/STICKY-NOTES-SPEC.md`** additions — Expanded sticky note lifecycle and promotion paths
- Canon concept docs updated: `CLEO-CANON-INDEX.md`, `NEXUS-CORE-ASPECTS.md`, `CLEO-VISION.md`,
  `CLEO-WORLD-MAP.md`, `CLEO-AWAKENING-STORY.md`, `CLEO-FOUNDING-STORY.md` — all reflect current
  canon vocabulary and system state

### Breaking Changes

> Clients on `2026.3.13-beta.1` (@beta) must migrate before upgrading to `@latest`.

| Old | New | Since |
|-----|-----|-------|
| MCP tool `cleo_query` | `query` | T5507 |
| MCP tool `cleo_mutate` | `mutate` | T5507 |
| `admin.config.get` | `admin.config.show` | T5245 |
| `tasks.reopen` | `tasks.restore` | T5245 |
| `tools.issue.create.*` | `tools.issue.add.*` | T5245 |
| `sharing.*` | `nexus.share.*` | T5276 |
| Non-canonical domain names | Returns `E_INVALID_DOMAIN` | T5246 |
| `restore --reopen/--unarchive/--uncancel` CLI flags | Use `restore` directly | T5249 |
| `find --search` CLI alias | Use `find` | T5249 |
| tasks.json runtime paths | SQLite-only via tasks.db | T5284 |
| JSONL audit log fallbacks | Structured logger + SQLite | T5317 |
| 32 maxActiveSiblings default | No default (unlimited) | T5413 |

---

## [2026.3.13-beta.1] - 2026-03-03

### Added

- **CAAMP spawn adapter and provider capability foundation (T5236/T5237/T5238)**:
  - Added spawn adapter registry and Claude Code adapter scaffolding (`src/core/spawn/`)
  - Added orchestrate spawn execution path and dispatch wiring (`orchestrate.spawn.execute`)
  - Added tools operations for spawn/provider discovery and hook/provider capability checks
  - Added skill precedence resolution integration and coverage tests
  - Added universal hook infrastructure (`src/core/hooks/`) with session/task-work event dispatch

### Changed

- **Task completion hardening (T5253)**:
  - `tasks.complete` is enforced as canonical completion path; `tasks.update status=done` now routes through completion checks
  - Mixed `status=done` + other update fields are blocked to prevent bypasses
  - Completion dependency semantics now treat `cancelled` dependencies as satisfied
  - Acceptance policy enforcement added for configured priorities
  - Verification gate enforcement is now **default-on** and can be disabled per-project (`verification.enabled=false`)
  - Lifecycle-aware completion failures now map to canonical gate/error semantics in strict mode

- **Task data safety naming alignment**:
  - Introduced `safeSaveTaskData` as preferred alias while retaining `safeSaveTaskFile` compatibility

- **Dependency updates**:
  - Upgraded `@cleocode/caamp` to `^1.6.0` (resolved `1.6.1` in lockfile)

### Documentation

- Updated canonical docs for completion hardening semantics:
  - `docs/concepts/CLEO-VISION.md`
  - `docs/specs/CLEO-OPERATION-CONSTITUTION.md`
  - `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md`
  - `docs/guides/task-fields.md`
- Added ADR-022 for canonical completion semantics and enforcement policy:
  - `.cleo/adrs/ADR-022-task-completion-hardening.md`
- Added design/spec docs for spawn adapters, hooks, precedence, and CAAMP 1.6.1 integration:
  - `docs/specs/T5236-CAAMP-SPAWN-ADAPTER-DESIGN.md`
  - `docs/specs/T5237-UNIVERSAL-HOOKS-DESIGN.md`
  - `docs/design/T5238-SKILLS-PRECEDENCE-REGISTRY-DESIGN.md`
  - `docs/specs/CAAMP-1.6.1-API-INTEGRATION.md`

---

## [2026.3.12] - 2026-03-03

### Added
- **Progress indicators for slow CLI commands (T5243)** — Commands now show real-time progress:
  - `cleo doctor --human` shows 5-step progress (checking CLEO directory, verifying tasks.db, etc.)
  - `cleo upgrade --human` shows 5-step progress (analyzing state, checking migrations, etc.)
  - `cleo self-update --human` shows 6-step progress (detecting install type, querying npm, etc.)
  - Progress writes to stderr so JSON output remains valid
  - Shows ✓ checkmarks on completion, ✗ on errors

### Documentation
- Updated ADR-016 with progress indicator architecture and installation channel updates

---

## [2026.3.11] - 2026-03-03

### Changed
- **Architectural separation of global and project initialization (T5242)** — Complete refactor of installation flow:
  - NPM `postinstall` hook now auto-bootstraps global CLEO system (`~/.cleo/`, MCP configs, templates, CAAMP setup)
  - `cleo init` now only creates local project structure (`./.cleo/`, NEXUS registration) — no longer touches global configs
  - `install.sh` is now dev-mode/legacy-only for contributors and offline/air-gapped systems
  - MCP server installation defaults to global scope in `mcp-install` command

### Documentation
- Updated README with npm-first installation instructions
- Updated troubleshooting guide with installation issues section
- Updated install.sh documentation to clarify dev/legacy purpose

---

## [2026.3.10] - 2026-03-03

### Fixed
- **Self-update channel behavior hardened (T4884)** — `self-update` now performs npm global updates for stable/beta channels directly, with improved runtime channel detection to avoid stale `mode=dev-ts` metadata blocking normal updates.
- **Runtime channel inference correction (T4884)** — Invocation-based detection now treats `cleo`/`ct` as stable by default to prevent stale metadata from forcing false dev-mode behavior.

### Added
- **TypeScript version sync tool (T4884)** — Added `dev/version-sync.ts` (config-driven from `.cleo/config.json` `release.versionBump.files`) and converted `dev/validate-version.sh` into a compatibility wrapper.

---

## [2025.3.9] - 2026-03-02

### Fixed
- **Channel-isolated MCP install behavior (T4884)** — MCP server names are now channel-specific (`cleo`, `cleo-beta`, `cleo-dev`) across `init`, `mcp-install`, and `install-global`, preventing dev/beta config collisions with stable.
- **Installer dev-channel isolation (T4884)** — `install.sh --dev` now defaults to `~/.cleo-dev` (unless `CLEO_HOME` is explicitly set), and no longer creates standalone `cleo-mcp*` CLI symlinks.
- **Dev install safety enforcement (T4884)** — Dev installs now require a valid CLEO contributor clone with `.git` present and `upstream` remote targeting `https://github.com/kryptobaseddev/cleo`.
- **MCP first-run global bootstrap (T4884)** — MCP startup now ensures global CLEO baseline artifacts (global home directory, schemas, and injection template) exist for MCP-first workflows.
- **Upgrade/init setup parity (T4884)** — `upgrade` now ensures missing `.cleo/config.json`, reducing drift between project `init` and `upgrade` outcomes.
- **Self-update channel behavior hardened (T4884)** — `self-update` now performs npm global updates for stable/beta channels directly, with improved runtime channel detection to avoid stale `mode=dev-ts` metadata blocking normal updates.

### Added
- **TypeScript version sync tool (T4884)** — Added `dev/version-sync.ts` (config-driven from `.cleo/config.json` `release.versionBump.files`) and converted `dev/validate-version.sh` into a compatibility wrapper.

---

## [2026.3.8] - 2026-03-02

### Added
- **NEXUS domain handler shipped with full dispatch wiring (T5241)** — Added `nexus` domain support in the dispatch layer with 12 operations, registry integration, and parity coverage.
- **BRAIN PageIndex + vector extension support (T5241)** — Added PageIndex graph tables and sqlite-vec extension loading with new storage tests and schema/migration coverage.

### Fixed
- **Gateway and registry alignment hardening (T5239)** — Synced dispatch registry derivation with gateway matrices, fixed `relates.add` routing, and added `note` alias coverage.
- **Single-source operation cleanup and stale TODO resolution (T5239)** — Consolidated canonical operation mappings, cleaned stale operation/docs drift, and completed dispatch migration follow-through across CLI/MCP.
- **SQLite migration + dependency correction (T5241)** — Upgraded CAAMP to v1.5.2, corrected ALTER TABLE migration behavior, and aligned sqlite-vec dependency setup.
- **Skill anti-hallucination corrections (T5149)** — Fixed guidance in `ct-cleo` and `ct-orchestrator` skills for `validate.report` and `orchestrate.start` usage.

### Documentation
- Updated `README.md` and `AGENTS.md` operation counts/content to match current dispatch and gateway reality (T5149).
- Updated BRAIN docs to shipped status: `docs/concepts/CLEO-VISION.md` and `docs/specs/CLEO-BRAIN-SPECIFICATION.md` now reflect approved v1.2.0 and shipped `brain.db` baseline (T5144).
- Promoted and refreshed roadmap/features documentation: canonical `docs/ROADMAP.md`, canonical `docs/FEATURES.json`, generated `docs/FEATURES.md`, and TypeScript-based `dev/generate-features.ts` generator.
- Added/updated protocol and lifecycle documentation artifacts from completion sweep and compliance follow-through (T5239).

### Chore
- Added `.cleo/agent-outputs/MANIFEST.jsonl` release artifact tracking entry (T5241).

---

## [2026.3.5] - 2026-03-02

### Added
- **Native BRAIN Memory System** — CLEO now has built-in observation storage, 3-layer retrieval, and session memory integration, replacing the external claude-mem dependency
  - `brain-retrieval.ts`: searchBrainCompact, timelineBrain, fetchBrainEntries, observeBrain — the 4 core retrieval functions matching claude-mem's search->timeline->fetch pattern
  - `session-memory.ts`: persistSessionMemory auto-captures decisions/patterns/learnings to brain.db when sessions end
  - Session briefing and resume now include relevant brain memory context
  - MCP memory domain: brain.search, brain.timeline, brain.fetch (query) + brain.observe (mutate)
  - claude-mem migration CLI: `cleo migrate claude-mem` imports all observations from claude-mem.db
  - FTS5 full-text search across all brain.db tables with BM25 relevance scoring
  - 37 E2E tests covering full observation lifecycle, multi-type search, token efficiency, cross-linking, session capture, and FTS5 quality

### Fixed
- brain-search.ts: Extended FTS5 virtual table support for observations with auto-sync triggers
- engine-compat.ts: Added 4 async wrappers for dispatch layer (memoryBrainSearch, memoryBrainTimeline, memoryBrainFetch, memoryBrainObserve)

---

## [2026.3.4] - 2026-03-02

### Fixed

- **S4 audit race condition** — Await `writeToSqlite()` in grade mode to prevent race between audit persistence and grading query.
- **Premature grade env var cleanup in endSession** — Removed early deletion of `CLEO_SESSION_GRADE` and `CLEO_SESSION_GRADE_ID` env vars; caller is now responsible for cleanup after evaluation completes.
- **CLEO_SESSION_GRADE_ID dead code** — Env var is now set during grade session start in both `session-engine` and core `sessions/index`, fixing references that previously read an unset variable.

### Added

- **53 grade rubric tests** — 46 unit tests covering all 5 dimensions (S1-S5) with edge cases, plus 7 integration tests for full grading flow with CLEO_HOME isolation.
- **CLEO-GRADE-SPEC.md** — Formal 5-dimension rubric specification for session behavioral grading.
- **GRADE-SCENARIO-PLAYBOOK.md** — 5 grading scenarios with pass criteria and expected dimension scores.
- **ct-grade skill** — Agent guidance skill for session behavioral grading.

### Completed

- **6 BRAIN database tasks** (T5127-T5130, T5155-T5156) confirmed done — brain.db Drizzle schema, data accessor, decision memory, JSONL migration, FTS5 search, memory links.

---

## [2026.3.3] - 2026-03-01

### Quality

- **Zero-failure perfection: 3387 tests, 0 skipped, 0 failed** — Validated and shipped Phase 1 refactoring. All skipped tests enabled, all failures fixed, full E2E validation passed.
- **Suppress Node experimental warnings in tests** — Added default `NODE_NO_WARNINGS=1` initialization in `vitest.config.ts`.

### Features

- **RCASD lifecycle artifact wiring completed (T5216, T5217)** — `pipeline.stage.record` now scaffolds stage markdown under `.cleo/rcasd/{epicId}/{stage}/`, writes YAML frontmatter/backlinks, persists `outputFile` and provenance chain in SQLite, records lifecycle evidence on stage completion, and auto-triggers ADR sync/link on `architecture_decision` completion.
- **Doctor dispatch: --comprehensive and --fix flags (T5219)** — Wired `coreDoctorReport` and `runDoctorFixes` through full CLI/MCP dispatch pipeline. 21 comprehensive checks available via `cleo doctor --comprehensive`, auto-repair via `cleo doctor --fix`.
- **Init/upgrade refactored** — Extracted scaffold.ts, hooks.ts, injection.ts, schema-management.ts from monolithic init.ts.

### Bug Fixes

- **Migration topological sort (T5218)** — Fixed storage_migration failure when child tasks appear before parents in source JSON. Added topological sort for both parentId and depends ordering. 482/482 tasks import successfully on real legacy projects.
- **Migration null-safe descriptions** — Added fallback `Task: {title}` for tasks with null/undefined descriptions during JSON→SQLite migration.
- **Lifecycle tests fixed for SQLite-native flow** — Updated tests that wrote JSON manifests to use `recordStageProgress()` (SQLite-native) after T4801 migration.
- **Pre-commit hook: removed tasks.db from protected list** — Per ADR-013, tasks.db must not be git-tracked. Updated hook template and installed hook.
- **Add missing drizzle migrations for task_relations (T5168)** — Generated migration to add `reason` column to `task_relations` table. Generated custom migration to update CHECK constraint on `relation_type` from 3 values (`related`, `blocks`, `duplicates`) to 7 values (`related`, `blocks`, `duplicates`, `absorbs`, `fixes`, `extends`, `supersedes`). Fixes 58 test failures in relations, core-parity, and MCP E2E tests.

---

## [2026.3.2-beta.1] - 2026-03-01

### Release Prep

- **Beta channel release cut from `develop`** — Prepared prerelease package version `2026.3.2-beta.1` and tag flow for npm `@beta` per ADR-016 channel policy.

---

## [2026.3.1] - 2026-03-01

### Bug Fixes

- **Prevent database wipe on branch switch (T5184)** — Removed `.cleo/tasks.db-wal` and `.cleo/tasks.db-shm` from git tracking. Git-tracked empty WAL/SHM blobs overwrote live SQLite WAL on branch switch, destroying pending writes. Added auto-recovery safety net that detects empty databases with valid backups and restores on startup. Added extended git-tracking warning on MCP server startup.

- **Relates add persistence bug (T5168)** — Fixed `addRelation()` in `src/core/tasks/relates.ts` to write to `task_relations` junction table via `accessor.addRelation()`. Previously, relates data was silently lost because `taskToRow()` has no `relates` column. Added 5 new Vitest tests for relates persistence.

- **Pre-commit hook blocks WAL/SHM removal (T5184)** — Fixed pre-commit hook to allow `git rm --cached` operations on WAL/SHM files using `--diff-filter=ACMR`.

---

## [2026.3.0] - 2026-03-01

### Major Changes

- **Engine Consolidation** — Relocated all engine adapters from `src/mcp/engine/` to `src/dispatch/engines/`, establishing `src/dispatch/` as the canonical dispatch layer. Deleted the entire `src/mcp/engine/` directory (13 files, ~5,000 lines). MCP barrel re-exports preserved for backward compatibility.

- **RCASD Provenance Consolidation (T5100)** — Full lifecycle provenance system with 6 phases, 17 agents. Migrated `rcsd/` to `rcasd/` naming, added lifecycle provenance columns to schema, created consolidation pipeline with evidence tracking and frontmatter parsing.

- **MVI Tier-Based Projection (T5096)** — Progressive disclosure system with minimal/standard/orchestrator tiers. Session-scope-aware tier resolution (epic scope auto-maps to orchestrator). Projection middleware strips fields by tier. Cost hints in admin help.

- **Tier-Based Protocol Injection (T5155)** — Subagent spawns now receive tier-filtered protocol content. Injection chain doctor checks validate tier marker integrity.

### Features

- Agent-safe dependency enforcement across 5 enforcement points (T5069)
- Transitive dependency hints in task query responses (T5069)
- `ensureArray()` for MCP array parameter normalization (T5094)
- Core log reader library for observability with pino JSONL parsing (T5187)
- Find filters, list compact projection, and help cost hints (T5073, T5072)
- Task relations batch loading and `relates` field (T5168)
- Injection chain doctor checks (T5153)
- Decision trees and anti-patterns added to ct-cleo skill (T5154)
- Atomic task ID allocation with collision detection (T5184)

### Bug Fixes

- SQLite WAL mode verification and `BEGIN IMMEDIATE` for migrations (T5173)
- Retry+backoff for `SQLITE_BUSY` during migrations (T5185)
- TOCTOU race in task ID generation fixed with atomic allocation (T5184)
- 4 dispatch-layer bugs resolved (T5148, T5149, T5157, T5168)
- `addRelation` passthrough added to SafetyDataAccessor (T5168)
- Stale imports in brain-operations test (T5107, T5108)
- `taskComplete` wired through core with MCP bootstrap hints (T5069, T5090)
- MVI tier projection and spawn tier filtering (T5096, T5155)

### Refactoring

- Consolidated task, release, validate, config, and init engines into dispatch layer (T5100, T5109-T5111)
- Unified `EngineResult` type to single canonical definition (T5093)
- Fixed layer violations by relocating shared utilities out of `mcp/engine` (T5095)
- Removed vestigial `AGENT-INJECTION.md` files (T5152)
- Restructured `CLEO-INJECTION.md` to minimal-only v2.1.0 template (T5100)
- Removed 236 unused schemas and archived legacy schemas (T5100)
- Deleted `dev/recover-tasks.ts` and its guardrail test
- Removed legacy experiment scripts and duplicate specification docs

### Documentation

- Comprehensive documentation audit and Git Flow branching setup (T4556)
- Architecture references updated for dispatch-first engine layout (T5098)
- Workspace research added to RCASD provenance (T5164)
- RCASD lifecycle manifests, kept schemas, and task fields guide (T5164)
- Sibling limit docs aligned (T4862)

### Tests

- E2E tests for injection chain and tier filtering (T5156)
- Post-consolidation architectural verification parity tests (T5099)
- Dispatch-layer parity integration tests
- Task relations persistence tests (T5168)
- Spawn tier filtering tests
- Projection middleware tests
- Doctor injection chain checks tests (T5153)

---

## [2026.2.9] - 2026-02-28

### Bug Fixes

- **Fixed critical npm install failure — drizzle-orm/zod ERR_PACKAGE_PATH_NOT_EXPORTED** — The npm-published package was completely broken on install. The `drizzle-orm` dependency used `^1.0.0-beta.15` which npm resolved to `1.0.0-beta.9-e89174b` due to semver pre-release alphanumeric sorting ranking hash-suffixed versions higher than numeric identifiers (`9-e89174b` > `15`). This version lacks the `./zod` export, causing all CLI and MCP operations to crash immediately. Fixed by pinning to exact version `1.0.0-beta.15-859cf75`. Both `drizzle-orm` and `drizzle-kit` are now pinned.

- **Added `cleo mcp` subcommand for MCP server launch** — All AI agent configs use `npx -y @cleocode/cleo@latest mcp`, but `mcp` was not a CLI subcommand (the binary is `cleo-mcp`). Added `mcp` as a pre-parse argv check that spawns `dist/mcp/index.js` with inherited stdio, enabling all agents to launch the MCP server via the standard `cleo mcp` invocation. The `--mcp-server` flag is preserved for backward compatibility.

---

## [2026.2.7] - 2026-02-28

### Bug Fixes

- **Fixed audit_log missing dispatch columns migration (T5063)** — The `audit_log` table schema defined 17 columns including 9 dispatch layer columns, but the migration chain only created 8. A migration referenced as `20260225200000` was never committed. This caused `core-parity.test.ts` `taskCreate` test to fail consistently on fresh databases because drizzle generates INSERT SQL for all 17 schema columns. Fixed with a custom drizzle-kit migration using table rebuild pattern for idempotency. Test suite: 2779/2780 → 2884/2884 (100%).

---

## [2026.2.6] - 2026-02-27

### Major Features

- **Installation Channels & Dev Runtime Isolation (ADR-016)** — Three distinct runtime channels:
  - **Stable**: `cleo`, `cleo-mcp`, optional `ct` alias (`@cleocode/cleo@latest`)
  - **Beta**: `cleo-beta`, `cleo-mcp-beta`, optional `ct-beta` (`@cleocode/cleo@beta`)
  - **Dev**: `cleo-dev`, `cleo-mcp-dev` with isolated `~/.cleo-dev` data root (no `ct`)
  - Channel-aware installer manages command naming and data isolation
  - Runtime diagnostics expose channel identity via `cleo env info` and `admin.runtime`

- **BRAIN Memory Integration** — Initial BRAIN Network domain with pattern and learning memory:
  - `memory.pattern.search` / `memory.pattern.stats` — Pattern memory operations
  - `memory.learning.search` / `memory.learning.stats` — Learning memory operations

- **Session Architecture Overhaul (T4959, T5039-T5042)** — Complete session system rewrite:
  - Drizzle-first session types with `SessionView` abstraction
  - Session identity architecture with proper agent session transitions
  - Removed `multiSessionEnabled` flag, `sessionHistory` array, and all `@deprecated` annotations
  - Deleted legacy MCP `session-engine.ts` — zero legacy session code remaining
  - Fixed handoff/briefing pipeline for LLM agent session transitions

- **CQRS Dispatch Architecture (T4814-T4816)** — New dispatch layer:
  - Domain handler registry with middleware pipeline (audit, validation, routing)
  - Push policy for release operations with documentation and branding
  - LAFS alignment with domain architecture cleanup

### Architecture

- **Shared-Core Pattern Verified** — CLI and MCP both delegate to `src/core/` (T4565/T4566 audit)
- **node:sqlite Migration** — Replaced sql.js with Node.js native SQLite in migration, atomic, and checksum modules (T4949, T4950)
- **JSON Storage Engine Removed** — SQLite-only storage, no more dual-engine path (T4854)
- **ADR System Canonicalization** — Full ADR lifecycle with cognitive search, RCASD auto-linking, task traceability, frontmatter validation (T4792, T4942)
- **Lifecycle Standardization** — RCASD-IVTR+C canonical naming with backward compatibility shims (T4798)
- **Pino + SQLite Dual-Write Logging** — Replaced JSON file audit logger (T4844)
- **Drizzle ORM v1.0.0-beta.15** — Upgraded with fixed save flow and FK orphan handling (T4817, T5034)
- **8-Wave Reconciliation** — Lifecycle, domains, RCASD, naming, BRAIN, audit, and V2 port consolidation

### Features

- Universal `--field/--fields/--mvi` flags on all CLI commands (T4953)
- `--field` + `--human` uses `renderGeneric` for extracted data display (T4541)
- Focus system migrated to canonical `start/stop/current` verbs (T4911)
- CAAMP skill catalog alignment for bundled operations (T4680, T4820)
- Self-update with post-update bundled skill refresh
- `parentId` parameter accepted in `tasks.add` and `tasks.update` MCP operations (T5031, T5032)
- Fine-grained single-task writes in store layer (T5034)
- Pre-commit hook enforcing drizzle snapshot presence and SQLite WAL exclusion (T4792, T4894)
- Node.js v24+ minimum enforced with auto-install via fnm (T015)
- `cleo init` now auto-installs git hooks (`commit-msg`, `pre-commit`) from `templates/git-hooks/` (T5056)
- `grade.schema.json` moved to canonical `schemas/` directory; dead legacy schemas removed (T5056)

### Bug Fixes

- Fixed raw SQL graph queries returning arrays instead of objects (T4754)
- Fixed lifecycle `stageName` enum type casting (T4951)
- Fixed missing `await` on drizzle-proxy queries in task-store and session-store (T4754)
- Fixed `installSkill` missing await in skills install command (T4948)
- Fixed `.sequence.json` check graceful on missing file (T4836)
- Fixed drizzle migration callback wrapped in SQLite transaction
- Fixed `makeCleoGitEnv` relative-path bug for CLI checkpoint command (T4867)
- Fixed git commit restricted to staged `.cleo/` state file paths only (T4871)
- Fixed orphaned `parentId` references with FK cascade and `ON DELETE SET NULL` (T5034)
- Fixed README.md corrupted alignment tag from sed artifact
- Removed two hand-written drizzle migrations missing `snapshot.json` (orphaned SQL not in schema)

### Refactoring

- Removed all `@deprecated` annotations and dead aliases (T5041)
- Eliminated duplicate operations across MCP domains (T4773)
- Removed leaked operations from admin domain (T4774, T4775)
- Removed dispatch/lib bridge imports from mcp/lib (T4832)
- Centralized `--field/--fields/--human` in `cliOutput` for all commands (T4953)
- Extracted system, orchestrate, validate, task-noncrud, lifecycle, research, config, init, release engine logic to `src/core/` (T4782-T4790)
- Fixed 5 verb standard violations (T4792)
- Consolidated CLAUDE.md into AGENTS.md as single canonical instruction file (T4546)
- Complete data integrity tools and migration system consolidation (ADR-006, T4699)

### Documentation

- **ADR-016**: Installation channels and dev runtime isolation
- **CLEO-INSTALL-CHANNELS-SPEC.md**: Complete channel contract specification
- **CAAMP-CLEO-INTEGRATION-REQUIREMENTS.md**: Provider MCP installation requirements
- **ADR-009**: BRAIN cognitive architecture
- **ADR-011**: Project configuration architecture
- **Verb Standards v2**: 17 missing verbs added, LAFS output format flags documented (T4732)
- CalVer versioning scheme documented in CONTRIBUTING.md
- Updated CONTRIBUTING.md with TypeScript conventions and dev channel setup
- Updated README version badge and fixed corrupted HTML tag
- Comprehensive `.gitignore` update for runtime data, IDE configs, and secret exclusion

### Developer Experience

- Runtime channel detection via `cleo env info --json`
- Warnings when dev channel invoked via `cleo` instead of `cleo-dev`
- Isolated dev data root prevents collisions with stable installs
- CAAMP integration for provider-specific MCP configuration
- Pre-commit hooks for drizzle snapshot enforcement and SQLite WAL exclusion

---

## [2026.2.5] - 2026-02-25

### Changes

- Infrastructure consolidation: agent-outputs, gitignore, init, upgrade (T001)

---

## [2026.2.4] - 2026-02-24

### Features

- Add pre-flight migration check to core — detect JSON data needing SQLite migration (T4699)

---

## [2026.2.3] - 2026-02-23

### Features

- Add pre-flight migration check to core — detect JSON data needing SQLite migration (T4699)

---

## [2026.2.1] - 2026-02-17

### Features

- **SQLite storage activated** — All task domain data stored in SQLite via DataAccessor abstraction (ADR-002)
- LAFS type conformance in gateway-meta.ts
- release-engine.ts migrated to async DataAccessor pattern

### Bug Fixes

- Fixed T4454 master epic type from "task" to "epic"
- Cleared stale focus pointer to archived task T4654
- Resolved T4653 orphan (parent T4638 in archive)
- Fixed release-engine loadTasks() to use DataAccessor with JSON fallback for tests
- Fixed release domain handler mutateNative() to properly await async engine functions

### Architecture

- DataAccessor pattern fully wired: StoreProvider, all MCP engines, all core modules
- Storage migration verified: 278 tasks + 3,978 archived + 606 sessions
- 2,419 tests pass, 0 failures (125 test files)
