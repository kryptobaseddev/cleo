/**
 * Manual Jest mock for @cleocode/caamp
 *
 * Required because caamp is ESM-only (uses import.meta.url) which is
 * incompatible with Jest's CJS runtime. This mock provides stub
 * implementations for all imported functions.
 *
 * @task T4409
 */
export declare const getAllProviders: any;
export declare const getProvider: any;
export declare const resolveAlias: any;
export declare const detectAllProviders: any;
export declare const getInstalledProviders: any;
export declare const getProviderCount: any;
export declare const getRegistryVersion: any;
export declare const getInstructionFiles: any;
export declare const getProvidersByHookEvent: any;
export declare const getCommonHookEvents: any;
export declare const installMcpServer: any;
export declare const listMcpServers: any;
export declare const listAllMcpServers: any;
export declare const removeMcpServer: any;
export declare const resolveConfigPath: any;
export declare const buildServerConfig: any;
export declare const inject: any;
export declare const checkInjection: any;
export declare const checkAllInjections: any;
export declare const injectAll: any;
export declare const generateInjectionContent: any;
export declare const installBatchWithRollback: any;
export declare const configureProviderGlobalAndProject: any;
export declare const getCanonicalSkillsDir: any;
export declare const parseSkillFile: any;
export declare const discoverSkill: any;
export declare const discoverSkills: any;
export declare const getTrackedSkills: any;
export declare const recordSkillInstall: any;
export declare const removeSkillFromLock: any;
export declare const checkSkillUpdate: any;
export declare const catalog: {
    getSkills: any;
    listSkills: any;
    getSkill: any;
    getCoreSkills: any;
    getSkillsByCategory: any;
    getDispatchMatrix: any;
    getManifest: any;
    getVersion: any;
    isCatalogAvailable: any;
    validateSkillFrontmatter: any;
    validateAll: any;
    getSkillDependencies: any;
    resolveDependencyTree: any;
    listProfiles: any;
    getProfile: any;
    resolveProfile: any;
    listSharedResources: any;
    getSharedResourcePath: any;
    readSharedResource: any;
    listProtocols: any;
    getProtocolPath: any;
    readProtocol: any;
    readSkillContent: any;
    getSkillPath: any;
    getSkillDir: any;
    getLibraryRoot: any;
};
//# sourceMappingURL=caamp.d.ts.map