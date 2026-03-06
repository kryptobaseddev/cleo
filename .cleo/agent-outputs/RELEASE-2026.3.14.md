# Release 2026.3.14 — Release Manager Tracker

**Status**: IN PROGRESS
**Target version**: `2026.3.14`
**npm dist-tag target**: `@latest`
**Branch of origin**: `chore/validate-ci-protection`
**Beta cycle**: `2026.3.13-beta.1` (npm), `2026.3.13-beta.2` (staged)
**Commits in release**: 51 (from `368d350c` to `d0f42a76`)

---

## Release Manager Checklist

### Phase 1 — Changelog & Version Prep
- [x] Write comprehensive `2026.3.14` CHANGELOG entry
- [x] Update `package.json` version to `2026.3.14`
- [x] Update version references in `src/`, `docs/`, `schemas/` as needed
  - `src/config/build-config.ts` ✓
  - `docs/BUILD-CONFIG.md` ✓
- [ ] Final test suite run and confirm 0 failures

### Phase 2 — Branch & PR Flow
- [ ] PR: `chore/validate-ci-protection` → `develop`
- [ ] Merge develop, resolve any conflicts
- [ ] PR: `develop` → `main` (the stable promotion)
- [ ] CI passes on both PRs

### Phase 3 — Release Tag & Publish
- [ ] Tag `v2026.3.14` on `main`
- [ ] `npm publish --tag latest`
- [ ] Verify `npm view @cleocode/cleo dist-tags` shows `latest: 2026.3.14`
- [ ] GitHub release created with release notes

---

## Commit Inventory (51 commits since `main`)

### MAJOR FEATURES

| Commit | Description | Task |
|--------|-------------|------|
| `1191c675` | Warp protocol chains, BRAIN phase scaffolding, hook infrastructure | T5373 |
| `99daa1ae` | Complete sharing→nexus restructure and sticky domain implementation | T5267-T5275, T5276 |
| `15d2dcd8` | Finalize canon synthesis and sticky workflows | T5261 |
| `b3726738` | Add sticky.archive.purge operation for permanent deletion | T5363 |
| `5001a127` | Memory domain refactor — clean break from legacy aliases | T5241 |
| `e9cf32d6` | Unified audit logging architecture | T5318 |
| `5e1569ab` | CLI-to-dispatch migration progress | T5323 |
| `2257c501` | CLI dispatch compliance, verb standards overhaul, wire cancel + unlink | T5323 |
| `c022e266` | Add handoff composite op to orchestrate domain | T5347 |
| `ab2c69cb` | Expose analysis queries in nexus domain | T5348 |
| `32fd8494` | Add centralized build config system and package issue templates | — |
| `11f33101` | Add CI parity gate + fix nexus test SQLite migration | T5251 |
| `4e756c4e` | Startup instrumentation and logging contract docs | T5284 |
| `93d4b396` | Beta hardening and spawn adapters | T5253 |

### REFACTORS / ZERO-LEGACY

| Commit | Description | Task |
|--------|-------------|------|
| `7057d3f5` | Canonicalize MCP gateway domain validation to 10 domains | T5246 |
| `c3dc4df6` | Remove 5 legacy alias operations from dispatch layer | T5245 |
| `d08bc66c` | Remove legacy aliases from CLI command surface | T5249 |
| `9fbbb707` | Canonicalize sticky storage | T5267 |
| `f3a04c4f` | Remove runtime legacy JSON task paths | T5284 |
| `5d761f01` | Decommission runtime JSONL log fallbacks | T5317 |
| `bdb54e4a` | Decommission legacy migration imports | T5305 |
| `89fc3318` | Remove dead todo migration script | T5303 |
| `2257c501` | CLI dispatch compliance, verb standards overhaul | T5323 |
| `839a73c6` | Drop unused logOperation path arg | T4460 |
| `b70fb932` | Migrate 21 test files from tasks.json fixtures to tasks.db | — |

### FIXES

| Commit | Description | Task |
|--------|-------------|------|
| `2f8a7805` | Remove 32 maxActiveSiblings limit default | T5413 |
| `b26bc455` | Include drizzle-brain in npm package, stabilize CI performance | T5319, T5311 |
| `715aa233` | Wire logs cleanup to prune | T5339 |
| `a1bfe3c3` | Add audit_log checks to health | T5338 |
| `46e23674` | Migrate MCP startup errors to logger | T5336 |
| `9ce47dfd` | Pass projectHash to logger init | T5335 |
| `48d55404` | Decouple runtime migration path | T5305 |
| `6ca998e6` | Reconcile tasks.json checks in upgrade | T5299 |
| `2125ea5d` | Remove marker debt and add active gate | T5320-T5322 |
| `80da29ad` | Resolve stale test assertions and SQLite regression in inject-generate | T5298 |
| `517e52e4` | Update error messages — tasks.json to tasks database | T5298 |
| `17665552` | Eliminate critical tasks.json legacy references | T5293-T5297 |
| `59034d0e` | Stabilize hooks and SQLite fixtures | T5317 |
| `55ad90de` | Migrate release engine tests from todo.json to SQLite | T5251 |

### CHORES / DOCS

