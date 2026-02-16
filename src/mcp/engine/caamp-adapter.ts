/**
 * CAAMP Adapter
 *
 * Wraps @cleocode/caamp APIs for use by MCP domain handlers.
 * Provides provider registry, MCP config management, and injection
 * operations as EngineResult-returning functions matching the native
 * engine pattern.
 *
 * @task T4332
 */

import {
  // Provider Registry
  getAllProviders,
  getProvider,
  resolveAlias,
  detectAllProviders,
  getInstalledProviders,
  getProviderCount,
  getRegistryVersion,
  getInstructionFiles,
  // MCP Config
  installMcpServer,
  listMcpServers,
  listAllMcpServers,
  removeMcpServer,
  resolveConfigPath,
  buildServerConfig,
  // Instructions
  inject,
  checkInjection,
  checkAllInjections,
  injectAll,
  generateInjectionContent,
  // Types
  type Provider,
  type McpServerConfig,
  type DetectionResult,
  type InstallResult,
  type InjectionStatus,
} from '@cleocode/caamp';

import type { EngineResult } from './config-engine.js';

// Re-export EngineResult for consumers that import from this module
export type { EngineResult } from './config-engine.js';

// ============================================================
// Provider Operations
// ============================================================

/**
 * List all registered providers
 */
export function providerList(): EngineResult<Provider[]> {
  try {
    const providers = getAllProviders();
    return { success: true, data: providers };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'E_CAAMP_PROVIDER_LIST',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Get a single provider by ID or alias
 */
export function providerGet(idOrAlias: string): EngineResult<Provider> {
  try {
    const provider = getProvider(idOrAlias);
    if (!provider) {
      return {
        success: false,
        error: {
          code: 'E_CAAMP_PROVIDER_NOT_FOUND',
          message: `Provider not found: ${idOrAlias}`,
        },
      };
    }
    return { success: true, data: provider };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'E_CAAMP_PROVIDER_GET',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Detect all providers installed on the system
 */
export function providerDetect(): EngineResult<DetectionResult[]> {
  try {
    const results = detectAllProviders();
    return { success: true, data: results };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'E_CAAMP_PROVIDER_DETECT',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Get providers that are installed on the system
 */
export function providerInstalled(): EngineResult<Provider[]> {
  try {
    const providers = getInstalledProviders();
    return { success: true, data: providers };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'E_CAAMP_PROVIDER_INSTALLED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Get count of registered providers
 */
export function providerCount(): EngineResult<{ count: number }> {
  try {
    const count = getProviderCount();
    return { success: true, data: { count } };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'E_CAAMP_PROVIDER_COUNT',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Get CAAMP registry version
 */
export function registryVersion(): EngineResult<{ version: string }> {
  try {
    const version = getRegistryVersion();
    return { success: true, data: { version } };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'E_CAAMP_REGISTRY_VERSION',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ============================================================
// MCP Config Operations
// ============================================================

/**
 * List MCP servers for a specific provider
 */
export async function mcpList(
  providerId: string,
  scope: 'project' | 'global',
  projectDir?: string
): Promise<EngineResult<{ servers: unknown[] }>> {
  try {
    const provider = getProvider(providerId);
    if (!provider) {
      return {
        success: false,
        error: {
          code: 'E_CAAMP_PROVIDER_NOT_FOUND',
          message: `Provider not found: ${providerId}`,
        },
      };
    }
    const servers = await listMcpServers(provider, scope, projectDir);
    return { success: true, data: { servers } };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'E_CAAMP_MCP_LIST',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * List MCP servers across all installed providers
 */
export async function mcpListAll(
  scope: 'project' | 'global',
  projectDir?: string
): Promise<EngineResult<{ servers: unknown[] }>> {
  try {
    const providers = getInstalledProviders();
    const servers = await listAllMcpServers(providers, scope, projectDir);
    return { success: true, data: { servers } };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'E_CAAMP_MCP_LIST_ALL',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Install an MCP server to a provider's config
 */
export async function mcpInstall(
  providerId: string,
  serverName: string,
  config: McpServerConfig,
  scope?: 'project' | 'global',
  projectDir?: string
): Promise<EngineResult<InstallResult>> {
  try {
    const provider = getProvider(providerId);
    if (!provider) {
      return {
        success: false,
        error: {
          code: 'E_CAAMP_PROVIDER_NOT_FOUND',
          message: `Provider not found: ${providerId}`,
        },
      };
    }
    const result = await installMcpServer(provider, serverName, config, scope, projectDir);
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'E_CAAMP_MCP_INSTALL',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Remove an MCP server from a provider's config
 */
export async function mcpRemove(
  providerId: string,
  serverName: string,
  scope: 'project' | 'global',
  projectDir?: string
): Promise<EngineResult<{ removed: boolean }>> {
  try {
    const provider = getProvider(providerId);
    if (!provider) {
      return {
        success: false,
        error: {
          code: 'E_CAAMP_PROVIDER_NOT_FOUND',
          message: `Provider not found: ${providerId}`,
        },
      };
    }
    const removed = await removeMcpServer(provider, serverName, scope, projectDir);
    return { success: true, data: { removed } };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'E_CAAMP_MCP_REMOVE',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Resolve the config file path for a provider
 */
export function mcpConfigPath(
  providerId: string,
  scope: 'project' | 'global',
  projectDir?: string
): EngineResult<{ path: string | null }> {
  try {
    const provider = getProvider(providerId);
    if (!provider) {
      return {
        success: false,
        error: {
          code: 'E_CAAMP_PROVIDER_NOT_FOUND',
          message: `Provider not found: ${providerId}`,
        },
      };
    }
    const path = resolveConfigPath(provider, scope, projectDir);
    return { success: true, data: { path } };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'E_CAAMP_MCP_CONFIG_PATH',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ============================================================
// Injection Operations
// ============================================================

/**
 * Check injection status for a single file
 */
export async function injectionCheck(
  filePath: string,
  expectedContent?: string
): Promise<EngineResult<InjectionStatus>> {
  try {
    const status = await checkInjection(filePath, expectedContent);
    return { success: true, data: status };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'E_CAAMP_INJECTION_CHECK',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Check injection status across all providers
 */
export async function injectionCheckAll(
  projectDir: string,
  scope: 'project' | 'global',
  expectedContent?: string
): Promise<EngineResult<{ results: unknown[] }>> {
  try {
    const providers = getInstalledProviders();
    const results = await checkAllInjections(providers, projectDir, scope, expectedContent);
    return { success: true, data: { results } };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'E_CAAMP_INJECTION_CHECK_ALL',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Inject or update content in a single file
 */
export async function injectionUpdate(
  filePath: string,
  content: string
): Promise<EngineResult<{ action: string }>> {
  try {
    const action = await inject(filePath, content);
    return { success: true, data: { action } };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'E_CAAMP_INJECTION_UPDATE',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Inject content to all providers' instruction files
 */
export async function injectionUpdateAll(
  projectDir: string,
  scope: 'project' | 'global',
  content: string
): Promise<EngineResult<{ results: Record<string, string> }>> {
  try {
    const providers = getInstalledProviders();
    const resultMap = await injectAll(providers, projectDir, scope, content);
    // Convert Map to plain object for serialization
    const results: Record<string, string> = {};
    resultMap.forEach((action, key) => {
      results[key] = action;
    });
    return { success: true, data: { results } };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'E_CAAMP_INJECTION_UPDATE_ALL',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ============================================================
// Utility Re-exports (passthrough, no EngineResult wrapping)
// ============================================================

export {
  resolveAlias as caampResolveAlias,
  buildServerConfig as caampBuildServerConfig,
  generateInjectionContent as caampGenerateInjectionContent,
  getInstructionFiles as caampGetInstructionFiles,
};
