/**
 * CAAMP Adapter - Canonical implementation
 *
 * Wraps @cleocode/caamp APIs for use across CLEO subsystems.
 * Provides provider registry, MCP config management, injection operations,
 * and batch/orchestration functions as EngineResult-returning functions.
 *
 * This is the SINGLE SOURCE OF TRUTH for all CAAMP adapter logic.
 * MCP engine layer re-exports from here.
 *
 * @task T4678
 * @task T4705
 * @epic T4663
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
  // Batch / Orchestration
  installBatchWithRollback,
  configureProviderGlobalAndProject,
  // Types
  type Provider,
  type McpServerConfig,
  type DetectionResult,
  type InstallResult,
  type InjectionStatus,
  type BatchInstallOptions,
  type BatchInstallResult,
  type DualScopeConfigureOptions,
  type DualScopeConfigureResult,
} from '@cleocode/caamp';

// ============================================================
// EngineResult type (shared interface for engine-layer responses)
// ============================================================

/**
 * Generic result wrapper for engine-layer operations.
 * @task T4678
 */
export interface EngineResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// ============================================================
// Provider Operations
// ============================================================

/**
 * List all registered providers.
 * @task T4332
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
 * Get a single provider by ID or alias.
 * @task T4332
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
 * Detect all providers installed on the system.
 * @task T4332
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
 * Get providers that are installed on the system.
 * @task T4332
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
 * Get count of registered providers.
 * @task T4332
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
 * Get CAAMP registry version.
 * @task T4332
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
 * List MCP servers for a specific provider.
 * @task T4332
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
 * List MCP servers across all installed providers.
 * @task T4332
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
 * Install an MCP server to a provider's config.
 * @task T4332
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
 * Remove an MCP server from a provider's config.
 * @task T4332
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
 * Resolve the config file path for a provider.
 * @task T4332
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
 * Check injection status for a single file.
 * @task T4332
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
 * Check injection status across all providers.
 * @task T4332
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
 * Inject or update content in a single file.
 * @task T4332
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
 * Inject content to all providers' instruction files.
 * @task T4332
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
// Batch / Orchestration Operations (T4705)
// ============================================================

/**
 * Install multiple MCP servers atomically with rollback on failure.
 * Supports Wave 4 init rewrite which needs to install multiple
 * skills/configs as a single atomic operation.
 *
 * @task T4705
 * @epic T4663
 */
export async function batchInstallWithRollback(
  options: BatchInstallOptions
): Promise<EngineResult<BatchInstallResult>> {
  try {
    const result = await installBatchWithRollback(options);
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'E_CAAMP_BATCH_INSTALL',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Configure a provider at both global and project scope simultaneously.
 * Used during init to set up MCP configs in both scopes atomically.
 *
 * @task T4705
 * @epic T4663
 */
export async function dualScopeConfigure(
  providerId: string,
  options: DualScopeConfigureOptions
): Promise<EngineResult<DualScopeConfigureResult>> {
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
    const result = await configureProviderGlobalAndProject(provider, options);
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'E_CAAMP_DUAL_SCOPE_CONFIGURE',
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

// Re-export CAAMP types for downstream consumers
export type {
  Provider as CaampProvider,
  McpServerConfig as CaampMcpServerConfig,
  DetectionResult as CaampDetectionResult,
  InstallResult as CaampInstallResult,
  InjectionStatus as CaampInjectionStatus,
  BatchInstallOptions as CaampBatchInstallOptions,
  BatchInstallResult as CaampBatchInstallResult,
  DualScopeConfigureOptions as CaampDualScopeConfigureOptions,
  DualScopeConfigureResult as CaampDualScopeConfigureResult,
};
