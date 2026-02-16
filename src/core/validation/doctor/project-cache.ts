/**
 * Project validation caching - ported from lib/validation/doctor-project-cache.sh
 *
 * Caches validation results per project with TTL-based invalidation
 * and file hash comparison for cache freshness.
 *
 * @task T4525
 * @epic T4454
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

// ============================================================================
// Types
// ============================================================================

export interface SchemaVersions {
  todo?: string;
  config?: string;
  archive?: string;
  log?: string;
}

export interface FileHashes {
  'todo.json'?: string;
  'config.json'?: string;
  'todo-archive.json'?: string;
  'todo-log.json'?: string;
}

export interface ProjectCacheEntry {
  path: string;
  lastValidated: string;
  validationStatus: 'passed' | 'failed' | 'warning';
  schemaVersions: SchemaVersions;
  fileHashes: FileHashes;
  issues: string[];
  ttl: number;
}

export interface DoctorProjectCache {
  version: string;
  lastUpdated: string;
  projects: Record<string, ProjectCacheEntry>;
}

// ============================================================================
// Constants
// ============================================================================

export const CACHE_VERSION = '1.0.0';
export const CACHE_TTL_SECONDS = 300; // 5 minutes
const CACHE_FILE = 'doctor-project-cache.json';

// ============================================================================
// Cache Operations
// ============================================================================

/**
 * Get cache file path.
 * @task T4525
 */
export function getCacheFilePath(cleoHome?: string): string {
  const home = cleoHome ?? join(homedir(), '.cleo');
  return join(home, CACHE_FILE);
}

/**
 * Initialize empty cache file.
 * @task T4525
 */
export function initCacheFile(cacheFile: string): DoctorProjectCache {
  const cache: DoctorProjectCache = {
    version: CACHE_VERSION,
    lastUpdated: new Date().toISOString(),
    projects: {},
  };

  const dir = dirname(cacheFile);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  return cache;
}

/**
 * Load cache file or return null if missing/invalid.
 * @task T4525
 */
export function loadCache(cacheFile: string): DoctorProjectCache | null {
  if (!existsSync(cacheFile)) return null;

  try {
    const content = readFileSync(cacheFile, 'utf-8');
    return JSON.parse(content) as DoctorProjectCache;
  } catch {
    return null;
  }
}

/**
 * Get file hash for cache invalidation.
 * @task T4525
 */
export function getFileHash(filePath: string): string {
  if (!existsSync(filePath)) return '';

  try {
    const content = readFileSync(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return '';
  }
}

/**
 * Check if project validation is cached and valid.
 * Returns the cache entry if valid, null if cache miss.
 * @task T4525
 */
export function getCachedValidation(
  projectHash: string,
  projectPath: string,
  cacheFile?: string,
): ProjectCacheEntry | null {
  const cachePath = cacheFile ?? getCacheFilePath();
  const cache = loadCache(cachePath);
  if (!cache) return null;

  const entry = cache.projects[projectHash];
  if (!entry) return null;

  // Verify path matches
  if (entry.path !== projectPath) return null;

  // Check TTL
  const lastValidated = new Date(entry.lastValidated).getTime();
  const now = Date.now();
  const age = (now - lastValidated) / 1000;
  if (age > (entry.ttl || CACHE_TTL_SECONDS)) return null;

  // Check file hashes for invalidation
  const currentTodoHash = getFileHash(join(projectPath, '.cleo', 'todo.json'));
  const currentConfigHash = getFileHash(join(projectPath, '.cleo', 'config.json'));

  if (currentTodoHash !== (entry.fileHashes['todo.json'] ?? '')) return null;
  if (currentConfigHash !== (entry.fileHashes['config.json'] ?? '')) return null;

  return entry;
}

/**
 * Cache project validation results.
 * @task T4525
 */
export function cacheValidationResult(
  projectHash: string,
  projectPath: string,
  validationStatus: 'passed' | 'failed' | 'warning',
  issues: string[] = [],
  schemaVersions: SchemaVersions = {},
  cacheFile?: string,
): void {
  const cachePath = cacheFile ?? getCacheFilePath();
  let cache = loadCache(cachePath);

  if (!cache) {
    cache = initCacheFile(cachePath);
  }

  const todoHash = getFileHash(join(projectPath, '.cleo', 'todo.json'));
  const configHash = getFileHash(join(projectPath, '.cleo', 'config.json'));
  const archiveHash = getFileHash(join(projectPath, '.cleo', 'todo-archive.json'));
  const logHash = getFileHash(join(projectPath, '.cleo', 'todo-log.json'));

  const timestamp = new Date().toISOString();

  cache.projects[projectHash] = {
    path: projectPath,
    lastValidated: timestamp,
    validationStatus,
    schemaVersions,
    fileHashes: {
      'todo.json': todoHash,
      'config.json': configHash,
      'todo-archive.json': archiveHash,
      'todo-log.json': logHash,
    },
    issues,
    ttl: CACHE_TTL_SECONDS,
  };

  cache.lastUpdated = timestamp;

  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

/**
 * Clear cache for a specific project.
 * @task T4525
 */
export function clearProjectCache(
  projectHash: string,
  cacheFile?: string,
): void {
  const cachePath = cacheFile ?? getCacheFilePath();
  const cache = loadCache(cachePath);
  if (!cache) return;

  delete cache.projects[projectHash];
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

/**
 * Clear entire cache.
 * @task T4525
 */
export function clearEntireCache(cacheFile?: string): void {
  const cachePath = cacheFile ?? getCacheFilePath();
  if (existsSync(cachePath)) {
    unlinkSync(cachePath);
  }
  initCacheFile(cachePath);
}