| Commit | Description | Task |
|--------|-------------|------|
| `d0f42a76` | Remove cleo_ prefix from MCP tool names in code and docs | T5507 |
| `6fe98169` | Remove marker literals from policy docs | T5349 |
| `86bd2a4e` | Sync nexus ops table in spec | T5350 |
| `2df6e29c` | Drop cleo_ prefix from MCP gateway names in docs | T5361 |
| `a8ac8415` | Canonicalize Tessera ops in framework docs | T5346 |
| `e9bc6fa7` | Align ADR-019 amendment link | T5340 |
| `20fd28dd` | Add cleanup matrix and retire dead-script refs | T5317 |
| `4e85006e` | Align Constitution and VERB-STANDARDS to post-T5245 reality | T5250 |
| `ad78edb6` | Add 2026.3.13-beta.2 unreleased changelog entry | T5244 |
| `07d32642` | Update registry domain counts after T5245 alias removal | T5244 |
| `7b5dacfc` | Harden process and canon ops | T5253 |
| `ba4c09e1` | Validate branch protection CI | T5253 |
| `368d350c` | Sync develop with main v2026.3.12 | T5243 |

---

## Feature Theme Summary (for changelog narrative)

### Theme 1: Warp + BRAIN Reality (T5373)
The single largest commit in this cycle. Includes:
- Warp protocol chains — unyielding structural synthesis of composable workflow shape and LOOM quality gates
- Full hook infrastructure — session/task-work event dispatch wired end-to-end
- BRAIN Phases 1-2 shipped in earlier releases (native brain.db + retrieval baseline)
- BRAIN Phase 3 scaffolding landed (SQLite-vec extension loading, PageIndex graph tables), but semantic/vector intelligence is gated
- BRAIN Phases 4-5 remain planned and are not shipped in this release

### Theme 2: Sticky Notes Domain (T5267-T5275, T5261, T5363)
Complete sticky notes system:
- Moved from tasks.db → brain.db `brain_sticky_notes`
- Full MCP sticky domain (create, find, show, pin, archive, purge)
- Canon synthesis workflow for cross-session context
- `sticky.archive.purge` for permanent deletion

### Theme 3: Zero-Legacy Compliance Closure (T5244-T5251)
Hard cutover away from all legacy interfaces:
- 5 backward-compat alias ops removed from dispatch
- Legacy domain names now return E_INVALID_DOMAIN
- Legacy CLI aliases removed (reopen, unarchive, search)
- 207 canonical operations (was 212)
- Parity gate CI enforces canonical counts

### Theme 4: Unified Audit Logging (T5318, T5317)
Structured logging throughout the stack:
- Unified audit log architecture
- Startup instrumentation
- JSONL log fallbacks removed — SQLite-only
- Logs cleanup wired to prune lifecycle

### Theme 5: CLI-to-Dispatch Migration Progress (T5323)
Partial parity progress between CLI and MCP via dispatch layer:
- Key commands moved to dispatch and coverage expanded
- Cancel + unlink wired through
- Verb standards overhaul enforced
- Remaining phase work stays open for next cycle

### Theme 6: Sharing → NEXUS Restructure (T5276)
- All `sharing.*` operations moved to `nexus.share.*`
- NEXUS analysis queries exposed
- Orchestrate handoff composite op added

### Theme 7: Memory Domain Clean Break (T5241)
- Search → Find verb cutover
- All legacy aliases removed
- brain.* → memory.* op naming finalized

### Theme 8: MCP Tool Naming (T5507)
- `cleo_query` / `cleo_mutate` → `query` / `mutate` throughout all docs, tests, configs

### Theme 9: Storage & Migration Hardening
- drizzle-brain included in npm package (T5319)
- All tasks.json runtime paths removed (T5284)
- Legacy migration imports decommissioned (T5305)
- 21 test files migrated from tasks.json fixtures to tasks.db

### Theme 10: maxActiveSiblings Limit Removed (T5413)
- The 32 sibling limit default removed — no artificial cap

---

## Breaking Changes for Release Notes

1. **MCP clients**: `cleo_query`/`cleo_mutate` → `query`/`mutate` (T5507)
2. **MCP clients**: `admin.config.get` → `admin.config.show`
3. **MCP clients**: `tasks.reopen` → `tasks.restore`
4. **MCP clients**: `tools.issue.create.*` → `tools.issue.add.*`
5. **MCP clients**: `sharing.*` → `nexus.share.*` (T5276)
6. **MCP clients**: Non-canonical domain names now return `E_INVALID_DOMAIN` (T5246)
7. **CLI**: `restore --reopen/--unarchive/--uncancel` aliases removed (T5249)
8. **CLI**: `find --search` alias removed (T5249)
9. **Storage**: tasks.json runtime paths removed — SQLite only (T5284)
10. **Storage**: JSONL log fallbacks removed — structured logger only (T5317)
11. **Hierarchy**: 32 maxActiveSiblings default removed — unlimited (T5413)

---

## Notes from Release Manager

- The `2026.3.13-beta.2` changelog section should be absorbed into `2026.3.14` stable entry
- Version bump: `package.json` + any other version files (check `dev/version-sync.ts` config)
- The `chore/validate-ci-protection` branch name doesn't reflect the content — the PR title should be descriptive
- CI parity gate (`tests/integration/parity-gate.test.ts`) must pass before merge
- Confirm `drizzle-brain/` migrations are included in npm package (T5319 fix is on this branch)

---

## Release Progress Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-03-06 | Release manager initialized | 51 commits inventoried, themes identified |
| 2026-03-06 | Phase 1 complete | CHANGELOG written, package.json + build-config.ts + docs/BUILD-CONFIG.md bumped to 2026.3.14 |
