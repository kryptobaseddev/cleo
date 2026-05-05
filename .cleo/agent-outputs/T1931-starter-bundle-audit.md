# T1931: Starter-Bundle Caller Audit

**Date**: 2026-05-05
**Task**: T1931 — Audit all callers of starter-bundle, resolveStarterBundle, cleo-orchestrator.cant, team.cant before deletion
**Epic**: T1929 (Agent System Canonicalization v2)
**ADR**: ADR-068
**Status**: Complete — verdict GREEN

---

## Section A — `starter-bundle` Source-Tree References

Files containing `starter-bundle`, `starterBundle`, `STARTER_BUNDLE`, or `starter_bundle` (source only, excluding `dist/` and `node_modules/`).

| # | File | Lines | Type | Notes |
|---|------|-------|------|-------|
| A1 | `packages/agents/package.json` | 9–10 | config | `files[]` array lists `"seed-agents/"` and `"starter-bundle/"` |
| A2 | `packages/agents/meta/playbook-architect.cant` | 47 | source | Doc string: `@cleocode/agents starter-bundle` (comment only) |
| A3 | `packages/agents/tests/starter-bundle.test.ts` | 45–46, 130–680 (entire file) | test | Full test suite for starter-bundle structure, team.cant, and agent files |
| A4 | `packages/cleo/src/cli/commands/agent.ts` | 2408, 2418, 3033–3044 | source | JSDoc `@see` references to `packages/cleo-os/starter-bundle/…` (comment only; stale path) |
| A5 | `packages/cleo-os/src/postinstall.ts` | 273–292, 300–331 | source | `resolveStarterBundleSrc()` local helper + `copyStarterBundle()` function copies team.cant + agents |
| A6 | `packages/core/src/scaffold.ts` | 1949, 1953, 1965, 1975–1982, 1995 | source | Calls `resolveStarterBundleIdentityFile()`; hardcodes `'starter-bundle'` in candidate path array |
| A7 | `packages/core/src/upgrade.ts` | 924, 927, 930, 937 | source | Calls `deployStarterBundle()` (dynamic import from `./init.js`); uses `action: 'cant_starter_bundle'` string constant |
| A8 | `packages/core/src/init.ts` | 1226–1302 | source | Defines `deployStarterBundle()` export; calls `resolveStarterBundle()`; copies team.cant + agents to `.cleo/cant/` |
| A9 | `packages/core/src/agents/resolveStarterBundle.ts` | entire file | source | Defines `resolveStarterBundle()`, `resolveStarterBundleAgentsDir()`, `resolveStarterBundleTeamFile()`, `resolveStarterBundleIdentityFile()` |
| A10 | `packages/core/src/agents/seed-install.ts` | 15, 22, 35, 164–176, 352–412, 754–855 | source | Calls `resolveStarterBundle()` for bundle resolution; defines `buildStarterBundleTuples()`; handles legacy cleo-os/starter-bundle path migration |
| A11 | `packages/core/src/store/agent-doctor.ts` | 300, 309–310 | source | `reroute` doctor check references legacy starter-bundle path (comment + string literal in subject field) |
| A12 | `packages/core/src/agents/__tests__/seed-install-meta.test.ts` | 140 | test | Comment: `// Post-T1241: seed-install reads from packages/agents/starter-bundle/` |
| A13 | `docs/adr/ADR-055-agents-architecture-and-meta-agents.md` | 269, 274, 279–281, 309–310 | doc | Historical context for D035 starter-bundle relocation; describes new path |

**Physical directory contents to be deleted by T1932:**
- `packages/agents/starter-bundle/` (4 agent `.cant` files + `team.cant` + `README.md` + `CLEOOS-IDENTITY.md`)
  - `agents/cleo-orchestrator.cant`
  - `agents/code-worker.cant`
  - `agents/dev-lead.cant`
  - `agents/docs-worker.cant`
  - `team.cant`
  - `README.md`
  - `CLEOOS-IDENTITY.md`

---

## Section B — `resolveStarterBundle` Callers

Every caller of any function exported from `packages/core/src/agents/resolveStarterBundle.ts`.

