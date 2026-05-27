# Lead 5 — Cleanup + Release + Test Strategy + Rollout

**Epic**: T889 Orchestration Coherence v3
**Scope**: T909 conduit.db audit, test matrix for all 20 tasks, release pipeline plan, CI rollout, install-latest verification
**Author role**: Research only (no code writes)
**Date**: 2026-04-17

---

## 1. FINAL-STATE ARCHITECTURE

### 1A. Conduit.db topology

#### Audit results (empirical)

| Location | Size | Tables | Row counts | Last modified | Status |
|---|---|---|---|---|---|
| `~/.cleo/conduit.db` | 208,896 B | 17 (full schema) | **0 rows across ALL 5 data tables** (conversations=0, messages=0, delivery_jobs=0, dead_letters=0, message_pins=0) | 2026-04-17 13:56 | **ORPHAN — empty schema, never written to** |
| `/mnt/projects/cleocode/.cleo/conduit.db` | 626,688 B | 17 (full schema) | conversations=12, messages=644, delivery_jobs=0, dead_letters=0, message_pins=0 | 2026-04-17 13:17 | **LIVE** — primary messaging DB |
| `~/.local/share/cleo/` | — | — | — | — | **NO conduit.db present** — only nexus.db + signaldock.db |

Schema of orphan `~/.cleo/conduit.db`: identical to project-tier (conversations, messages, messages_fts, delivery_jobs, dead_letters, message_pins, attachments, attachment_versions, attachment_contributors, attachment_approvals, project_agent_refs, `_conduit_meta`, `_conduit_migrations`). Schema version in meta = `2026.4.12`, migration timestamp = `1775779696` (2026-03-07). **Reborn on 2026-04-17 13:56 with zero rows** — the birth was 2026-04-09 17:08 (matches signaldock.db-shm/wal birth — post-T310 migration), then overwritten.

#### Root cause — why does `~/.cleo/conduit.db` keep coming back?

`getConduitDbPath(projectRoot)` at `packages/core/src/store/conduit-sqlite.ts:312` unconditionally returns `<projectRoot>/.cleo/conduit.db`. The value `projectRoot` is supplied by callers via `resolveProjectRoot()` (or `getProjectRoot()` at `packages/core/src/paths.ts:282`). The ancestor walk at lines 310-336 **returns the first ancestor containing `.cleo/`**. When a user runs `cleo <cmd>` from `$HOME` (or any directory under `$HOME` that does NOT have a nearer `.cleo/` sentinel), the walk lands on `$HOME/.cleo` because it exists there from historical artifacts (signaldock.db-*.bak, logs/). The `.context-state.json` at `~/.cleo/.context-state.json` shows `workspace: "/home/keatonhoskins"` confirming past execution from `$HOME`.

The code is correct per its contract (first `.cleo/` wins). The problem is the **pre-existing `~/.cleo/` directory** is a T310 migration leftover that `getProjectRoot` now mistakes for a project.

#### Decision — **DELETE**, not relocate

Rationale:

- The orphan `~/.cleo/conduit.db` has **zero rows** — no data to preserve.
- No documented purpose for a **global-tier** conduit.db (ADR-037 defines conduit.db as **project-tier only**; global agent identity lives in `signaldock.db` at `~/.local/share/cleo/signaldock.db`).
- The `project_agent_refs` design (see `packages/contracts/src/agent-registry.ts:67`) already says "`<project>/.cleo/conduit.db:project_agent_refs`" — project-tier only, soft-FK to global signaldock.db.
- Relocating to `~/.local/share/cleo/conduit.db` would introduce a new concept (global-tier cross-project messaging) that NO CODE CONSUMES today.
- Keeping a stub there creates a permanent footgun for users who `cd ~` and run `cleo` commands.

#### Migration path (T909 implementation, idempotent, reversible)

```
Phase 1 — Detection (cleoos doctor extension)
  - Scan for legacy $HOME/.cleo/conduit.db
  - If present AND row-count > 0 → emit WARNING with backup-and-remove instructions
  - If present AND row-count == 0 → emit INFO with safe-remove instructions
  - If absent → PASS

Phase 2 — Safe-remove (cleo agent doctor --repair OR explicit cleo repair orphan-conduit)
  - Move $HOME/.cleo/conduit.db → $HOME/.cleo/conduit.db.bak.YYYYMMDD (reversible)
  - Also move conduit.db-shm, conduit.db-wal if present
  - Log to .cleo/audit/orphan-cleanup.jsonl (structured record)

Phase 3 — Prevention (cleo root resolution hardening)
  - getProjectRoot() gains a new check: if resolved root is $HOME or $HOME's immediate child AND no .git/ sibling AND no project-context.json → throw E_HOME_ROOT_REFUSED
  - Error message: "Refusing to treat $HOME as a CLEO project root. cd into an actual project or set CLEO_ROOT."
  - Gated behind a flag `strictRootResolution: true` in config.json for opt-in during rollout, flipped default=true after 2 releases.

Phase 4 — Documentation
  - docs/architecture/database-topology.md (new, shared with T896): project-tier vs global-tier table, with concrete paths and responsibilities
  - Injection memory (memory-bridge.md) flagged to NEVER re-add global conduit.db
```

