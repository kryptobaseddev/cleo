/**
 * Cached manifest generation and resolution.
 * Ports lib/skills/manifest-resolver.sh.
 *
 * Generates and caches a unified skills manifest by scanning all search paths.
 * Uses TTL-based cache with graceful degradation.
 *
 * @epic T4454
 * @task T4520
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillManifest } from '../types.js';
import { generateManifest } from '../discovery.js';
import { getCleoHome } from '../../paths.js';

// ============================================================================
// Cache Configuration
// ============================================================================

const DEFAULT_CACHE_TTL = 300; // 5 minutes in seconds

/**
 * Get the manifest cache directory.
 */
function getCacheDir(): string {
  return process.env['CLEO_MANIFEST_CACHE_DIR'] ?? join(getCleoHome(), 'cache');
}

/**
 * Get the cached manifest file path.
 */
function getCachedManifestPath(): string {
  return join(getCacheDir(), 'skills-manifest.json');
}

// ============================================================================
// Cache Management
// ============================================================================

/**
 * Check if the cached manifest is fresh (within TTL).
 * @task T4520
 */
export function isCacheFresh(cachePath?: string): boolean {
  const path = cachePath ?? getCachedManifestPath();

  if (!existsSync(path)) return false;

  try {
    const content = readFileSync(path, 'utf-8');
    const manifest = JSON.parse(content) as SkillManifest;
    const ttl = manifest._meta?.ttlSeconds ?? DEFAULT_CACHE_TTL;
    const generatedAt = new Date(manifest._meta?.generatedAt ?? 0).getTime();
    const ageSeconds = (Date.now() - generatedAt) / 1000;

    return ageSeconds < ttl;
  } catch {
    return false;
  }
}

/**
 * Invalidate the cache (delete the cached manifest).
 * @task T4520
 */
export function invalidateCache(): void {
  const cachePath = getCachedManifestPath();
  if (existsSync(cachePath)) {
    try {
      writeFileSync(cachePath, '', 'utf-8');
    } catch {
      // Ignore write errors
    }
  }
}

// ============================================================================
// Manifest Resolution
// ============================================================================

/**
 * Resolve the skills manifest.
 * Returns a cached version if fresh, otherwise generates a new one.
 *
 * Graceful degradation:
 *   1. Fresh cached manifest (within TTL)
 *   2. Stale cached manifest (expired but valid)
 *   3. Embedded project manifest (skills/manifest.json)
 *   4. Freshly generated manifest
 *
 * @task T4520
 */
export function resolveManifest(cwd?: string): SkillManifest {
  const cachePath = getCachedManifestPath();

  // Strategy 1: Fresh cache
  if (isCacheFresh(cachePath)) {
    try {
      return JSON.parse(readFileSync(cachePath, 'utf-8'));
    } catch {
      // Fall through to regenerate
    }
  }

  // Strategy 2: Stale cache (still valid JSON)
  if (existsSync(cachePath)) {
    try {
      const content = readFileSync(cachePath, 'utf-8');
      if (content.trim()) {
        const staleManifest = JSON.parse(content) as SkillManifest;
        if (staleManifest.skills?.length > 0) {
          // Use stale but try to regenerate in background
          regenerateCache(cwd);
          return staleManifest;
        }
      }
    } catch {
      // Fall through
    }
  }

  // Strategy 3: Generate fresh manifest
  const manifest = generateManifest(cwd);

  // Cache the result
  try {
    const cacheDir = getCacheDir();
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
    writeFileSync(cachePath, JSON.stringify(manifest, null, 2), 'utf-8');
  } catch {
    // Cache write failure is non-fatal
  }

  return manifest;
}

/**
 * Force regenerate the cache.
 * @task T4520
 */
export function regenerateCache(cwd?: string): SkillManifest {
  const manifest = generateManifest(cwd);
  const cachePath = getCachedManifestPath();

  try {
    const cacheDir = getCacheDir();
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
    writeFileSync(cachePath, JSON.stringify(manifest, null, 2), 'utf-8');
  } catch {
    // Cache write failure is non-fatal
  }

  return manifest;
}
