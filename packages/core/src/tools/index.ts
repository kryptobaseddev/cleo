/**
 * Tools system barrel exports.
 *
 * Provides the complete tools system ported from
 * `packages/cleo/src/dispatch/engines/tools-engine.ts` (ENG-MIG-8 / T1575).
 *
 * Sub-domains exposed:
 *   issue.*      - Issue diagnostics
 *   skill.*      - Skill discovery, dispatch, catalog, precedence
 *   provider.*   - CAAMP provider registry
 *   adapter.*    - Provider adapter management
 *
 * ## Atomic-tool surface (T11474 · E-TOOLS-WIRE)
 *
 * The barrel ALSO exposes the atomic fs/shell tool layer (E3) — but ONLY through
 * the deny-first {@link createToolGuard} chokepoint. The raw side-effecting
 * primitives (`writeFileAtomic`, `executeShell`, `runGit`, …) are deliberately
 * NOT re-exported here: a consumer obtains them by calling `createToolGuard()`
 * and using the returned {@link ToolGuard} surface, so every fs/shell call is
 * funnelled through one policy point and there is no public bypass (AC2). What
 * is exported from the atomic layer:
 *   - {@link createToolGuard} + {@link ToolGuard} / {@link ToolGuardPolicy} /
 *     {@link GuardMode} / {@link GuardDeniedError} — the guarded entrypoint.
 *   - {@link GUARD_ENFORCE_DEADLINE} / {@link GUARD_ENFORCE_FLIP_ENABLED} /
 *     {@link resolveDefaultGuardMode} — the date-gated default-mode mechanism
 *     (held at `warn` behind the owner-gated flip, AC4).
 *   - {@link ShellExecutor} + {@link defaultShellExecutor} — the injectable
 *     process layer threaded INTO the guard's `executeShell`/`runGit` (does not
 *     bypass policy; it is the substitutable subprocess mechanism).
 *
 * @task T1575 — ENG-MIG-8
 * @task T11474 — E-TOOLS-WIRE (atomic-tool surface through the guard)
 * @epic T1566
 */

// BrainTools (Category B) — pure-functional BRAIN retrieval SDK tools (T10070 / T9835)
export * from '../brain-tools/index.js';
export type { DoctorProjectOptions, DoctorProjectResult } from '../doctor/doctor-project.js';
// ProjectTools SDK Tools (Category B) — scaffold + doctor primitives (T10069 / T9835b)
export { doctorProject } from '../doctor/doctor-project.js';
// Engine operations — tools domain (ENG-MIG-8 / T1575)
export {
  toolsAdapterActivate,
  toolsAdapterDetect,
  toolsAdapterDispose,
  toolsAdapterHealth,
  toolsAdapterList,
  toolsAdapterShow,
  toolsIssueDiagnostics,
  toolsProviderDetect,
  toolsProviderHooks,
  toolsProviderInject,
  toolsProviderInjectStatus,
  toolsProviderList,
  toolsProviderSupports,
  toolsSkillCatalogInfo,
  toolsSkillCatalogProfiles,
  toolsSkillCatalogProtocols,
  toolsSkillCatalogResources,
  toolsSkillDependencies,
  toolsSkillDispatch,
  toolsSkillFind,
  toolsSkillInstall,
  toolsSkillList,
  toolsSkillPrecedenceResolve,
  toolsSkillPrecedenceShow,
  toolsSkillRefresh,
  toolsSkillShow,
  toolsSkillSpawnProviders,
  toolsSkillUninstall,
  toolsSkillVerify,
} from '../engine/engine-ops.js';
export type { ScaffoldGlobalResult } from '../scaffold/scaffold-global.js';
export { scaffoldGlobal } from '../scaffold/scaffold-global.js';
export type {
  ScaffoldProjectOptions,
  ScaffoldProjectResult,
  ScaffoldProjectStep,
} from '../scaffold/scaffold-project.js';
export { scaffoldProject } from '../scaffold/scaffold-project.js';
// SDK Tools (Category B) — harness-agnostic infrastructure (T1768 / ADR-064)
export * from '../sdk/index.js';
// TaskTools (Category B) — pure-functional task graph SDK tools (T10068 / T9835)
export * from '../task-tools/index.js';
// Subprocess env scrubbing (T11897 · security) — the chokepoint builds a minimal,
// allowlisted child env so daemon secrets never leak and a Pi-controlled loader
// hook / PATH can never reach a spawned process.
export {
  isForbiddenEnvName,
  type ScrubEnvOptions,
  scrubSubprocessEnv,
  TRUSTED_PATH,
} from './env-scrub.js';
// Atomic-tool guard chokepoint (E3 · T11407 · T11474) — the ONLY public route to
// the fs/shell primitives. Raw primitives are intentionally not re-exported.
export {
  createToolGuard,
  GUARD_ENFORCE_DEADLINE,
  GUARD_ENFORCE_FLIP_ENABLED,
  GuardDeniedError,
  type GuardMode,
  resolveDefaultGuardMode,
  type ToolGuard,
  type ToolGuardPolicy,
} from './guard.js';
// Injectable shell executor (E3 · T11406) — threaded into the guard's
// executeShell/runGit; substitutes the subprocess layer in tests/sandboxes.
export { defaultShellExecutor, type ShellExecutor } from './shell.js';
