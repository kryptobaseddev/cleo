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
} from './engine-ops.js';
// SDK Tools (Category B) — harness-agnostic infrastructure (T1768 / ADR-064)
export * from './sdk/index.js';