| # | Caller File | Line(s) | Function Called | Purpose |
|---|-------------|---------|-----------------|---------|
| B1 | `packages/core/src/agents/index.ts` | 103–108 | re-exports all 5 functions | Public API surface: `resolveMetaAgentsDir`, `resolveStarterBundle`, `resolveStarterBundleAgentsDir`, `resolveStarterBundleIdentityFile`, `resolveStarterBundleTeamFile` |
| B2 | `packages/core/src/agents/invoke-meta-agent.ts` | 27, 214 | `resolveMetaAgentsDir()` | Locates the `meta/` directory (agent-architect.cant etc.) for meta-agent invocation |
| B3 | `packages/core/src/agents/seed-install.ts` | 53, 176, 822 | `resolveStarterBundle()` | Resolves bundle root for file enumeration and legacy reroute migration |
| B4 | `packages/core/src/init.ts` | 1253–1254 | `resolveStarterBundle()` | Dynamic import; gets bundle root to call `deployStarterBundle()` |
| B5 | `packages/core/src/scaffold.ts` | 1975–1982 | `resolveStarterBundleIdentityFile()` | Dynamic import via `req.resolve()`; copies CLEOOS-IDENTITY.md to project during scaffold |
| B6 | `packages/core/src/playbooks/agent-dispatcher.ts` | 135, 175 | `resolveMetaAgentsDir()` (local copy) | **Note**: agent-dispatcher defines its OWN local `resolveMetaAgentsDir()` function — does NOT import from resolveStarterBundle.ts |

**Note on B6**: `packages/core/src/playbooks/agent-dispatcher.ts` has a local duplicate of `resolveMetaAgentsDir()` (line 135). It does NOT import from `resolveStarterBundle.ts`. This is a pre-existing DRY violation but is not directly affected by the deletion. T1935 should flag this for cleanup.

**Note on `resolveMetaAgentsDir`**: This function resolves `packages/agents/meta/` (NOT the starter-bundle directory). The `meta/` directory is NOT being deleted. Callers of `resolveMetaAgentsDir` (B2, B6) are therefore NOT impacted by starter-bundle deletion.

**Functions to rename per ADR-068 / T1935:**
- `resolveStarterBundle()` → `resolveAgentTemplates()` (deprecated re-export preserved)
- `resolveStarterBundleAgentsDir()` — to be superseded (templates/ has flat layout, no subdirectory)
- `resolveStarterBundleTeamFile()` — to be deleted (team.cant is deleted; no replacement)
- `resolveStarterBundleIdentityFile()` — to be assessed (CLEOOS-IDENTITY.md is in starter-bundle; may need separate resolution)

---

## Section C — `cleo-orchestrator.cant` and `team.cant` References

| # | File | Line(s) | Context | Note |
|---|------|---------|---------|------|
| C1 | `packages/agents/starter-bundle/agents/cleo-orchestrator.cant` | 9 | `agent cleo-orchestrator:` | The file being deleted |
| C2 | `packages/agents/starter-bundle/team.cant` | 11 | `orchestrator: cleo-orchestrator` | The team manifest being deleted |
| C3 | `packages/agents/starter-bundle/agents/dev-lead.cant` | 11 | `parent: cleo-orchestrator` | Being deleted with starter-bundle |
| C4 | `packages/agents/tests/starter-bundle.test.ts` | 111, 119, 166–189, 253–262, 297–299, 400–548, 610–658 | `STARTER_BUNDLE`, `team.cant`, `cleo-orchestrator.cant` refs throughout | Entire test file tests the starter-bundle being deleted |
| C5 | `packages/cleo/src/cli/commands/agent.ts` | 3041, 3158 | JSDoc `@see` + `parent: cleo-orchestrator` default in `generateLeadPersona()` | **REGISTRY CONFLICT**: `generateLeadPersona()` hardcodes `parent: cleo-orchestrator` as default. The canonical orchestrator is now `project-orchestrator`. |
| C6 | `packages/cleo/src/cli/commands/agent.ts` | 3041–3044 | JSDoc `@see packages/cleo-os/starter-bundle/agents/cleo-orchestrator.cant` | Stale `@see` reference to deleted file |
| C7 | `packages/core/src/agents/seed-install.ts` | 359, 849 | `cleo-orchestrator.cant` in comment + string extraction logic | Comment reference only; the logic handles any agent file via path manipulation |
| C8 | `packages/core/src/hooks/handlers/conduit-hooks.ts` | 26 | `const SYSTEM_AGENT_ID = 'cleo-orchestrator'` | **REGISTRY CONFLICT**: This constant hard-codes `cleo-orchestrator` as the system agent ID for conduit lifecycle messages. The canonical agent is `project-orchestrator`. This is a semantic dependency on the name, not the file path. |
| C9 | `packages/core/src/hooks/handlers/__tests__/conduit-hooks.test.ts` | 117, 276 | `expect(msg.from).toBe('cleo-orchestrator')` | Test asserts on SYSTEM_AGENT_ID; follows C8 |
| C10 | `packages/adapters/src/__tests__/cant-context.test.ts` | 50, 56, 127 | `writeFileSync(join(cantDir, 'team.cant'), ...)` | Test creates its own synthetic `team.cant`; not reading from starter-bundle |
| C11 | `packages/cleo-os/src/postinstall.ts` | 283–331 | Copies `team.cant` from starter-bundle to user's install | Entire `copyStarterBundle()` function references team.cant and the bundle |
| C12 | `packages/core/src/init.ts` | 1266–1268 | Copies `team.cant` from `starterBundleSrc` to `cantDir` | Part of `deployStarterBundle()` |
| C13 | `packages/core/dist/agents/resolveStarterBundle.d.ts` | 60, 77–80 | JSDoc mentions team.cant | Dist file (auto-generated; will update when source changes) |
| C14 | `docs/adr/ADR-055-agents-architecture-and-meta-agents.md` | 280 | Historical description of team.cant layout | Superseded by ADR-068; doc annotation only |
| C15 | `docs/guides/CREATING-CUSTOM-AGENTS.md` | 172 | `platform-team.cant` example (NOT `team.cant` from starter-bundle) | Different file; coincidental naming; no dependency |
| C16 | `docs/specs/cleo-scaffolding-ssot-spec.md` | 119 | `team.cant` in runtime directory table | Runtime description, not a code reference |

