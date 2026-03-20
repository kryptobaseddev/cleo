# Wave 1B Completion Report: Underscore-Prefixed Stub Parameters

**Team**: Wave 1B
**Scope**: Wire all underscore-prefixed stub parameters into implementations
**Status**: COMPLETE
**Build**: PASS (pnpm run build)

---

## Summary

All 11 underscore-prefixed parameters across 9 files have been addressed. 10 parameters were fully wired into their implementations. 1 parameter (`_projectRoot` in `checkGlobalSchemaHealth`) was documented as intentionally unused because global schemas are system-wide, not project-scoped.

---

## Items Completed

### Item 1: `_since` in SignalDock transport
**File**: `packages/core/src/signaldock/signaldock-transport.ts:107`
**Change**: Renamed `_since` to `since`. The `poll()` method now appends `?since=<value>` as a query parameter to the poll endpoint when provided, enabling timestamp-based message pagination instead of fetching all messages on every poll.

### Item 2: `_opts` in OTel token usage
**File**: `packages/core/src/otel/index.ts:128`
**Change**: Renamed `_opts` to `opts`. The `getRealTokenUsage()` function now reads the JSONL token data file and applies both `session` and `since` filters from opts. Returns filtered token counts (total, input, output) with filter metadata. Previously returned a hardcoded placeholder regardless of input.

### Item 3: `_reason` in pipeline completion
**File**: `packages/core/src/lifecycle/pipeline.ts:705`
**Change**: Renamed `_reason` to `reason`. When a completion reason is provided, `completePipeline()` now stores it in the final stage's `notesJson` (as `"Completion reason: <reason>"`) and `metadataJson` (as `{ completionReason: reason }`). Uses existing schema columns -- no migration needed.

### Item 4: `_reason` in state machine skipStage
**File**: `packages/core/src/lifecycle/state-machine.ts:716`
**Change**: Renamed `_reason` to `reason`. The `skipStage()` function now stores the skip reason in the returned `StageState.notes` field for in-memory context. The DB-level `skip_reason` column was already wired through `recordStageProgress()` in `lifecycle/index.ts`.

### Item 5: `_templates` in validateLabelsExist
**File**: `packages/core/src/issue/template-parser.ts:232`
**Change**: Renamed `_templates` to `templates`. Implemented full cross-reference validation: builds a label frequency map across all templates, then flags labels that appear in only one template and are not well-known labels (bug, enhancement, etc.) or template subcommands/names. Catches typos and orphaned labels without requiring GitHub API access.

### Item 6: `_epicId` in orchestrator sessionInit
**File**: `packages/core/src/skills/orchestrator/startup.ts:137`
**Change**: Renamed `_epicId` to `epicId`. When provided:
- Filters active sessions to prefer those scoped to the given epic
- Sets `activeScope` to the epicId when no matching session exists
- Checks the task file for pending tasks under the epic to populate `hasPending`
- Includes epicId in the `actionReason` message for `create_and_spawn`

### Items 7 & 8: `_projectRoot` in skill-ops
**File**: `packages/core/src/orchestration/skill-ops.ts:29,66`
**Change**: Renamed both `_projectRoot` to `projectRoot`.
- `listSkills()`: Now scans `{projectRoot}/.cleo/skills/` first (project-local, higher priority), then canonical global skills. Uses a `seen` set to deduplicate by skill name with project-local taking precedence.
- `getSkillContent()`: Checks project-local skill directory first (`{projectRoot}/.cleo/skills/{name}`), falling back to canonical. Error message now mentions both paths for clarity.

### Item 9: `_protocolType` in validation
**File**: `packages/core/src/validation/protocol-common.ts:96`
**Change**: Renamed `_protocolType` to `protocolType` in both `checkReturnMessageFormat()` and `validateCommonManifestRequirements()`.
- `checkReturnMessageFormat()`: When protocolType is provided, constrains the regex to only accept the matching message type prefix (e.g., `protocolType='research'` only accepts messages starting with `"Research ..."`). Falls back to accepting any valid type when protocolType is absent or unknown.
- `validateCommonManifestRequirements()`: When protocolType is provided, adds a COMMON-007 check validating that the manifest entry's `agent_type` matches the expected protocol type.

### Items 10 & 11: `_projectRoot` in doctor checks
**File**: `packages/core/src/validation/doctor/checks.ts:419,972`
**Changes**:
- `detectStorageEngine()` (line 419): Renamed `_projectRoot` to `projectRoot`. Now reads `{projectRoot}/.cleo/config.json` for a `storageEngine` override before defaulting to `'sqlite'` per ADR-006. Enables forward compatibility if alternative engines are ever supported.
- `checkGlobalSchemaHealth()` (line 972): Parameter kept as `_projectRoot` with comprehensive JSDoc explaining WHY: global schemas live at `~/.cleo/schemas/` and are system-wide, not project-scoped. The parameter exists purely for API consistency with other check functions called from `runAllGlobalChecks()`.

---

## Build Verification

```
pnpm run build
Build complete.  (warnings only: pre-existing ES2025 target + package.json condition order)
```

No new errors or warnings introduced.

---

## Files Modified

| File | Lines Changed |
|------|---------------|
| `packages/core/src/signaldock/signaldock-transport.ts` | 3 |
| `packages/core/src/otel/index.ts` | ~40 |
| `packages/core/src/lifecycle/pipeline.ts` | ~15 |
| `packages/core/src/lifecycle/state-machine.ts` | 4 |
| `packages/core/src/issue/template-parser.ts` | ~55 |
| `packages/core/src/skills/orchestrator/startup.ts` | ~30 |
| `packages/core/src/orchestration/skill-ops.ts` | ~40 |
| `packages/core/src/validation/protocol-common.ts` | ~35 |
| `packages/core/src/validation/doctor/checks.ts` | ~15 |

---

## No Remaining Underscore Stubs

All 11 actionable underscore-prefixed parameters from the audit have been resolved. The only remaining `_projectRoot` is in `checkGlobalSchemaHealth` which is documented as intentionally unused.
