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