The migration is **fully reversible** — the backup file can be restored manually until the user's next `cleo backup prune`.

---

### 1B. Test strategy — per-task matrix (see §3 for full breakdown)

#### "REAL TEST" policy — enforcement definition

A test is REAL for this epic iff:

1. **Database inputs**: Ephemeral tmpdir-backed SQLite files via `better-sqlite3` or `node:sqlite` `DatabaseSync` — never a `vi.mock('@cleocode/core/store/...')` or interface stub. The test `beforeEach` creates a fresh `tasks.db` / `signaldock.db` / `conduit.db` via the ACTUAL `ensureConduitDb(tmpRoot)` / `ensureTasksDb` / `ensureSignaldockDb` functions.
2. **CANT parsing**: Real `.cant` file fixtures in `__fixtures__/` loaded from disk via the actual parser — not hand-rolled token streams or mocked ASTs.
3. **Subprocess / tool verification**: Actual `execFileSync('pnpm', ['biome', 'ci', '.'])` with real exit-code capture — not stubbed child-process modules.
4. **CLI command integration**: Real `execFileSync('node', ['packages/cleo/dist/cli/index.js', 'orchestrate', 'plan', 'T###'])` against a tmpdir-scoped `CLEO_ROOT` — not direct function calls that bypass the citty dispatch layer.
5. **Contracts**: Types imported from `packages/contracts/src/*.ts` — never re-declared inline or cast through `as unknown`.

A test is NOT real if it uses `vi.mock`, stubbed DataAccessor, or any shortcut where the code under test runs against fabricated I/O. `vi.fn()` for a pure-function collaborator (e.g. an injected logger) is acceptable; `vi.mock('@cleocode/core')` for a whole module is NOT.

#### Test DB hygiene

- Every test that creates a DB MUST do so under `mkdtempSync(join(tmpdir(), 'cleo-T###-'))`.
- `afterEach` MUST call `closeConduitDb()` / `closeTasksDb()` / `closeSignaldockDb()` AND `rmSync(tmpRoot, { recursive: true, force: true })`.
- No test may write to `~/.cleo/` or `~/.local/share/cleo/` — enforced by asserting `process.env.HOME` points to a tmp dir during tests where filesystem side-effects are possible (already done in `packages/adapters/src/__tests__/cant-context.test.ts` — propagate pattern).
- Tests that touch the NETWORK (npm view for `already_published()`) are either (a) gated behind `SKIP_NETWORK_TESTS=1` with a stubbed `npm view` exit code, or (b) run only in CI's `install-test` job against a scratch npm namespace. The T889 epic ships **zero tests that hit real npm** — install-latest verification is a post-release human-gated step, NOT a vitest assertion.

---

### 1C. Release plan

#### CalVer decision — stay on `v2026.4.x`

- Today is 2026-04-17 (month = 4). All 20 tasks will ship this April.
- Current tip: `v2026.4.85`.
- Release workflow `Validate CalVer` step requires `TAG_YEAR == CURRENT_YEAR && TAG_MONTH == CURRENT_MONTH` for stable releases.
- If any wave slips past 2026-05-01, we bump to `v2026.5.0`. **Plan assumption: all waves ship in April 2026.**

#### Wave-to-release mapping — 4 waves, 4 tagged releases

Each wave gets its own tag + npm publish run. This gives us 4 independent rollback points. If Wave B fails validation post-publish, we don't have to unship Wave A.

| Wave | Target version | Tasks | Theme |
|---|---|---|---|
| Wave A (foundation) | **v2026.4.86** | T905 + T909 + T897 + T903 | Kill drift (seed-agent dedup, orphan conduit.db, postinstall seed, CANT DSL v3 types) |
| Wave B (registry) | **v2026.4.87** | T898 + T899 + T906 + T900 + T901 | Registry SSoT + tier precedence + agent_skills integration + doctor |
| Wave C (spawn) | **v2026.4.88** | T890 + T891 + T892 + T893 + T894 + T895 | Orchestrate plan + classify + auto-tier + atomicity + layout + dedup |
| Wave D (primitives + docs) | **v2026.4.89** | T902 + T904 + T907 + T908 + T896 | Dynamic skills + Playbook DSL + thin-agent enforcement + HITL resume tokens + architecture docs |

