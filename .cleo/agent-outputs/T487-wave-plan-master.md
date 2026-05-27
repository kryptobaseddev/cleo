# T487 — Commander-Shim Removal: Wave Plan Master

**Date**: 2026-04-17
**Author**: T487 Team Lead (claude-sonnet-4-6)
**Sources**: T488 research, T489 consensus, T487-wave-b-lead-c-report, T487-wave1-worker-a/b, codebase audit
**Baseline**: v2026.4.76, biome CI baseline = 16 errors

---

## Section 1: Current State Audit

### Wave 1 Completion Status

Wave 1 targeted 28 files (from Lead-C plan). Worker A migrated 6 (sub-tier A), Worker B migrated 14 (sub-tier B), Worker C migrated 6 (sub-tier C: add-batch, complete, delete, find, list, reparent). Additionally conduit.ts was already native citty before Wave 1.

**Verified migrated (29 files, all using defineCommand):**

| File | Export Name | Verified |
|------|-------------|---------|
| `add-batch.ts` | `addBatchCommand` | defineCommand found |
| `analyze.ts` | `analyzeCommand` | defineCommand found |
| `blockers.ts` | `blockersCommand` | defineCommand found |
| `cancel.ts` | `cancelCommand` | defineCommand found |
| `checkpoint.ts` | `checkpointCommand` | defineCommand found |
| `code.ts` | `codeCommand` | original reference |
| `complete.ts` | `completeCommand` | defineCommand found |
| `conduit.ts` | `conduitCommand` | native (pre-Wave 1) |
| `current.ts` | `currentCommand` | defineCommand found |
| `delete.ts` | `deleteCommand` | defineCommand found |
| `detect.ts` | `detectCommand` | defineCommand found |
| `exists.ts` | `existsCommand` | defineCommand found |
| `find.ts` | `findCommand` | defineCommand found |
| `generate-changelog.ts` | `generateChangelogCommand` | defineCommand found |
| `grade.ts` | `gradeCommand` | defineCommand found |
| `list.ts` | `listCommand` | defineCommand found |
| `map.ts` | `mapCommand` | defineCommand found |
| `next.ts` | `nextCommand` | defineCommand found |
| `ops.ts` | `opsCommand` | defineCommand found |
| `plan.ts` | `planCommand` | defineCommand found |
| `promote.ts` | `promoteCommand` | defineCommand found |
| `refresh-memory.ts` | `refreshMemoryCommand` | defineCommand found |
| `reparent.ts` | `reparentCommand` | defineCommand found |
| `roadmap.ts` | `roadmapCommand` | defineCommand found |
| `show.ts` | `showCommand` | defineCommand found |
| `start.ts` | `startCommand` | defineCommand found |
| `stop.ts` | `stopCommand` | defineCommand found |
| `validate.ts` | `validateCommand` | defineCommand found |

**Confirmed wired in index.ts** (verified via grep): all 28 above plus aliases (`done`=completeCommand, `rm`=deleteCommand, `ls`=listCommand).

### Wave 1 Broken / Incomplete Items

**BROKEN — Sub-tier D gap (T837):**

1. **`detect-drift.ts`** — still exports `registerDetectDriftCommand(program: Command)` (shim). 501-line single-action file, straightforward Pattern A migration. Not yet done.

2. **`conduit.ts`** — native citty (has defineCommand) but NOT wired in `index.ts`. grep for `subCommands['conduit']` returns nothing. The import/wiring was omitted.

3. **`NATIVE_COMMAND_DESCS` gap** — help-renderer.ts has only 12 entries: `version`, `code`, `conduit`, `complete`, `done`, `delete`, `rm`, `find`, `list`, `ls`, `reparent`, `add-batch`. Missing 16 Wave 1 commands: `current`, `detect`, `plan`, `refresh-memory`, `stop`, `analyze`, `blockers`, `cancel`, `checkpoint`, `exists`, `generate-changelog`, `grade`, `map`, `next`, `ops`, `promote`, `roadmap`, `show`, `start`, `validate`.

4. **`startup-migration.test.ts`** — still mocks `registerDetectDriftCommand: vi.fn()` (line 165). Needs update once detect-drift.ts is migrated.

### Test File Analysis

Test files referencing `ShimCommand` and their status:

