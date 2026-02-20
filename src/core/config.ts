/**
 * Configuration engine for CLEO V2.
 *
 * Resolution priority: CLI flags > Environment vars > Project config > Global config > Defaults
 *
 * @epic T4454
 * @task T4458
 */

import type { CleoConfig, ConfigSource, ResolvedValue } from '../types/config.js';
import { readJson } from '../store/json.js';
import { getConfigPath, getGlobalConfigPath } from './paths.js';

/** Default configuration values. */
const DEFAULTS: CleoConfig = {
  version: '2.10.0',
  output: {
    defaultFormat: 'json',
    showColor: true,
    showUnicode: true,
    showProgressBars: true,
    dateFormat: 'relative',
  },
  backup: {
    maxOperationalBackups: 10,
    maxSafetyBackups: 5,
    compressionEnabled: false,
  },
  hierarchy: {
    maxDepth: 3,
    maxSiblings: 7,
    cascadeDelete: false,
  },
  session: {
    autoStart: false,
    requireNotes: false,
    multiSession: false,
  },
  lifecycle: {
    mode: 'strict',
  },
};

/** Environment variable to config path mapping. */
const ENV_MAP: Record<string, string> = {
  'CLEO_FORMAT': 'output.defaultFormat',
  'CLEO_OUTPUT_DEFAULT_FORMAT': 'output.defaultFormat',
  'CLEO_OUTPUT_SHOW_COLOR': 'output.showColor',
  'CLEO_OUTPUT_SHOW_UNICODE': 'output.showUnicode',
  'CLEO_OUTPUT_SHOW_PROGRESS_BARS': 'output.showProgressBars',
  'CLEO_OUTPUT_DATE_FORMAT': 'output.dateFormat',
  'CLEO_HIERARCHY_MAX_DEPTH': 'hierarchy.maxDepth',
  'CLEO_HIERARCHY_MAX_SIBLINGS': 'hierarchy.maxSiblings',
  'CLEO_SESSION_AUTO_START': 'session.autoStart',
  'CLEO_SESSION_REQUIRE_NOTES': 'session.requireNotes',
  'CLEO_LIFECYCLE_MODE': 'lifecycle.mode',
};

/**
 * Get a value at a dotted path from an object.
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Set a value at a dotted path in an object (mutates).
 */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (current[part] === undefined || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

/**
 * Deep merge two objects. Source values override target values.
 * Arrays are replaced (not merged).
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = result[key];
    if (
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else {
      result[key] = sourceVal;
    }
  }
  return result;
}

/**
 * Parse an environment variable value to the appropriate type.
 */
function parseEnvValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') return num;
  return value;
}

/**
 * Load and merge configuration from all sources.
 * Priority: defaults < global config < project config < environment vars
 */
export async function loadConfig(cwd?: string): Promise<CleoConfig> {
  // Start with defaults
  let merged: Record<string, unknown> = JSON.parse(JSON.stringify(DEFAULTS));

  // Layer 1: Global config
  const globalConfig = await readJson<Record<string, unknown>>(getGlobalConfigPath());
  if (globalConfig) {
    merged = deepMerge(merged, globalConfig);
  }

  // Layer 2: Project config
  const projectConfig = await readJson<Record<string, unknown>>(getConfigPath(cwd));
  if (projectConfig) {
    merged = deepMerge(merged, projectConfig);
  }

  // Layer 3: Environment variables
  for (const [envKey, configPath] of Object.entries(ENV_MAP)) {
    const envValue = process.env[envKey];
    if (envValue !== undefined) {
      setNestedValue(merged, configPath, parseEnvValue(envValue));
    }
  }

  return merged as unknown as CleoConfig;
}

/**
 * Get a single config value with source tracking.
 * Returns the value and which source it came from.
 */
export async function getConfigValue<T>(
  path: string,
  cwd?: string,
): Promise<ResolvedValue<T>> {
  // Check environment variables first
  for (const [envKey, configPath] of Object.entries(ENV_MAP)) {
    if (configPath === path && process.env[envKey] !== undefined) {
      return {
        value: parseEnvValue(process.env[envKey]!) as T,
        source: 'env' as ConfigSource,
      };
    }
  }

  // Check project config
  const projectConfig = await readJson<Record<string, unknown>>(getConfigPath(cwd));
  if (projectConfig) {
    const val = getNestedValue(projectConfig, path);
    if (val !== undefined) {
      return { value: val as T, source: 'project' as ConfigSource };
    }
  }

  // Check global config
  const globalConfig = await readJson<Record<string, unknown>>(getGlobalConfigPath());
  if (globalConfig) {
    const val = getNestedValue(globalConfig, path);
    if (val !== undefined) {
      return { value: val as T, source: 'global' as ConfigSource };
    }
  }

  // Fall back to defaults
  const defaultVal = getNestedValue(DEFAULTS as unknown as Record<string, unknown>, path);
  return { value: defaultVal as T, source: 'default' as ConfigSource };
}