**Rationale for this sequencing**:

- Wave A establishes canonical sources so later waves don't amplify drift (seed-agents pick winner; CANT v3 types defined; orphan DB gone).
- Wave B makes the registry authoritative — T898 (registry-backed resolution) MUST land before T891 (spawn consults registry) in Wave C.
- Wave C wires the new primitives into the existing spawn path — depends on Wave A (v3 types) + Wave B (registry).
- Wave D introduces NET-NEW primitives (Playbook DSL, HITL) + docs. These can ship last without blocking earlier work.

#### Breaking changes — CHANGELOG callouts

- **CANT DSL v3** (T903) is a **minor-breaking schema change** — adds optional `requires:`/`ensures:`/`mental_model:` fields. Existing v2 .cant files remain valid (contracts empty). No consumer changes required. Call out under "Deprecations" in Wave A CHANGELOG section.
- **Seed-agent source unification** (T905) — `packages/cleo-os/seed-agents/` deleted. Any external dependency on that path breaks. Call out as **BREAKING** in Wave A CHANGELOG.
- **Spawn prompt layout change** (T895) — subagent-parsing adapters that rely on section order break. Already noted as "Breaking for spawn adapters" in v2026.4.85 pattern; extend same language in Wave C.
- **Thin-agent enforcement** (T907) — `.cant` files declaring `Agent` or `Task` tools on a worker role now **fail to parse**. Call out as **BREAKING** in Wave D. Migration: change `role: worker` to `role: lead` or remove the tool declaration.
- **T882 `spawn-prompt.ts` status** — research phase decides (per T889 AC line 18). If Wave C's new `composer.composeSpawnPayload` supersedes, the deprecation + removal commit goes in Wave C with prominent CHANGELOG note.

#### Version bump mechanism — who runs what

1. **Release lead** runs `node scripts/version-all.mjs --set 2026.4.86` → bumps root + all 13 package.json.
2. **Release lead** updates `CHANGELOG.md` with new section.
3. **Release lead** commits: `git add . && git commit -m "feat(T889-WaveA): v2026.4.86 — <summary>"` (no `--no-verify` — pre-commit hook now trusts frozen-lockfile).
4. **Release lead** tags: `git tag v2026.4.86 && git push origin main --tags`.
5. **GitHub Actions `release.yml`** auto-fires: re-syncs versions from tag, builds, biome-ci, validates artifacts, publishes to npm in dependency order.
6. **Release lead** verifies publish: `pnpm dlx @cleocode/cleo@2026.4.86 --version` returns `2026.4.86`.

#### Install-latest verification — REAL success criteria

After each wave's npm publish:

```bash
# Fresh directory, no prior cleo state
TMPDIR=$(mktemp -d)
cd "$TMPDIR"

# Install via pnpm dlx (matches real user flow)
pnpm dlx @cleocode/cleo@<version> --version   # must report <version>
pnpm dlx @cleocode/cleo@<version> init test-proj
cd test-proj
pnpm dlx @cleocode/cleo@<version> dash         # must succeed, no E_* errors
pnpm dlx @cleocode/cleo@<version> current      # must succeed
pnpm dlx @cleocode/cleo@<version> next         # must succeed

# Wave-specific smoke checks
# Wave A:
pnpm dlx @cleocode/cleo@<version> agent list --global   # must show 6 seeds (T897)
# Wave B:
pnpm dlx @cleocode/cleo@<version> agent doctor          # reports zero drift (T901)
# Wave C:
pnpm dlx @cleocode/cleo@<version> orchestrate plan T<any-epic>   # returns waves (T890)
# Wave D:
pnpm dlx @cleocode/cleo@<version> playbook run rcasd --input taskId=T<any>   # exits 0 (T904)
```

Each wave's install-verify output MUST be captured to `.cleo/agent-outputs/T889-orchestration/install-verify-WaveX.log` and committed BEFORE the next wave begins.

---

### 1D. CI rollout

#### Current CI job inventory (ci.yml + lockfile-check.yml + release.yml)

