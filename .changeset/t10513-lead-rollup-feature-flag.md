---
id: t10513-lead-rollup-feature-flag
tasks: [T10513]
kind: refactor
summary: "lead-rollup: mode='active' becomes config-driven feature flag (T10383 Wave 3a)"
---

Closes T10513. Saga: T10377 SG-IVTR-AC-BINDING. Decision: D013. Council action #9.

Converts the planned `lead-rollup.ts mode='active'` code path from a function parameter into a config-driven feature flag, so the Lead↔Worker Max-N loop scaffolded under E-VALIDATOR-ROLE (T10383) lands without forcing every existing caller of `rollupWaveStatus` / `rollupEpicStatus` to change. The whole council-action-#9 point: callers stay untouched, behaviour flips via `.cleo/config.json` instead.

**Contract additions** (`packages/contracts/src/config.ts`):
- `LeadRollupMode = 'passive' | 'active' | 'auto'`
- `LeadRollupConfig { mode?: LeadRollupMode }`
- `CleoConfig.leadRollup?: LeadRollupConfig`

**Default** (`packages/core/src/config.ts`): `leadRollup: { mode: 'passive' }` — preserves the legacy compute-from-manifest behaviour. Existing projects pick up zero behavioural change.

**Resolver** (`packages/core/src/orchestration/lead-rollup.ts`):
- New `resolveLeadRollupMode(projectRoot?)` reads the cascade via `getConfigValue` from the SSoT registry (T9878).
- Malformed values (typo / wrong type / null) safely fall back to `'passive'` rather than throwing.
- A no-op `applyActiveModeHook(workers, blockers)` is the seam T10512 will plug retry-signal emission into — kept as a stub today so flipping the flag is observably safe.

**Public function signatures unchanged** — `rollupWaveStatus` and `rollupEpicStatus` still take the same `(epicId, [waveId], projectRoot?, options?)` shape they had before. The CLI command at `packages/cleo/src/cli/commands/orchestrate.ts` does NOT need to change. Zero caller files modified.

**Tests** (16 new):
- `packages/core/src/orchestration/__tests__/lead-rollup-mode.test.ts` (14): default-off, flag-on flips, malformed-value safety, caller-signature invariant.
- `packages/core/src/__tests__/config.test.ts` (2): `loadConfig` exposes `leadRollup.mode='passive'` by default and accepts project override to `'active'`.