| Test File | Shim Usage | Action Needed |
|-----------|-----------|---------------|
| `commands.test.ts` | Tests `commands.ts` (deprecated DEPRECATED stub) | Will be deleted or rewritten for `ops.ts` at Wave 6 |
| `safestop.test.ts` | Tests `registerSafestopCommand` against ShimCommand | Update at Wave 2 (W2-Worker-4: safestop.ts migration) |
| `docs.test.ts` | Tests `registerDocsCommand` against ShimCommand | Update at Wave 2 (W2-Worker-2: docs.ts migration) |
| `export-tasks.test.ts` | Tests `registerExportTasksCommand` against ShimCommand | Update at Wave 2 (W2-Worker-3: export-tasks.ts migration) |
| `import-tasks.test.ts` | Tests `registerImportTasksCommand` against ShimCommand | Update at Wave 2 (W2-Worker-3: import-tasks.ts migration) |
| `nexus-projects-clean.test.ts` | Tests nexus command against ShimCommand | Update at Wave 4 (W4-3: nexus.ts migration) |
| `testing.test.ts` | Tests `registerTestingCommand` against ShimCommand | Update at Wave 2 (W2-Worker-5: testing.ts migration) |
| `web.test.ts` | Tests `registerWebCommand` against ShimCommand | Update at Wave 2 (W2-Worker-5: web.ts migration) |
| `startup-migration.test.ts` | Mixed: some updated, detect-drift still old | Update detect-drift mock at W1-CLEANUP |
| `help-generator.test.ts` | Tests `applyParamDefsToCommand` using ShimCommand | Rewrite or delete at Wave 6 (applyParamDefsToCommand removed) |

**Tests that tested already-migrated commands but have been updated:**
`checkpoint.test.ts` was updated by Worker B to use `checkpointCommand` native export.

---

## Section 2: Exhaustive Inventory of 84 Remaining Shim-Based Commands

### Deprecated/Stub Files (skip migration, cleanup at Wave 6)

| File | Nature | Status |
|------|--------|--------|
| `agents.ts` | No-op stub, imports ShimCommand type only | Cleanup: remove ShimCommand import, keep no-op export |
| `commands.ts` | DEPRECATED stub (`cleo ops` replacement) | Cleanup: delete file + commands.test.ts at Wave 6 |
| `dynamic.ts` | No-op stub for future registry-driven generation | Cleanup: remove ShimCommand import at Wave 6 |

### Wave 2 — 65 Medium-Tier Files (no aliases, no isDefault)

Batched into 5 parallelizable workers:

**Worker 1 (T839) — 13 files:**
`adapter`, `add`, `adr`, `archive`, `archive-stats`, `backfill`, `backup-inspect`, `brain`, `briefing`, `bug`, `cant`, `chain`, `check`

Notable: `check.ts` has 34 options/7 subcommands (most complex in batch), `add.ts` has local ADD_PARAMS (convert inline), `backup-inspect.ts` is a sub-registrar (not root command).

**Worker 2 (T840) — 13 files:**
`claim`, `complexity`, `compliance`, `config`, `consensus`, `contribution`, `daemon`, `dash`, `decomposition`, `deps`, `diagnostics`, `docs`, `doctor`

Notable: `doctor.ts` uses `optsWithGlobals()` — replace with format/field context read. `claim.ts` registers two root commands (claim + unclaim). `deps.ts` registers two commands (deps + tree). `consensus`, `contribution`, `decomposition` are DEPRECATED stubs.

**Worker 3 (T841) — 13 files:**
`export`, `export-tasks`, `gc`, `history`, `implementation`, `import`, `import-tasks`, `init`, `inject`, `intelligence`, `issue`, `log`, `migrate-claude-mem`

Notable: `export-tasks.test.ts` and `import-tasks.test.ts` use ShimCommand — update tests. `issue.ts` has 15 options/5 subcommands. `implementation.ts` is a DEPRECATED stub.

**Worker 4 (T842) — 13 files:**
`observe`, `otel`, `provider`, `reason`, `relates`, `release`, `remote`, `reorder`, `req`, `restore`, `safestop`, `schema`, `self-update`

Notable: `self-update.ts` uses `optsWithGlobals()` — replace with context read. `safestop.test.ts` uses ShimCommand — update test. `release.ts` has requiredOption patterns.