| Workflow | Job | Purpose | Matters for T889? |
|---|---|---|---|
| `ci.yml` | `changes` | Path-filter detector | auto |
| `ci.yml` | `biome` | `biome ci .` repo-wide | YES — all waves must pass |
| `ci.yml` | `canon-drift` | `cleo check canon` | YES — T905 changes seed-agents, may trigger |
| `ci.yml` | `migration-integrity` | every migration.sql git-tracked | YES — T903, T906 may add migrations |
| `ci.yml` | `typecheck` | `pnpm run typecheck` | YES — T903 CANT types gate here |
| `ci.yml` | `unit-tests` | `vitest` sharded 1/2, 2/2, Ubuntu + macOS + Windows on PR-to-main | YES — REAL-test enforcement runs here |
| `ci.yml` | `build-verify` | Cold-state `node build.mjs` + dist presence checks | YES — every wave |
| `ci.yml` | `validate-json` | `jq empty` on schema files | YES — T903 adds schema files |
| `ci.yml` | `install-test` | `pnpm link --global` + `cleo init` smoke | YES — extend with Wave-specific checks |
| `ci.yml` | `forge-ts-check` | TSDoc coverage (continue-on-error) | nice-to-have |
| `lockfile-check.yml` | `lockfile-consistency` | `pnpm install --frozen-lockfile` | YES — every commit |
| `release.yml` | `release` | biome-ci + build + publish 12 packages + GH release | YES — triggered by tag push |

#### CI changes required for T889

**Minimal** (no new workflows, extend existing jobs):

1. **Unit-tests job**: add a new shard 3/3 for the `packages/playbooks/` + `packages/cant/` + `packages/core/src/orchestration/` test burst in Wave C/D. Change shard count from 2 to 3 in `ci.yml:149` when Wave D lands.
2. **build-verify job**: add `test -f packages/playbooks/dist/index.js` assertion after Wave D introduces the package (T904).
3. **install-test job**: add post-wave smoke commands (per §1C above) gated on `matrix.os == 'ubuntu-latest'`. Script in `scripts/smoke-wave-<letter>.sh` called after the current `cleo init` step.
4. **Release workflow** (`release.yml:117`): add `packages/playbooks` to the package-sync list. Add to the `publish_pkg` order between `runtime` and `adapters`.
5. **New schema validator** — CANT v3 files MUST be validated by `jq`-equivalent + a vitest integration test in `packages/cant/tests/v3-schema.test.ts`.

#### Ensuring GREEN on all 3 workflows before tag

**Mandatory pre-tag checklist** (from CLAUDE.md):

```bash
# Ordered, every gate is mandatory:
pnpm biome ci .                          # 1. repo-wide strict, matches release.yml Biome CI step
pnpm run build                           # 2. ROOT build, matches release.yml Build step (NOT pnpm --filter)
pnpm run typecheck                       # 3. matches ci.yml typecheck job
pnpm exec vitest run                     # 4. full matrix — must report ZERO failures, ZERO regressions vs 8664 baseline
pnpm install --frozen-lockfile           # 5. matches lockfile-check.yml
# Optional but recommended:
pnpm --filter @cleocode/studio exec svelte-kit sync && pnpm --filter @cleocode/studio exec vite build   # catches T4820 regression pattern
```

All 5 must exit 0. If any fail, FIX before tagging — NEVER `--no-verify`, NEVER retry-the-tag, NEVER `git tag -f`.

#### Ferrous-forge bypass audit — **SAFE TO REMOVE**

Grep evidence: `ferrous` appears only in `packages/studio/.svelte-kit/ambient.d.ts` (auto-generated SvelteKit env var binding, unrelated to Rust toolchain). There is **zero** `cargo` step in `.github/workflows/` — Rust code is NOT built in CI. The T882 memory note about "Ferrous-forge bypass for pre-existing Rust signaldock-core doctest failures" refers to a LOCAL developer hook bypass, not a CI gate. **No CI-level bypass to remove.** If the local pre-commit hook still rejects Rust tests, that's a separate concern; T889 does NOT touch Rust crates, so it won't re-trigger.

---

## 2. CURRENT-STATE FINDINGS

### 2A. `~/.cleo/conduit.db` forensics

- **File size**: 208,896 B
- **Schema**: full (17 tables including FTS5 + migrations)
- **Schema version**: `2026.4.12` (per `_conduit_meta`)
- **Migration applied**: `2026-04-12-000000_initial_conduit` (unix time 1775779696 = 2026-03-07T...)
- **Row counts**: conversations=0, messages=0, delivery_jobs=0, dead_letters=0, message_pins=0 — **completely empty**
- **Birth**: 2026-04-09 17:08 (matches T310 migration era)
- **Last modify**: 2026-04-17 13:56 (today — something reopened it)
- **Conclusion**: orphan. Freshly re-created by an errant `getProjectRoot()` resolution from `$HOME`. Safe to delete.

### 2B. CI workflow green baseline

- `biome` job — green as of v2026.4.85 (51971cd4a).
- `typecheck` job — green.
- `unit-tests` — 8664 tests pass, 0 failures, 0 regressions per v2026.4.85 commit message.
- `build-verify` — all 12 required dist files assertable.
- `install-test` — green; `cleo init` + `cleo --help` + `cleo --mcp-server` all pass.
- `forge-ts-check` — `continue-on-error: true` — does NOT block releases today. T903 may tighten this by adding forge-ts rules for CANT v3.
- `lockfile-consistency` — green post v2026.4.84 fix.
- `release` — last green run published v2026.4.85 to all 12 npm packages.

