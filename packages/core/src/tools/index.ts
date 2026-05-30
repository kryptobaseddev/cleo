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
 * @task T1575 — ENG-MIG-8
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