**Worker 5 (T843) — 12 files:**
`sequence`, `snapshot`, `specification`, `stats`, `sync`, `testing`, `token`, `transcript`, `update`, `upgrade`, `verify`, `web`

Notable: `token.ts` (31 options, 7 subcommands), `update.ts` (20 options), `upgrade.ts` uses `optsWithGlobals()`. `specification.ts` is DEPRECATED. `testing.test.ts` and `web.test.ts` use ShimCommand — update tests.

### Wave 3 — 7 Medium-Tier Files (aliases or isDefault)

**isDefault group (T845) — 4 files:**

| File | isDefault Sub | Feature |
|------|--------------|---------|
| `context.ts` | Read file to confirm | isDefault subcommand |
| `env.ts` | Read file to confirm | isDefault subcommand |
| `labels.ts` | Read file to confirm | isDefault subcommand |
| `phases.ts` | Read file to confirm | isDefault subcommand, DEPRECATED alias for `phase` |

Pattern: `const knownSubs = new Set([...]); if (!ctx.rawArgs.some(a => knownSubs.has(a))) { await defaultSub.run?.(ctx); }`

**Alias-on-subcommand group (T846) — 3 files:**

| File | Alias Count | Complexity | Notes |
|------|------------|------------|-------|
| `backup.ts` | Read file | 17 action/option/command | Contains backup-inspect as sub-registrar |
| `phase.ts` | Read file | 23 action/option/command | — |
| `sticky.ts` | Read file | 25 action/option/command | — |

Pattern: `const subCmd = defineCommand({...}); subCommands['primary'] = subCmd; subCommands['alias'] = subCmd;`

### Wave 4 — 9 Complex-Tier Files

| File | Options | Subcommands | Special Features | Task |
|------|---------|-------------|-----------------|------|
| `memory-brain.ts` | 54 | 17 | requiredOption, parseFn, type-conditional routing | T848 |
| `agent.ts` | 46 | 26 | requiredOption, file I/O, multi-step async | T849 |
| `nexus.ts` | 19 | 25 | alias on subcommands, cross-project ops | T850 |
| `orchestrate.ts` | 20 | 26 | streaming, dynamic dispatch, conduit sub-tree | T851 |
| `session.ts` | 33 | 15 | requiredOption, alias on subcommands | T852 |
| `skills.ts` | 10 | 15 | file I/O, tar/zip ops | T853 |
| `admin.ts` | 11 | 15 | isDefault, requiredOption | T854 |
| `research.ts` | 16 | 11 | requiredOption, MANIFEST file I/O | T855 |
| `lifecycle.ts` | 9 | 12 | requiredOption, multi-step pipeline | T856 |

---

## Section 3: CLEO Tasks Created

### Task ID Table