### 2C. Release pipeline gotchas

1. **CalVer strict check** (`release.yml:87-93`): stable releases MUST match current month. If any wave slips to May, the month-boundary version must be a pre-release (`v2026.5.0-rc.1`) until May 1 hits.
2. **Idempotent re-runs** (`release.yml:382-391`): `already_published()` prevents the "cannot publish over" race. Safe to re-trigger the workflow via `workflow_dispatch`.
3. **CHANGELOG gate** (`release.yml:201-211`): the exact pattern `## [<VERSION>]` must be in `CHANGELOG.md`. Missing → publish aborts. No whitespace tolerance.
4. **Tarball file presence** (`release.yml:150-175`): `@cleocode/core` must include `dist/store/nexus-sqlite.js` + `dist/store/brain-sqlite.js` + 4 other .js files. Wave C/D additions (playbooks) must not cause tsc to re-cache without emitting .js.
5. **Dependency publish order** (`release.yml:437-448`): contracts → lafs → core → caamp → cant → nexus → runtime → adapters → agents → skills → cleo → cleo-os. **Insert `playbooks` between `runtime` and `adapters`** for Wave D (playbooks depends on cant + core, depended on by cleo).
6. **OIDC trusted publishing**: no `NPM_TOKEN` secret. If a new package (`@cleocode/playbooks`) is created in Wave D, npmjs.com MUST be configured with trusted publisher BEFORE the tag is pushed — otherwise the publish step fails with 401/403 and the tag becomes stale.

---

## 3. PER-TASK TEST PLAN (all 20 tasks)

Format: `T###: <test type> → <specific real inputs> → <specific real assertions>`

