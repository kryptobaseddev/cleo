/**
 * Manual Jest mock for @cleocode/caamp
 *
 * Required because caamp is ESM-only (uses import.meta.url) which is
 * incompatible with Jest's CJS runtime. This mock provides stub
 * implementations for all imported functions.
 *
 * @task T4409
 */

// Provider Registry
export const getAllProviders = vi.fn(() => []);
export const getProvider = vi.fn(() => null);
export const resolveAlias = vi.fn((alias: string) => alias);
export const detectAllProviders = vi.fn(() => []);
export const getInstalledProviders = vi.fn(() => []);
export const getProviderCount = vi.fn(() => 0);
export const getRegistryVersion = vi.fn(() => '0.0.0-mock');
export const getInstructionFiles = vi.fn(() => []);

// MCP Config
export const installMcpServer = vi.fn(async () => ({ installed: false }));
export const listMcpServers = vi.fn(async () => []);
export const listAllMcpServers = vi.fn(async () => []);
export const removeMcpServer = vi.fn(async () => false);
export const resolveConfigPath = vi.fn(() => null);
export const buildServerConfig = vi.fn(() => ({}));

// Instructions
export const inject = vi.fn(async () => 'skipped');
export const checkInjection = vi.fn(async () => ({ injected: false }));
export const checkAllInjections = vi.fn(async () => []);
export const injectAll = vi.fn(async () => new Map());
export const generateInjectionContent = vi.fn(() => '');

// Batch / Orchestration
export const installBatchWithRollback = vi.fn(async () => ({ success: true, results: [], rolledBack: false }));
export const configureProviderGlobalAndProject = vi.fn(async () => ({ global: { success: true }, project: { success: true } }));

// Skills (catalog)
export const getCanonicalSkillsDir = vi.fn(() => '/mock/.agents/skills');
export const parseSkillFile = vi.fn(async () => null);
export const discoverSkill = vi.fn(async () => null);
export const discoverSkills = vi.fn(async () => []);
export const getTrackedSkills = vi.fn(async () => ({}));
export const recordSkillInstall = vi.fn(async () => {});
export const removeSkillFromLock = vi.fn(async () => false);
export const checkSkillUpdate = vi.fn(async () => ({ needsUpdate: false }));
export const catalog = {
  getSkills: vi.fn(() => []),
  listSkills: vi.fn(() => []),
  getSkill: vi.fn(() => undefined),
  getCoreSkills: vi.fn(() => []),
  getSkillsByCategory: vi.fn(() => []),
  getDispatchMatrix: vi.fn(() => ({ by_task_type: {}, by_keyword: {}, by_protocol: {} })),
  getManifest: vi.fn(() => ({ $schema: '', _meta: {}, dispatch_matrix: {}, skills: [] })),
  getVersion: vi.fn(() => '0.0.0-mock'),
  isCatalogAvailable: vi.fn(() => false),
  validateSkillFrontmatter: vi.fn(() => ({ valid: true, issues: [] })),
  validateAll: vi.fn(() => new Map()),
  getSkillDependencies: vi.fn(() => []),
  resolveDependencyTree: vi.fn(() => []),
  listProfiles: vi.fn(() => []),
  getProfile: vi.fn(() => undefined),
  resolveProfile: vi.fn(() => []),
  listSharedResources: vi.fn(() => []),
  getSharedResourcePath: vi.fn(() => undefined),
  readSharedResource: vi.fn(() => undefined),
  listProtocols: vi.fn(() => []),
  getProtocolPath: vi.fn(() => undefined),
  readProtocol: vi.fn(() => undefined),
  readSkillContent: vi.fn(() => ''),
  getSkillPath: vi.fn(() => ''),
  getSkillDir: vi.fn(() => ''),
  getLibraryRoot: vi.fn(() => ''),
};
