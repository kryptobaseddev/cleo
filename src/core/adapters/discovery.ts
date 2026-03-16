/**
 * Adapter discovery: scans packages/adapters/ for installed provider adapters.
 * Reads adapter manifests and detects active providers in the current environment.
 *
 * @task T5240
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AdapterManifest, DetectionPattern } from '@cleocode/contracts';

/**
 * Scan the packages/adapters/ directory for adapter packages.
 * Each adapter must have a manifest.json at its root.
 */
export function discoverAdapterManifests(projectRoot: string): AdapterManifest[] {
  const adaptersDir = resolve(projectRoot, 'packages', 'adapters');
  if (!existsSync(adaptersDir)) return [];

  const manifests: AdapterManifest[] = [];
  let entries: string[];
  try {
    entries = readdirSync(adaptersDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  for (const dir of entries) {
    const manifestPath = join(adaptersDir, dir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const raw = readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as AdapterManifest;
      manifests.push(manifest);
    } catch {
      // Skip malformed manifests
    }
  }

  return manifests;
}

/**
 * Detect whether a provider is active in the current environment
 * by checking its detection patterns.
 */
export function detectProvider(patterns: DetectionPattern[]): boolean {
  for (const pattern of patterns) {
    if (matchDetectionPattern(pattern)) return true;
  }
  return false;
}

function matchDetectionPattern(pattern: DetectionPattern): boolean {
  switch (pattern.type) {
    case 'env':
      return process.env[pattern.pattern] !== undefined;
    case 'file':
      return existsSync(pattern.pattern);
    case 'process': {
      // Check if a process name appears in environment hints
      // (actual process scanning is expensive; use env-based hints)
      const processName = pattern.pattern.toLowerCase();
      return (
        (process.env.TERM_PROGRAM ?? '').toLowerCase().includes(processName) ||
        (process.env.EDITOR ?? '').toLowerCase().includes(processName)
      );
    }
    case 'cli': {
      try {
        execFileSync('which', [pattern.pattern], { stdio: 'ignore', timeout: 3000 });
        return true;
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}