- **T890** (orchestrate plan): **integration** → real `cleo orchestrate plan T<seededEpic>` via `execFileSync` against tmpdir `CLEO_ROOT` with 5-task fixture epic → assert `data.waves.length >= 1`, each wave has `lead.taskId` + `workers[].atomicScope.files`, LAFS-compliant envelope, deterministic `requestId`-excluded hash stable across 3 runs.
- **T891** (classify → .cant → spawn payload): **integration** → real registry DB + 5 .cant fixtures in tmp `.cleo/agents/` + 1 missing-persona task → assert `composeSpawnPayload` returns `{persona, model, tools[], skills[]}` matching .cant for 5 cases, falls back to generic with `confidence < 0.5` warning for case 6.
- **T892** (auto-tier selection): **unit** → pure function `selectTier(task, role)` with 3×3 matrix (role × size) + override cases → assert: orchestrator→2, lead→1, worker→0, size=large bumps +1, labels includes 'research' bumps +1, manual `--tier N` wins.
- **T893** (AGENTS.md dedup): **snapshot** → real `buildSpawnPrompt({harnessContextHint: 'claude-code'|'generic'|'bare'})` → assert tier-1 claude-code prompt size < 6000 chars, generic > 13000 chars, bare > 15000 chars; `--embed-injection` forces embed.
- **T894** (atomicity): **unit + integration** → `validateAtomicity(task, 'worker')` with tasks having AC.files=0, 3, 4, missing → assert E_ATOMICITY_VIOLATION for 0/4/missing, pass for 3; spawn CLI with worker + 4-file task rejects with fix hint string containing "split into subtasks".
- **T895** (hoist Task section): **snapshot** → real `buildSpawnPrompt` output → assert first 500 chars contains `T###` + task title; snapshot diff committed for tier 0/1/2.
- **T896** (docs): **filesystem + mermaid-render** → assert `docs/architecture/orchestration-flow.md` exists, contains all 6 layer names, cross-links to ADRs 041/044/049/051 resolve to real files, mermaid block parses via `@mermaid-js/parser` (or fallback: regex for valid `graph TD` syntax).
- **T897** (seed auto-install): **integration** → `execFileSync('node', ['packages/cleo/dist/cli/index.js', 'agent', 'seed', 'install'])` in tmp `$HOME` with fixture seeds → assert 6 files appear in `$HOME/.local/share/cleo/cant/agents/`, 6 rows in signaldock.db `agents` table at global tier, re-run is idempotent (same count), `--force` overwrites.
- **T898** (registry-backed resolution): **integration** → real signaldock.db populated with 3 global + 2 project agents → assert `classify(task)` returns registry row source=project when project row present, =global when only global, =fallback when neither; `cleo agent detach X` followed by `cleo orchestrate spawn T### --agent X` returns `E_AGENT_NOT_FOUND`.
- **T899** (tier precedence): **integration** → populate all 4 tiers with identically-named `cleo-dev` agent → assert `resolveByAgentId('cleo-dev')` returns project first, then global after detach, then packaged after global-remove, then `cleo-subagent` fallback.
- **T900** (install/attach/spawn integration): **e2e** → full cycle: `cleo agent install fixture.cant` → `cleo agent list` shows row → `cleo orchestrate spawn T### --agent x` succeeds → `cleo agent detach x` → spawn fails E_AGENT_NOT_FOUND → `cleo agent attach x` → spawn succeeds → `cleo agent remove x` → disk file + row gone.
- **T901** (agent doctor): **integration** → seed 4 drift scenarios (orphan file, orphan row, hash mismatch, unattached global) → assert each reported with exit code non-zero, `--repair` fixes each, re-run reports zero drift.
- **T902** (dynamic skill composition): **integration** → real `packages/skills/skills/` library + agent with `skills: [ct-cleo]` + task labeled `docs` → assert `composeSkillBundle` returns bundle with both `ct-cleo` + `ct-docs-lookup`, precedence-deduped, totalTokens ≤ tier budget (500/2000/5000), `loadMode` flag set per skill.
- **T903** (CANT DSL v3): **unit + integration** → real v2 fixture + real v3 fixture with `requires`/`ensures`/`mental_model` → assert v2 parses with empty contracts (backward compat), v3 parses with populated schema; `cleo agent migrate --to-v3` is idempotent; forge-ts rule fails CI when a `.cant` has `prompt: "TODO"` (seed-agent fix visible).
- **T904** (Playbook DSL): **e2e** → real `packages/playbooks/rcasd.cantbook` file + tmpdir DB → `cleo playbook run rcasd --input taskId=T<fixture>` executes 5 RCASD stages, `playbook_runs` table has row with status='completed', stderr-injection into agentic node triggers on 1 simulated failure (iteration cap ≤3 prevents infinite loop).
- **T905** (seed-agent unification): **structural** → assert only ONE canonical dir (`packages/agents/seed-agents/`), zero files in `packages/cleo-os/seed-agents/`, `.cleo/cant/agents/` merged into `.cleo/agents/` in project, `cleo agent doctor` reports zero duplication post-migration, `cleo-prime` aliased where `cleoos-opus-orchestrator` was.
- **T906** (agent_skills table): **integration** → real signaldock.db, `cleo skills install ct-cleo --agent cleo-dev` → row in agent_skills → `composeSkillBundle` returns ct-cleo in bundle → `cleo skills uninstall ct-cleo --agent cleo-dev` → row removed → bundle no longer contains it.
- **T907** (thin-agent enforcement): **unit (parse) + integration (runtime)** → .cant fixture with `role: worker` + `tools: [Agent]` → parser rejects with E_PERMISSION_CONFLICT; worker spawn payload omits Agent/Task from allowed-tools; attempt to invoke `cleo agent spawn` with worker role returns E_THIN_AGENT_VIOLATION with escalation hint.
- **T908** (HITL resume tokens): **e2e** → real playbook with `requires_approval: true` node → `cleo playbook run` returns `{status: 'needs_approval', resumeToken: <hash>}` → `cleo orchestrate approve <runId> --token <t>` unblocks → re-run continues; reject cycle halts; auto-policy bypasses for allowlisted commands.
- **T909** (conduit.db topology audit): **integration** → seed `$HOME/.cleo/conduit.db` with zero rows in tmp $HOME → `cleoos doctor` detects and offers migration → `cleo repair orphan-conduit` moves to `.bak`, logs to audit file; doc `docs/architecture/database-topology.md` exists with correct tier assignments.

---

## 4. ROLLOUT SEQUENCING (FINAL)

