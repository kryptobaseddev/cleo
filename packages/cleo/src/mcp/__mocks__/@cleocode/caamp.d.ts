/**
 * Manual Jest mock for @cleocode/caamp
 *
 * Required because caamp is ESM-only (uses import.meta.url) which is
 * incompatible with Jest's CJS runtime. This mock provides stub
 * implementations for all imported functions.
 *
 * @task T4409
 */
export declare const getAllProviders: import('vitest').Mock<() => never[]>;
export declare const getProvider: import('vitest').Mock<() => null>;
export declare const resolveAlias: import('vitest').Mock<(alias: string) => string>;
export declare const detectAllProviders: import('vitest').Mock<() => never[]>;
export declare const getInstalledProviders: import('vitest').Mock<() => never[]>;
export declare const getProviderCount: import('vitest').Mock<() => number>;
export declare const getRegistryVersion: import('vitest').Mock<() => string>;
export declare const getInstructionFiles: import('vitest').Mock<() => never[]>;
export declare const getProvidersByHookEvent: import('vitest').Mock<() => never[]>;
export declare const getCommonHookEvents: import('vitest').Mock<() => never[]>;
export declare const installMcpServer: import('vitest').Mock<
  () => Promise<{
    installed: boolean;
  }>
>;
export declare const listMcpServers: import('vitest').Mock<() => Promise<never[]>>;
export declare const listAllMcpServers: import('vitest').Mock<() => Promise<never[]>>;
export declare const removeMcpServer: import('vitest').Mock<() => Promise<boolean>>;
export declare const resolveConfigPath: import('vitest').Mock<() => null>;
export declare const buildServerConfig: import('vitest').Mock<() => {}>;
export declare const inject: import('vitest').Mock<() => Promise<string>>;
export declare const checkInjection: import('vitest').Mock<
  () => Promise<{
    injected: boolean;
  }>
>;
export declare const checkAllInjections: import('vitest').Mock<() => Promise<never[]>>;
export declare const injectAll: import('vitest').Mock<() => Promise<Map<any, any>>>;
export declare const generateInjectionContent: import('vitest').Mock<() => string>;
export declare const installBatchWithRollback: import('vitest').Mock<
  () => Promise<{
    success: boolean;
    results: never[];
    rolledBack: boolean;
  }>
>;
export declare const configureProviderGlobalAndProject: import('vitest').Mock<
  () => Promise<{
    global: {
      success: boolean;
    };
    project: {
      success: boolean;
    };
  }>
>;
export declare const getCanonicalSkillsDir: import('vitest').Mock<() => string>;
export declare const parseSkillFile: import('vitest').Mock<() => Promise<null>>;
export declare const discoverSkill: import('vitest').Mock<() => Promise<null>>;
export declare const discoverSkills: import('vitest').Mock<() => Promise<never[]>>;
export declare const getTrackedSkills: import('vitest').Mock<() => Promise<{}>>;
export declare const recordSkillInstall: import('vitest').Mock<() => Promise<void>>;
export declare const removeSkillFromLock: import('vitest').Mock<() => Promise<boolean>>;
export declare const checkSkillUpdate: import('vitest').Mock<
  () => Promise<{
    needsUpdate: boolean;
  }>
>;
export declare const catalog: {
  getSkills: import('vitest').Mock<() => never[]>;
  listSkills: import('vitest').Mock<() => never[]>;
  getSkill: import('vitest').Mock<() => undefined>;
  getCoreSkills: import('vitest').Mock<() => never[]>;
  getSkillsByCategory: import('vitest').Mock<() => never[]>;
  getDispatchMatrix: import('vitest').Mock<
    () => {
      by_task_type: {};
      by_keyword: {};
      by_protocol: {};
    }
  >;
  getManifest: import('vitest').Mock<
    () => {
      $schema: string;
      _meta: {};
      dispatch_matrix: {};
      skills: never[];
    }
  >;
  getVersion: import('vitest').Mock<() => string>;
  isCatalogAvailable: import('vitest').Mock<() => boolean>;
  validateSkillFrontmatter: import('vitest').Mock<
    () => {
      valid: boolean;
      issues: never[];
    }
  >;
  validateAll: import('vitest').Mock<() => Map<any, any>>;
  getSkillDependencies: import('vitest').Mock<() => never[]>;
  resolveDependencyTree: import('vitest').Mock<() => never[]>;
  listProfiles: import('vitest').Mock<() => never[]>;
  getProfile: import('vitest').Mock<() => undefined>;
  resolveProfile: import('vitest').Mock<() => never[]>;
  listSharedResources: import('vitest').Mock<() => never[]>;
  getSharedResourcePath: import('vitest').Mock<() => undefined>;
  readSharedResource: import('vitest').Mock<() => undefined>;
  listProtocols: import('vitest').Mock<() => never[]>;
  getProtocolPath: import('vitest').Mock<() => undefined>;
  readProtocol: import('vitest').Mock<() => undefined>;
  readSkillContent: import('vitest').Mock<() => string>;
  getSkillPath: import('vitest').Mock<() => string>;
  getSkillDir: import('vitest').Mock<() => string>;
  getLibraryRoot: import('vitest').Mock<() => string>;
};
//# sourceMappingURL=caamp.d.ts.map