**Classifier check (ADR-068 § Subsystem 1):**
- `packages/core/src/orchestration/classify.ts` lines 135–140: emits `project-orchestrator`, NOT `cleo-orchestrator`. No registry conflict in the classifier itself.
- The registry conflict is in **conduit-hooks.ts** (C8) where `SYSTEM_AGENT_ID = 'cleo-orchestrator'` is used as a messaging sender identity. This is a separate concern from agent resolution — it is a conduit message routing identifier, not a resolver lookup. The canonical agent name `project-orchestrator` does not need to replace this identifier unless the conduit system is also updated to reference the agent registry.

---

## Section D — Migration Classification

| Ref | File | Classification | Migration Action |
|-----|------|----------------|-----------------|
| A1 | `packages/agents/package.json` | `safe-rename` | Remove `"seed-agents/"` and `"starter-bundle/"` from `files[]`; add `"templates/"` |
| A2 | `packages/agents/meta/playbook-architect.cant` | `safe-rename` | Update doc comment string reference (comment only) |
| A3 | `packages/agents/tests/starter-bundle.test.ts` | `dead-code` | Delete entire test file; replace with `templates.test.ts` targeting new layout |
| A4 | `packages/cleo/src/cli/commands/agent.ts` (JSDoc `@see`) | `safe-rename` | Update stale `@see` references from `cleo-os/starter-bundle/` to `agents/templates/` |
| A5 | `packages/cleo-os/src/postinstall.ts` | `requires-refactor` | `resolveStarterBundleSrc()` + `copyStarterBundle()` must be rewritten; after T1934, init handles agent registration — postinstall's copy step is replaced by `installAgentFromCant()` calls |
| A6 | `packages/core/src/scaffold.ts` | `safe-import-rename` | Replace `resolveStarterBundleIdentityFile` call; CLEOOS-IDENTITY.md is in starter-bundle — determine if it moves to root of `@cleocode/agents` or is dropped |
| A7 | `packages/core/src/upgrade.ts` | `requires-refactor` | `deployStarterBundle()` action string (`cant_starter_bundle`) + import path must update to new `registerAgentTemplates()` equivalent; upgrade path must call `installAgentFromCant()` not copy |
| A8 | `packages/core/src/init.ts` | `requires-refactor` | `deployStarterBundle()` entire implementation replaces copyFile pattern with `installAgentFromCant()` loop over `templates/`; team.cant copy removed; this is T1934's core work |
| A9 | `packages/core/src/agents/resolveStarterBundle.ts` | `safe-import-rename` | Rename to `resolveAgentTemplates.ts`; new signature per T1935 spec; preserve 4 functions as deprecated re-exports |
| A10 | `packages/core/src/agents/seed-install.ts` | `requires-refactor` | Large file: bundle resolution logic, `buildStarterBundleTuples()`, legacy reroute migration all reference starter-bundle layout. Legacy reroute (lines 754–855) can be deleted after T1938 migration walker ships. Main bundle-enum logic replaces with templates/ walk. |
| A11 | `packages/core/src/store/agent-doctor.ts` | `safe-rename` | Subject string `'legacy-starter-bundle-reroute'` is a log label; safe to keep or rename to `'legacy-agent-bundle-reroute'` |
| A12 | `packages/core/src/agents/__tests__/seed-install-meta.test.ts` | `safe-rename` | Update comment only (line 140) |
| A13 | `docs/adr/ADR-055-agents-architecture-and-meta-agents.md` | `safe-rename` | ADR is superseded by ADR-068; add supersession annotation |
| B2 | `packages/core/src/agents/invoke-meta-agent.ts` | `safe-import-rename` | Imports `resolveMetaAgentsDir` from resolveStarterBundle.ts; after file rename, import path updates |
| B3 | `packages/core/src/agents/seed-install.ts` | `requires-refactor` | (covered by A10 above) |
| B5 | `packages/core/src/scaffold.ts` | `requires-refactor` | Dynamic import path updates to `resolveAgentTemplates.js`; `resolveStarterBundleIdentityFile` replacement needed (CLEOOS-IDENTITY.md fate TBD) |
| B6 | `packages/core/src/playbooks/agent-dispatcher.ts` | `safe-rename` | Local duplicate `resolveMetaAgentsDir()` — no import change needed; annotate for cleanup in T1935 |
| C5/C6 | `packages/cleo/src/cli/commands/agent.ts` | `requires-refactor` | (1) Update stale `@see` references. (2) **`generateLeadPersona()` line 3158**: `parent: cleo-orchestrator` default must change to `project-orchestrator` to match canonical classifier output. |
| C7 | `packages/core/src/agents/seed-install.ts` | `safe-rename` | Comment only; update string in comment |
| C8 | `packages/core/src/hooks/handlers/conduit-hooks.ts` | `requires-refactor` | `SYSTEM_AGENT_ID = 'cleo-orchestrator'` — this hardcoded string is a conduit messaging identity, not a resolver lookup. The deletion of the `.cant` file does NOT break this at runtime. However the name is inconsistent with canonical `project-orchestrator`. Decision required: either keep as a system-level messaging identity (separate from agent resolver naming) or migrate to `project-orchestrator`. **Recommend**: treat as separate cleanup task; not a T1932 blocker since it doesn't cause a build failure. |
| C9 | `packages/core/src/hooks/handlers/__tests__/conduit-hooks.test.ts` | `requires-refactor` | Follows C8; update when C8 is resolved |
| C10 | `packages/adapters/src/__tests__/cant-context.test.ts` | `dead-code` | Creates synthetic `team.cant` in test — NOT reading from starter-bundle. Safe to leave as-is. Reclassify: `safe-rename` (no change needed) |

