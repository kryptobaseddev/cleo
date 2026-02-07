/**
 * Configuration loader for CLEO MCP Server
 *
 * Loads configuration from:
 * 1. Environment variables (CLEO_MCP_*)
 * 2. Config file (.cleo/config.json)
 * 3. Defaults (fallback values)
 *
 * @task T2928
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  MCPConfig,
  DEFAULT_CONFIG,
  DEFAULT_LIFECYCLE_ENFORCEMENT,
  DEFAULT_PROTOCOL_VALIDATION,
  ENV_PREFIX,
  CONFIG_SCHEMA,
  LifecycleEnforcementConfig,
  ProtocolValidationConfig,
} from './defaults.js';

/**
 * Configuration validation error
 */
export class ConfigValidationError extends Error {
  constructor(
    public field: string,
    public value: unknown,
    public constraint: string
  ) {
    super(`Invalid config field '${field}': ${constraint} (got ${value})`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Load configuration value from environment variable
 */
function loadFromEnv(key: string): string | undefined {
  const envKey = `${ENV_PREFIX}${key.toUpperCase()}`;
  return process.env[envKey];
}

/**
 * Parse environment variable to appropriate type
 */
function parseEnvValue(key: string, value: string): unknown {
  const schema = CONFIG_SCHEMA[key as keyof typeof CONFIG_SCHEMA];

  if (schema.type === 'boolean') {
    return value.toLowerCase() === 'true' || value === '1';
  }

  if (schema.type === 'number') {
    const num = parseInt(value, 10);
    if (isNaN(num)) {
      throw new ConfigValidationError(key, value, 'must be a number');
    }
    return num;
  }

  return value;
}

/**
 * Load configuration from .cleo/config.json file
 */
function loadFromFile(projectRoot?: string): Partial<MCPConfig> {
  const root = projectRoot || process.cwd();
  const configPath = join(root, '.cleo', 'config.json');

  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);

    // Extract MCP-specific config if nested
    const result: Partial<MCPConfig> = {};

    if (config.mcp) {
      if (config.mcp.cliPath !== undefined) result.cliPath = config.mcp.cliPath;
      if (config.mcp.timeout !== undefined) result.timeout = config.mcp.timeout;
      if (config.mcp.logLevel !== undefined) result.logLevel = config.mcp.logLevel;
      if (config.mcp.enableMetrics !== undefined) result.enableMetrics = config.mcp.enableMetrics;
      if (config.mcp.maxRetries !== undefined) result.maxRetries = config.mcp.maxRetries;
      if (config.mcp.features?.queryCache !== undefined) result.queryCache = config.mcp.features.queryCache;
      if (config.mcp.features?.queryCacheTtl !== undefined) result.queryCacheTtl = config.mcp.features.queryCacheTtl;
      if (config.mcp.features?.auditLog !== undefined) result.auditLog = config.mcp.features.auditLog;
      if (config.mcp.features?.strictValidation !== undefined) result.strictValidation = config.mcp.features.strictValidation;
    }

    // Extract lifecycle enforcement config (Section 12.2)
    if (config.lifecycleEnforcement) {
      result.lifecycleEnforcement = {
        ...DEFAULT_LIFECYCLE_ENFORCEMENT,
        ...config.lifecycleEnforcement,
      };
    }

    // Extract protocol validation config (Section 12.3)
    if (config.protocolValidation) {
      result.protocolValidation = {
        ...DEFAULT_PROTOCOL_VALIDATION,
        ...config.protocolValidation,
      };
    }

    // If no mcp block, check for flat config keys
    if (!config.mcp) {
      return config;
    }

    return result;
  } catch (error) {
    // Log error but don't fail - fall back to defaults
    console.error(`Warning: Failed to load config file: ${error}`);
    return {};
  }
}

/**
 * Validate configuration field
 */
function validateField(key: string, value: unknown): void {
  const schema = CONFIG_SCHEMA[key as keyof typeof CONFIG_SCHEMA];

  if (!schema) {
    return; // Unknown fields are ignored
  }

  // Type check
  const actualType = typeof value;
  if (actualType !== schema.type) {
    throw new ConfigValidationError(
      key,
      value,
      `must be of type ${schema.type}`
    );
  }

  // Enum check
  if ('enum' in schema && schema.enum && !schema.enum.includes(value as never)) {
    throw new ConfigValidationError(
      key,
      value,
      `must be one of: ${schema.enum.join(', ')}`
    );
  }

  // Range check for numbers
  if (schema.type === 'number') {
    const numValue = value as number;
    if ('min' in schema && numValue < schema.min) {
      throw new ConfigValidationError(
        key,
        value,
        `must be >= ${schema.min}`
      );
    }
    if ('max' in schema && numValue > schema.max) {
      throw new ConfigValidationError(
        key,
        value,
        `must be <= ${schema.max}`
      );
    }
  }
}

/**
 * Validate complete configuration
 */
export function validateConfig(config: MCPConfig): void {
  for (const [key, value] of Object.entries(config)) {
    validateField(key, value);
  }

  // Required field check
  for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
    if ('required' in schema && schema.required) {
      if (config[key as keyof MCPConfig] === undefined) {
        throw new ConfigValidationError(key, undefined, 'is required');
      }
    }
  }
}

/**
 * Load configuration from all sources
 *
 * Priority order:
 * 1. Environment variables (CLEO_MCP_*)
 * 2. Config file (.cleo/config.json)
 * 3. Defaults
 */
export function loadConfig(projectRoot?: string): MCPConfig {
  // Start with defaults (deep copy nested objects)
  const config: MCPConfig = {
    ...DEFAULT_CONFIG,
    lifecycleEnforcement: { ...DEFAULT_LIFECYCLE_ENFORCEMENT },
    protocolValidation: { ...DEFAULT_PROTOCOL_VALIDATION },
  };

  // Load from file (overrides defaults)
  const fileConfig = loadFromFile(projectRoot);
  // Merge nested objects carefully
  if (fileConfig.lifecycleEnforcement) {
    config.lifecycleEnforcement = {
      ...config.lifecycleEnforcement,
      ...fileConfig.lifecycleEnforcement,
    };
    delete (fileConfig as any).lifecycleEnforcement;
  }
  if (fileConfig.protocolValidation) {
    config.protocolValidation = {
      ...config.protocolValidation,
      ...fileConfig.protocolValidation,
    };
    delete (fileConfig as any).protocolValidation;
  }
  Object.assign(config, fileConfig);

  // Load from environment (overrides file and defaults)
  for (const key of Object.keys(DEFAULT_CONFIG) as Array<keyof MCPConfig>) {
    const envValue = loadFromEnv(key);
    if (envValue !== undefined) {
      config[key] = parseEnvValue(key, envValue) as never;
    }
  }

  // Validate final configuration
  validateConfig(config);

  return config;
}

/**
 * Global configuration singleton
 * Loaded once at module initialization
 */
let globalConfig: MCPConfig | null = null;

/**
 * Get global configuration (singleton)
 */
export function getConfig(): MCPConfig {
  if (globalConfig === null) {
    globalConfig = loadConfig();
  }
  return globalConfig;
}

/**
 * Reset global configuration (for testing)
 */
export function resetConfig(): void {
  globalConfig = null;
}
