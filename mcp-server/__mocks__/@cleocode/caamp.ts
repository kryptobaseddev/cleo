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
export const getAllProviders = jest.fn(() => []);
export const getProvider = jest.fn(() => null);
export const resolveAlias = jest.fn((alias: string) => alias);
export const detectAllProviders = jest.fn(() => []);
export const getInstalledProviders = jest.fn(() => []);
export const getProviderCount = jest.fn(() => 0);
export const getRegistryVersion = jest.fn(() => '0.0.0-mock');
export const getInstructionFiles = jest.fn(() => []);

// MCP Config
export const installMcpServer = jest.fn(async () => ({ installed: false }));
export const listMcpServers = jest.fn(async () => []);
export const listAllMcpServers = jest.fn(async () => []);
export const removeMcpServer = jest.fn(async () => false);
export const resolveConfigPath = jest.fn(() => null);
export const buildServerConfig = jest.fn(() => ({}));

// Instructions
export const inject = jest.fn(async () => 'skipped');
export const checkInjection = jest.fn(async () => ({ injected: false }));
export const checkAllInjections = jest.fn(async () => []);
export const injectAll = jest.fn(async () => new Map());
export const generateInjectionContent = jest.fn(() => '');
