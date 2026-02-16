/**
 * Config Engine
 *
 * Native TypeScript implementation for reading/writing .cleo/config.json.
 */

import { readJsonFile, writeJsonFileAtomic, getDataPath } from './store.js';
import { existsSync, writeFileSync } from 'fs';

import * as lockfile from 'proper-lockfile';

/**
 * Engine result wrapper
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

/**
 * Get config value by key (dot-notation supported)
 */
export function configGet(
  projectRoot: string,
  key?: string
): EngineResult<unknown> {
  const configPath = getDataPath(projectRoot, 'config.json');
  const config = readJsonFile<Record<string, unknown>>(configPath);

  if (!config) {
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'No config.json found' },
    };
  }

  if (!key) {
    // Return all config
    return { success: true, data: config };
  }

  // Dot-notation navigation
  const parts = key.split('.');
  let current: unknown = config;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return {
        success: false,
        error: {
          code: 'E_CONFIG_KEY_NOT_FOUND',
          message: `Config key '${key}' not found`,
        },
      };
    }
    current = (current as Record<string, unknown>)[part];
  }

  if (current === undefined) {
    return {
      success: false,
      error: {
        code: 'E_CONFIG_KEY_NOT_FOUND',
        message: `Config key '${key}' not found`,
      },
    };
  }

  return { success: true, data: current };
}

/**
 * Set a config value by key (dot-notation supported)
 */
export async function configSet(
  projectRoot: string,
  key: string,
  value: unknown
): Promise<EngineResult<{ key: string; value: unknown }>> {
  const configPath = getDataPath(projectRoot, 'config.json');

  // Ensure file exists for locking
  if (!existsSync(configPath)) {
    writeFileSync(configPath, '{}', 'utf-8');
  }

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(configPath, {
      retries: { retries: 5, factor: 2, minTimeout: 100, maxTimeout: 5000 },
      stale: 30000,
    });

    const config = readJsonFile<Record<string, unknown>>(configPath) || {};

    // Dot-notation navigation to set
    const parts = key.split('.');
    let target: Record<string, unknown> = config;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (target[part] === undefined || typeof target[part] !== 'object') {
        target[part] = {};
      }
      target = target[part] as Record<string, unknown>;
    }

    const lastPart = parts[parts.length - 1];

    // Parse value if it looks like JSON
    let parsedValue = value;
    if (typeof value === 'string') {
      if (value === 'true') parsedValue = true;
      else if (value === 'false') parsedValue = false;
      else if (value === 'null') parsedValue = null;
      else if (/^-?\d+$/.test(value)) parsedValue = parseInt(value, 10);
      else if (/^-?\d+\.\d+$/.test(value)) parsedValue = parseFloat(value);
      else {
        try {
          parsedValue = JSON.parse(value);
        } catch {
          // Keep as string
        }
      }
    }

    target[lastPart] = parsedValue;

    writeJsonFileAtomic(configPath, config);

    return { success: true, data: { key, value: parsedValue } };
  } finally {
    if (release) {
      await release();
    }
  }
}