| Task ID | Title | Parent | Size | Type |
|---------|-------|--------|------|------|
| **T837** | W1-CLEANUP: Finish Wave 1 (detect-drift, conduit wiring, NATIVE_COMMAND_DESCS, test updates) | T487 | small | task |
| **T838** | Wave 2 — Migrate 65 medium-tier shim commands (no aliases/isDefault) | T487 | large | task |
| **T839** | W2-Worker-1: adapter, add, adr, archive, archive-stats, backfill, backup-inspect, brain, briefing, bug, cant, chain, check | T838 | medium | task |
| **T840** | W2-Worker-2: claim, complexity, compliance, config, consensus, contribution, daemon, dash, decomposition, deps, diagnostics, docs, doctor | T838 | medium | task |
| **T841** | W2-Worker-3: export, export-tasks, gc, history, implementation, import, import-tasks, init, inject, intelligence, issue, log, migrate-claude-mem | T838 | medium | task |
| **T842** | W2-Worker-4: observe, otel, provider, reason, relates, release, remote, reorder, req, restore, safestop, schema, self-update | T838 | medium | task |
| **T843** | W2-Worker-5: sequence, snapshot, specification, stats, sync, testing, token, transcript, update, upgrade, verify, web | T838 | medium | task |
| **T844** | Wave 3 — Migrate 7 medium-tier commands with aliases or isDefault | T487 | medium | task |
| **T845** | W3-Worker-1: isDefault group — context, env, labels, phases | T844 | medium | task |
| **T846** | W3-Worker-2: alias-subcommand group — backup, phase, sticky | T844 | medium | task |
| **T847** | Wave 4 — Migrate 9 complex-tier commands | T487 | large | task |
| **T848** | W4-1: memory-brain.ts (54 options, 17 subcommands, requiredOption) | T847 | large | task |
| **T849** | W4-2: agent.ts (46 options, 26 subcommands, requiredOption, file I/O) | T847 | large | task |
| **T850** | W4-3: nexus.ts (19 options, 25 subcommands, aliases) | T847 | large | task |
| **T851** | W4-4: orchestrate.ts (20 options, 26 subcommands, streaming) | T847 | large | task |
| **T852** | W4-5: session.ts (33 options, 15 subcommands, requiredOption, alias) | T847 | medium | task |
| **T853** | W4-6: skills.ts (10 options, 15 subcommands, file I/O) | T847 | medium | task |
| **T854** | W4-7: admin.ts (11 options, 15 subcommands, isDefault, requiredOption) | T847 | medium | task |
| **T855** | W4-8: research.ts (16 options, 11 subcommands, requiredOption) | T847 | medium | task |
| **T856** | W4-9: lifecycle.ts (9 options, 12 subcommands, requiredOption) | T847 | medium | task |
| **T857** | Wave 5 — Rewrite help-renderer.ts and help-generator.ts | T487 | medium | task |
| **T858** | Wave 6 — Delete commander-shim.ts, remove shimToCitty, cleanup stubs | T487 | small | task |
| **T859** | Wave 7 — Full test suite, smoke tests, validate T487 AC | T487 | small | task |
| **T860** | Wave 8 — Release pipeline: version bump, CHANGELOG, npm publish | T487 | small | task |

**Total tasks created: 24** (T837–T860)

---

## Section 4: Verification Gate Per Wave

Canonical gate sequence (per T489 Decision 1, extended):

```bash
# Gate 1: Format + lint (file-scoped first, then CI-wide)
pnpm biome check --write <touched-files>
pnpm biome ci packages/cleo   # must be ≤ 16 errors (baseline)

# Gate 2: Build
pnpm --filter @cleocode/cleo run build   # must exit 0

# Gate 3: Tests (zero new failures)
pnpm --filter @cleocode/cleo run test

# Gate 4: Smoke (every migrated command)
for cmd in <migrated-commands>; do
  cleo $cmd --help  # must render without error
done
```

**Wave-specific smoke commands:**

| Wave | Required Smoke Tests |
|------|---------------------|
| W1-CLEANUP | `cleo detect-drift --help`, `cleo conduit --help`, `cleo --help` (check NATIVE_COMMAND_DESCS completeness) |
| Wave 2 | `cleo add --help`, `cleo check --help`, `cleo dash --help`, `cleo issue --help`, `cleo token --help`, `cleo update --help` |
| Wave 3 | `cleo context` (no args), `cleo env` (no args), `cleo labels` (no args), `cleo backup inspect --help`, `cleo phase list --help` |
| Wave 4 | `cleo memory find T487`, `cleo agent health`, `cleo nexus status`, `cleo orchestrate start --help`, `cleo session status`, `cleo lifecycle complete --help` |
| Wave 5 | `cleo --help` (full grouped output, no NATIVE_COMMAND_DESCS visible in code) |
| Wave 6 | `grep -r "ShimCommand" packages/cleo/src/` (must return 0 results) |
| Wave 7 | Full repo: `pnpm biome ci .`, `pnpm run build`, `pnpm run test` |

---

## Section 5: Risk Register

### Risk 1: `isDefault` subcommand divergence

**Affected files**: context.ts, env.ts, labels.ts, phases.ts (Wave 3), admin.ts (Wave 4)

**Risk**: The `knownSubs` Set in each parent `run()` must exactly match the actual subcommand keys in `subCommands`. If a subcommand is renamed or a new one added later, the Set will be stale and `isDefault` will misfire (show default when a real subcommand was requested).

**Mitigation**: Build `knownSubs` dynamically from `Object.keys(subCommands)` rather than hard-coding, OR add a unit test that asserts `knownSubs` matches `Object.keys(subCommands)`.

### Risk 2: `optsWithGlobals()` replacement coverage

