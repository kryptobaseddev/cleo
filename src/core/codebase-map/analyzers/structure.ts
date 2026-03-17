/**
 * Structure analyzer — walks the directory tree and annotates directories with purpose.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { StructureAnalysis } from '../index.js';

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.cleo',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'out',
  '.cache',
  '__pycache__',
  '.pytest_cache',
  'target',
  'vendor',
]);

const DIR_PURPOSE: Record<string, string> = {
  src: 'Source code',
  lib: 'Library code',
  app: 'Application code',
  tests: 'Test suite',
  test: 'Test suite',
  spec: 'Test specifications',
  docs: 'Documentation',
  doc: 'Documentation',
  documentation: 'Documentation',
  scripts: 'Build/utility scripts',
  tools: 'Developer tools',
  config: 'Configuration files',
  assets: 'Static assets',
  public: 'Public/static files',
  static: 'Static files',
  migrations: 'Database migrations',
  schemas: 'Schema definitions',
  types: 'Type definitions',
  packages: 'Monorepo packages',
  examples: 'Usage examples',
  demos: 'Demo applications',
  benchmarks: 'Performance benchmarks',
  fixtures: 'Test fixtures',
  mocks: 'Test mocks',
  __mocks__: 'Jest/Vitest mocks',
  __tests__: 'Co-located tests',
  dev: 'Development utilities',
  bin: 'Executable scripts',
};

export function analyzeStructure(projectRoot: string): StructureAnalysis {
  const directories: StructureAnalysis['directories'] = [];
  let totalFiles = 0;

  const rootEntries = safeReaddir(projectRoot);
  for (const entry of rootEntries) {
    if (EXCLUDED_DIRS.has(entry) || entry.startsWith('.')) continue;

    const entryPath = join(projectRoot, entry);
    try {
      const stat = statSync(entryPath);
      if (stat.isDirectory()) {
        const fileCount = countFiles(entryPath);
        totalFiles += fileCount;
        const purpose = DIR_PURPOSE[entry.toLowerCase()] ?? 'Project directory';
        directories.push({
          path: entry,
          purpose,
          fileCount,
        });

        // Also scan one level deep for important subdirs
        const subEntries = safeReaddir(entryPath);
        for (const sub of subEntries) {
          if (EXCLUDED_DIRS.has(sub) || sub.startsWith('.')) continue;
          const subPath = join(entryPath, sub);
          try {
            const subStat = statSync(subPath);
            if (subStat.isDirectory()) {
              const subFileCount = countFiles(subPath);
              const subPurpose = DIR_PURPOSE[sub.toLowerCase()] ?? `${sub} module`;
              directories.push({
                path: `${entry}/${sub}`,
                purpose: subPurpose,
                fileCount: subFileCount,
              });
            }
          } catch {
            // ignore
          }
        }
      } else {
        totalFiles++;
      }
    } catch {
      // ignore stat errors
    }
  }

  return { directories, totalFiles };
}

function countFiles(dir: string, depth: number = 0): number {
  if (depth > 5) return 0;
  let count = 0;
  const entries = safeReaddir(dir);
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry) || entry.startsWith('.')) continue;
    const entryPath = join(dir, entry);
    try {
      const stat = statSync(entryPath);
      if (stat.isDirectory()) {
        count += countFiles(entryPath, depth + 1);
      } else {
        count++;
      }
    } catch {
      // ignore
    }
  }
  return count;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