---

## Section E — T1932 Readiness Checklist

### Totals

| Category | Count |
|----------|-------|
| Total source files with starter-bundle references | 13 source, 2 test, 4 doc/config (excluding dist) |
| Total callers of resolveStarterBundle family | 5 unique call sites (B1–B5; B6 is independent) |
| Total references to cleo-orchestrator (non-bundle source) | 2 semantic (conduit-hooks.ts + agent.ts generateLeadPersona) |
| Total references to team.cant (non-bundle source) | 4 source files (init.ts, seed-install.ts, resolveStarterBundle.ts, cleo-os/postinstall.ts) |

### Classification summary

| Classification | Count | Files |
|----------------|-------|-------|
| `safe-rename` | 7 | A1, A2, A4, A11, A12, A13, B6, C7, C10 |
| `safe-import-rename` | 2 | A9, B2 |
| `requires-refactor` | 6 | A5, A6, A7, A8, A10, C5/C6, C8/C9 |
| `dead-code` | 1 | A3 (starter-bundle.test.ts) |

### Refactor design notes for `requires-refactor` items

**A5 — `packages/cleo-os/src/postinstall.ts`**
CleoOS postinstall currently copies starter-bundle files (team.cant + agents/*.cant) to the user's global CANT directory. After T1934 makes `cleo init` auto-register templates via `installAgentFromCant()`, this copy step is redundant for new installs. Postinstall should either: (a) call `cleo init --install-templates` instead, or (b) be removed and rely on first `cleo init` call. T1932 must coordinate with cleo-os postinstall; this may need a T1934 follow-on.

**A6 — `packages/core/src/scaffold.ts` (`resolveStarterBundleIdentityFile`)**
`CLEOOS-IDENTITY.md` lives in `starter-bundle/` and is read by scaffold. If it is not migrated to `packages/agents/` root level, scaffold will break. T1932 must either: (a) copy CLEOOS-IDENTITY.md to `packages/agents/` root and update scaffold to use `resolveStarterBundleIdentityFile` replacement, or (b) drop the CLEOOS-IDENTITY scaffold step. This must be decided before T1932 executes.

**A7 — `packages/core/src/upgrade.ts` (`deployStarterBundle`)**
Upgrade calls `deployStarterBundle()` to push new agent files on version upgrade. After T1934, upgrades should call the new `installAgentFromCant()` path for each template. The `'cant_starter_bundle'` action string in the upgrade log is a log label — safe to rename to `'cant_agent_templates'`.

**A8 — `packages/core/src/init.ts` (`deployStarterBundle`)**
This is the primary implementation task for T1934. The entire `deployStarterBundle()` function (lines 1237–1302) is replaced. team.cant copy at lines 1266–1268 is removed. New implementation walks `templates/` and calls `installAgentFromCant()` for each file. T1932 (file rename) must complete before T1934 can implement the new path.

**A10 — `packages/core/src/agents/seed-install.ts`**
Three distinct areas:
1. `resolveStarterBundleSrc()` (line 164–176) — replace with `resolveAgentTemplates()` call.
2. `buildStarterBundleTuples()` (lines 352–412) — replace with walk over `templates/` flat directory (no `agents/` subdirectory).
3. Legacy cleo-os reroute (lines 754–855) — can be deleted once T1938 migration walker ships and all users are on ADR-068 layout. Not a T1932 blocker.

**C5/C6 — `packages/cleo/src/cli/commands/agent.ts`**
`generateLeadPersona()` line 3158 hardcodes `parent: cleo-orchestrator`. This default is emitted into user-created `.cant` files by `cleo agent init-template`. After deletion, users who rely on this default will have templates referencing a non-existent agent ID. T1932 MUST update this default to `project-orchestrator` before deletion.

**C8/C9 — `packages/core/src/hooks/handlers/conduit-hooks.ts`**
`SYSTEM_AGENT_ID = 'cleo-orchestrator'` is a conduit messaging sender identity. Deleting `cleo-orchestrator.cant` does NOT break this at runtime (the string is used as a message `from` field, not a resolver lookup). However it creates semantic inconsistency. **Recommended action**: file a separate cleanup task to rename to `'project-orchestrator'` or `'cleo-system'` after T1929 ships. NOT a T1932 build blocker.

---

### T1932 Readiness Verdict

**YELLOW — T1932 can proceed with two pre-conditions addressed**

| Condition | Status | Required action |
|-----------|--------|-----------------|
| `generateLeadPersona()` default parent updated | REQUIRED BEFORE DELETE | Change `parent: cleo-orchestrator` → `project-orchestrator` in `packages/cleo/src/cli/commands/agent.ts:3158` |
| CLEOOS-IDENTITY.md fate decided | REQUIRED BEFORE DELETE | Determine if file moves to `packages/agents/` root or scaffold step is dropped; coordinate with T1932 implementer |
| starter-bundle.test.ts deletion | Safe | Delete alongside starter-bundle/ directory |
| conduit-hooks.ts SYSTEM_AGENT_ID | Non-blocking | File separate follow-up task; no build/runtime breakage |
| Legacy reroute in seed-install.ts | Non-blocking | Preserve during T1932; T1938 migration walker will clean up |
| postinstall.ts copy logic | Coordinate with T1934 | T1932 should not delete starter-bundle until T1934 replaces the copy path in postinstall |

**In summary**: T1932 MUST include two fixes in scope: (1) update `generateLeadPersona()` default parent name, (2) resolve CLEOOS-IDENTITY.md dependency in scaffold.ts. All other `requires-refactor` items are covered by their dedicated tasks (T1934 for init, T1935 for resolve rename, T1938 for legacy reroute). The conduit-hooks SYSTEM_AGENT_ID inconsistency is a post-T1929 cleanup.

---

## Appendix: Files Excluded from Audit Scope

The following were excluded as auto-generated artifacts (will update on rebuild):
- `packages/core/dist/` — all dist files
- `packages/cleo/dist/` — all dist files
- `packages/cleo-os/dist/` — all dist files
- `packages/cleo-os/bin/` — compiled postinstall
- `packages/cleo-os/node_modules/` — vitest results cache