```
Wave A → v2026.4.86 → commit 1 tag 1 publish 1
  Tasks: T905 (seed unification) + T909 (conduit audit) + T897 (seed auto-install) + T903 (CANT v3 types)
  Why first: establishes canonical sources and kills drift before later waves add more surface.
  Dependencies resolved: none (foundation).
  Rollback plan: revert commit on main, force-delete tag v2026.4.86, publish v2026.4.86 is a no-op on npm (already_published check); next wave uses v2026.4.87.

Wave B → v2026.4.87 → commit 2 tag 2 publish 2
  Tasks: T898 (registry resolution) + T899 (tier precedence) + T906 (agent_skills table) + T900 (install/attach wiring) + T901 (doctor)
  Why second: registry becomes authoritative before spawn consults it in Wave C.
  Dependencies: Wave A (seed-agents available, CANT v3 types).
  Rollback plan: revert commit, T898 fallback path (fs-scan) still works because Wave A did not remove it.

Wave C → v2026.4.88 → commit 3 tag 3 publish 3
  Tasks: T890 (orchestrate plan) + T891 (classify → spawn) + T892 (auto-tier) + T893 (AGENTS.md dedup) + T894 (atomicity) + T895 (hoist task)
  Why third: spawn path now wired to registry + .cant + tier selector. May deprecate T882 spawn-prompt.ts (research phase decides — if so, BREAKING callout in CHANGELOG).
  Dependencies: Wave B (registry), Wave A (CANT v3 types).
  Rollback plan: revert; orchestrator reverts to hand-rolled flow (current v2026.4.85 behavior).

Wave D → v2026.4.89 → commit 4 tag 4 publish 4 (may introduce new @cleocode/playbooks package)
  Tasks: T902 (dynamic skills) + T904 (Playbook DSL) + T907 (thin-agent) + T908 (HITL resume) + T896 (architecture docs)
  Why last: net-new primitives, highest risk, depends on all prior waves.
  Dependencies: Wave C (spawn path), Wave A (CANT v3).
  Rollback plan: revert; playbooks package remains on npm (cannot unpublish) but `cleo playbook` command gone; users fall back to hand-rolled execution.
```

Each wave requires:
1. All quality gates green (biome, typecheck, tests, build, lockfile).
2. CHANGELOG section authored.
3. `node scripts/version-all.mjs --set <ver>` run.
4. Commit on main.
5. Tag pushed.
6. `release.yml` succeeds (watch for OIDC + changelog gate).
7. `pnpm dlx @cleocode/cleo@<ver> --version` returns target.
8. Wave-specific smoke (§1C) runs.
9. `cleo memory observe "Wave X of T889 shipped v<ver>"` recorded.

---

## 5. RISK SURFACE

### High-risk tasks (require extra test depth)

| Task | Risk category | Why | Mitigation |
|---|---|---|---|
| T903 CANT DSL v3 | Parser breaking change | Every existing .cant file re-parses; malformed schema could cascade-break spawn | Backward-compat fixture bank (every seed .cant + every project .cant checked in CI); migration command is idempotent with dry-run mode |
| T904 Playbook DSL | Net-new primitive, new DB table | No existing code to regress against; new package publish | Dedicated test package `packages/playbooks/__tests__/` with 10+ scenarios; dry-run mode for `cleo playbook run`; schema versioning from day 1 |
| T905 Seed-agent unification | Deletes directories | Any external consumer importing `@cleocode/cleo-os/seed-agents/` breaks | Deprecation cycle: Wave A ships re-exports + warning, Wave B/C/D leaves them. Actual delete deferred to next epic or gated behind major version bump |
| T898 Registry resolution | Hot-path refactor | Current fs-scan works; new DB query path is untested at scale | Parallel implementation with feature flag; both paths shipped in Wave B, fs-scan removed only after 1-week soak at v2026.4.87 |
| T907 Thin-agent enforcement | Hard runtime rejection | Existing .cant files may have `Agent` tool on workers (seen in audit?) | Pre-flight scan: Wave A includes `cleo agent doctor --report-only` that identifies violators; Wave D enforcement only after all detected violators fixed |
| T909 Conduit.db topology | FS side effect on `$HOME` | Could delete user data if wrongly identified as orphan | Three-phase migration (detect → backup-not-delete → confirm prompt); audit log; rollback = rename backup |

### Install-latest verification — what success looks like per wave

- **Wave A**: `pnpm dlx @cleocode/cleo@2026.4.86 init tmp-proj && cd tmp-proj && cleo agent list --global` shows exactly 6 canonical seeds, zero `.cant` files in `packages/cleo-os/seed-agents/` inside `node_modules`.
- **Wave B**: `cleo agent doctor` reports zero drift; `cleo agent install <fixture.cantz>` + `cleo orchestrate spawn T### --agent fixture` produces a persona-specific prompt.
- **Wave C**: `cleo orchestrate plan <fixture-epic>` returns deterministic JSON waves; prompt size for tier-1 claude-code spawn drops below 6000 chars.
- **Wave D**: `cleo playbook run rcasd --input taskId=T<fixture>` exits 0, writes `playbook_runs` row; `cleo orchestrate pending` lists the approval token gate.

### Rollback plan per wave

1. Identify breakage via failing install-verify.
2. `git revert <wave-commit>` on main; create `v2026.4.<next>` with revert.
3. npm packages from failed wave remain published (cannot unpublish within 72 hours without disputes policy); users who installed can `pnpm dlx @cleocode/cleo@2026.4.<prior>` to pin back.
4. `cleo memory observe "Wave X rolled back: <reason>" --title "T889 Wave X rollback"`.