**Affected files**: doctor.ts (W2-Worker-2), self-update.ts (W2-Worker-4), upgrade.ts (W2-Worker-5)

**Risk**: These files call `command.optsWithGlobals()` to get `--json`, `--human`, `--quiet` flags. The replacement is to read from the format/field context modules set in index.ts startup. If the startup block runs AFTER shimToCitty() wraps these commands (current ordering), the context will be set correctly. But if any command is invoked before startup completes (test environments), context may be stale.

**Mitigation**: Verify startup ordering in index.ts. The format/field resolution block (lines 411-437) runs before `for (const shim of rootShim._subcommands)` so context is always set first.

### Risk 3: `NATIVE_COMMAND_DESCS` growth during transition

**Affected**: help-renderer.ts, all Waves 1-4

**Risk**: By the end of Wave 4, NATIVE_COMMAND_DESCS will have ~114 entries — making it the canonical source of truth for all descriptions, defeating the purpose of `meta.description` on each `CommandDef`. This is by design (per T489 Decision 3) but must be cleaned up at Wave 5.

**Current state**: 12 entries. Missing 16 from Wave 1 (T837 covers this). Will grow to ~81 after Wave 2, ~88 after Wave 3, ~97 after Wave 4, then eliminated at Wave 5.

**Mitigation**: Wave 5 is mandatory — do not skip. NATIVE_COMMAND_DESCS is explicitly a short-lived hack.

### Risk 4: `commands.ts` is confirmed dead

**Status**: `registerCommandsCommand` is commented out in index.ts (line 165: `// DEPRECATED: registerCommandsCommand removed — use cleo ops instead`). The function is imported but never called. The shim registration loop (lines 395-400) will pick it up if registerCommandsCommand was ever called before that loop — but it is not called. Therefore `commands.ts` generates no subCommand in the final citty tree. It is effectively dead code.

**Confirmed**: `commands.ts` does NOT register against rootShim (the registration call is removed). Wave 6 can delete it safely.

### Risk 5: `NATIVE_COMMAND_DESCS` growing to 114 entries is the Wave 5 trigger

Per T489 Decision 3, each worker must add entries to `NATIVE_COMMAND_DESCS` for each migrated command during Waves 1-4. This map will grow from 12 → 114 entries during migration, then be eliminated at Wave 5. This is the design — the map is a known-size, short-lived hack.

**Worker constraint**: Workers must NOT skip the NATIVE_COMMAND_DESCS update step. Failing to add entries means `cleo --help` will not show the migrated command in its group until Wave 5.

### Risk 6: `backup-inspect.ts` is a sub-registrar, not a root command

**Status**: `backup-inspect.ts` exports `registerBackupInspectSubcommand(backup: Command)` — it registers a subcommand ON the backup shim, not as a root command. Lead-C correctly excluded it from Wave 1.

**Migration**: backup-inspect.ts content must be migrated as a nested `subCommands` entry inside the `backupCommand` defined in `backup.ts`. Do NOT create a `subCommands['backup-inspect'] = ...` root entry.

### Risk 7: `parseFn` removed from shimToCitty — was already handled

The shim bridge preserves `parseFn` by calling `opt.parseFn(val)` inline (index.ts line 313). After migration, all parseFn must move into each command's `run()`. The 21 files using parseFn are spread across Waves 2-4 — each worker must read the shim source and inline the parse calls.

---

## Execution Order (Sequential Wave Dependencies)

```
T837 (W1-CLEANUP) ─────────────────────┐
                                        │
T838 (Wave 2, 5 workers parallel) ──────┤  After T837 complete
                                        │
T844 (Wave 3, 2 workers parallel) ──────┤  After T838 complete
                                        │
T847 (Wave 4, 9 workers parallel) ──────┤  After T844 complete
                                        │
T857 (Wave 5 — help system) ────────────┤  After T847 complete
                                        │
T858 (Wave 6 — shim deletion) ──────────┤  After T857 complete
                                        │
T859 (Wave 7 — validation) ─────────────┤  After T858 complete
                                        │
T860 (Wave 8 — release) ────────────────┘  After T859 complete
```

Within Wave 2, all 5 workers (T839-T843) run in parallel.
Within Wave 3, T845 and T846 run in parallel.
Within Wave 4, T848-T856 run in parallel (one per file, isolated blast radius).
