/**
 * Configuration loader for CLEO dispatch layer.
 *
 * Loads configuration from:
 * 1. Environment variables (CLEO_*)
 * 2. Config file (.cleo/config.json)
 * 3. Defaults (fallback values)
 *
 * @task T2928
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { CLEO_DIR_NAME, CONFIG_JSON } from '../../cli/paths.js';
import {
  CONFIG_SCHEMA,
  DEFAULT_CONFIG,
  DEFAULT_LIFECYCLE_ENFORCEMENT,
  DEFAULT_PROTOCOL_VALIDATION,
  DEFAULT_RATE_LIMITING,
  type DispatchConfig,
  ENV_PREFIX,
} from './defaults.js';

/**
 * Configuration validation error
 */
export class ConfigValidationError extends Error {
  constructor(
    public field: string,
    public value: unknown,
    public constraint: string,
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
    if (Number.isNaN(num)) {
      throw new ConfigValidationError(key, value, 'must be a number');
    }
    return num;
  }

  return value;
}

/**
 * Load configuration from .cleo/config.json file
 */
function loadFromFile(projectRoot?: string): Partial<DispatchConfig> {
  const root = projectRoot || process.cwd();
  const configPath = join(root, CLEO_DIR_NAME, CONFIG_JSON);

  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);

    // Extract config values
    const result: Partial<DispatchConfig> = {};

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

    // Extract rate limiting config
    if (config.rateLimiting) {
      const rlConfig = config.rateLimiting;
      result.rateLimiting = {
        ...DEFAULT_RATE_LIMITING,
        ...rlConfig,
        query: { ...DEFAULT_RATE_LIMITING.query, ...rlConfig?.query },
        mutate: { ...DEFAULT_RATE_LIMITING.mutate, ...rlConfig?.mutate },
        spawn: { ...DEFAULT_RATE_LIMITING.spawn, ...rlConfig?.spawn },
      };
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
    throw new ConfigValidationError(key, value, `must be of type ${schema.type}`);
  }

  // Enum check
  if ('enum' in schema && schema.enum && !schema.enum.includes(value as never)) {
    throw new ConfigValidationError(key, value, `must be one of: ${schema.enum.join(', ')}`);
  }

  // Range check for numbers
  if (schema.type === 'number') {
    const numValue = value as number;
    if ('min' in schema && numValue < schema.min) {
      throw new ConfigValidationError(key, value, `must be >= ${schema.min}`);
    }
    if ('max' in schema && numValue > schema.max) {
      throw new ConfigValidationError(key, value, `must be <= ${schema.max}`);
    }
  }
}

/**
 * Validate complete configuration
 */
export function validateConfig(config: DispatchConfig): void {
  for (const [key, value] of Object.entries(config)) {
    validateField(key, value);
  }

  // Required field check
  for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
    if ('required' in schema && schema.required) {
      if (config[key as keyof DispatchConfig] === undefined) {
        throw new ConfigValidationError(key, undefined, 'is required');
      }
    }
  }
}

/**
 * Load configuration from all sources
 *
 * Priority order:
 * 1. Environment variables (CLEO_*)
 * 2. Config file (.cleo/config.json)
 * 3. Defaults
 */
export function loadConfig(projectRoot?: string): DispatchConfig {
  // Start with defaults (deep copy nested objects)
  const config: DispatchConfig = {
    ...DEFAULT_CONFIG,
    lifecycleEnforcement: { ...DEFAULT_LIFECYCLE_ENFORCEMENT },
    protocolValidation: { ...DEFAULT_PROTOCOL_VALIDATION },
    rateLimiting: {
      ...DEFAULT_RATE_LIMITING,
      query: { ...DEFAULT_RATE_LIMITING.query },
      mutate: { ...DEFAULT_RATE_LIMITING.mutate },
      spawn: { ...DEFAULT_RATE_LIMITING.spawn },
    },
  };

  // Load from file (overrides defaults)
  const fileConfig = loadFromFile(projectRoot);
  // Merge nested objects carefully
  // Destructure nested config fields to merge them deeply, then spread the rest shallowly
  const {
    lifecycleEnforcement: fileLc,
    protocolValidation: filePv,
    rateLimiting: fileRl,
    ...restFileConfig
  } = fileConfig;

  if (fileLc) {
    config.lifecycleEnforcement = { ...config.lifecycleEnforcement, ...fileLc };
  }
  if (filePv) {
    config.protocolValidation = { ...config.protocolValidation, ...filePv };
  }
  if (fileRl) {
    config.rateLimiting = {
      ...config.rateLimiting,
      ...fileRl,
      query: { ...config.rateLimiting.query, ...fileRl.query },
      mutate: { ...config.rateLimiting.mutate, ...fileRl.mutate },
      spawn: { ...config.rateLimiting.spawn, ...fileRl.spawn },
    };
  }
  Object.assign(config, restFileConfig);

  // Load from environment (overrides file and defaults)
  for (const key of Object.keys(DEFAULT_CONFIG) as Array<keyof DispatchConfig>) {
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
let globalConfig: DispatchConfig | null = null;

/**
 * Get global configuration (singleton)
 */
export function getConfig(): DispatchConfig {
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