### Test runtime estimate

- Today's baseline: 8664 tests pass in ~80-120s (sharded 2×).
- T889 additions: ~150-200 new tests across all tasks (conservative).
- Expected Wave D runtime: ~140-180s sharded 3×. Well under the 10-minute CI job timeout.

---

## 6. TOP 3 RISKS + MITIGATIONS

### Risk 1 — CalVer month boundary

**Risk**: Any wave slipping past 2026-04-30 forces a month bump to `v2026.5.0`. `release.yml` stable-release CalVer gate will REJECT `v2026.4.90` tagged on 2026-05-01.

**Mitigation**:
- Lock wave cadence: one wave per 2-3 days = all 4 waves in 8-12 days, done by 2026-04-29.
- If slippage appears inevitable by 2026-04-25, switch the remaining waves to pre-releases (`v2026.5.0-rc.1`, `-rc.2`) with `dist-tag: beta`, then final `v2026.5.0` on May 1.
- Do NOT attempt a late-April `v2026.5.0` tag — CalVer gate rejects future months for stable.

### Risk 2 — Publish-pipeline breakage from new `@cleocode/playbooks` package

**Risk**: Wave D introduces a new package. `release.yml:117` has a hardcoded package list; missing the new entry means the package.json version stays stale and `cannot publish over` errors cascade. Also, npm Trusted Publishing (OIDC) requires pre-configuration on npmjs.com per package.

**Mitigation**:
- Ship the package scaffolding (package.json + minimal index.ts + `publishConfig: { access: "public" }`) in Wave A as a **type-only stub** — gets it configured on npm + added to release.yml + versioned alongside everyone else well before it has real code.
- Wave D only ADDS code to the already-published skeleton, never introduces the package.json for the first time mid-epic.
- Pre-configure trusted publisher on npmjs.com for `@cleocode/playbooks` during Wave A review (human step — requires maintainer login).

### Risk 3 — Real-test policy regression via inherited test fixtures

**Risk**: 20 new tasks means 150+ new tests. Authors under time pressure inline `vi.mock('@cleocode/core/store/...')` to skip DB setup. One slip per wave = 4 fake-test leaks into the release baseline. Over time this erodes the "REAL tests" invariant that T889 depends on for correctness.

**Mitigation**:
- Add a biome rule (or a custom forge-ts rule, or a grep-gate in `ci.yml`) that flags `vi.mock(` calls targeting `@cleocode/*` modules in test files. Only `vi.mock('node:fs')` or `vi.mock('child_process')` (external collaborators) permitted.
- Enforce at `ci.yml` biome-or-custom-step level — new grep-gate in the existing biome job or a new 30-second `test-policy-check` job.
- Per-PR reviewer checklist: every test file touched must show either a `mkdtempSync` fixture OR inherit from an existing real-DB harness (`packages/core/src/store/__tests__/t310-readiness.test.ts` pattern).
- Once-per-wave spot-audit: pick 3 random new tests, verify they create a real DB, read the data back, and close the handle. Audit output to `.cleo/agent-outputs/T889-orchestration/real-test-audit-WaveX.md`.

---

## Appendix A — Full list of FILES INSPECTED during research

- `/mnt/projects/cleocode/package.json`
- `/mnt/projects/cleocode/.cleo/project-context.json`
- `/mnt/projects/cleocode/.github/workflows/ci.yml`
- `/mnt/projects/cleocode/.github/workflows/release.yml`
- `/mnt/projects/cleocode/.github/workflows/lockfile-check.yml`
- `/mnt/projects/cleocode/packages/core/src/paths.ts` (lines 240-346)
- `/mnt/projects/cleocode/packages/core/src/store/conduit-sqlite.ts` (lines 290-415)
- `/mnt/projects/cleocode/packages/core/src/upgrade.ts` (lines 1440-1486)
- `/mnt/projects/cleocode/packages/cleo/src/cli/paths.ts`
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/engines/release-engine.ts` (lines 1-120)
- `/mnt/projects/cleocode/biome.json`
- `/mnt/projects/cleocode/CHANGELOG.md` (first 80 lines)
- `/mnt/projects/cleocode/scripts/version-all.mjs`
- Empirical: `sqlite3 ~/.cleo/conduit.db .schema` + row counts across all tables
- Empirical: `sqlite3 /mnt/projects/cleocode/.cleo/conduit.db .tables` + row counts
- Empirical: `git tag --sort=-v:refname | head -20`, `git log --oneline -10`
- Empirical: `stat ~/.cleo/conduit.db` for modify-time evidence
- CLI: `cleo show T889 --format json`, `cleo list --parent T889 --format json` (all 20 tasks)
