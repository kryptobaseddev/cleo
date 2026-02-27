/**
 * Sharing module for multi-contributor .cleo/ state management.
 *
 * Controls which .cleo/ files are committed to the project git repo
 * via a config-driven allowlist. Provides status reporting and
 * .gitignore auto-management.
 *
 * @task T4883
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadConfig } from '../config.js';
import { getCleoDirAbsolute, getProjectRoot } from '../paths.js';
import type { SharingConfig } from '../../types/config.js';

/** Result of a sharing status check. */
export interface SharingStatus {
  mode: string;
  allowlist: string[];
  denylist: string[];
  tracked: string[];
  ignored: string[];
}

/** Markers for the managed section in .gitignore. */
const GITIGNORE_START = '# CLEO:SHARING:START - Auto-managed by cleo sharing sync';
const GITIGNORE_END = '# CLEO:SHARING:END';

/**
 * Match a file path against a glob-like pattern.
 * Supports: '*' (single segment wildcard), '**' (recursive wildcard),
 * and trailing '/' for directory matching.
 * @task T4883
 */
export function matchesPattern(filePath: string, pattern: string): boolean {
  // Normalize: remove leading/trailing slashes
  const normalizedPath = filePath.replace(/^\/+|\/+$/g, '');
  const normalizedPattern = pattern.replace(/^\/+|\/+$/g, '');

  // Trailing ** matches everything under a directory
  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedPath === prefix || normalizedPath.startsWith(prefix + '/');
  }

  // Wildcard patterns with *
  if (normalizedPattern.includes('*')) {
    const regex = new RegExp(
      '^' +
        normalizedPattern
          .replace(/\./g, '\\.')
          .replace(/\*\*/g, '<<<GLOBSTAR>>>')
          .replace(/\*/g, '[^/]*')
          .replace(/<<<GLOBSTAR>>>/g, '.*') +
        '$',
    );
    return regex.test(normalizedPath);
  }

  // Exact match
  return normalizedPath === normalizedPattern;
}

/**
 * Check if a file path matches any pattern in a list.
 * @task T4883
 */
function matchesAny(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(filePath, pattern));
}

/**
 * Collect all files in .cleo/ directory (relative to .cleo/).
 * Skips the .git subdirectory.
 * @task T4883
 */
function collectCleoFiles(cleoDir: string): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry === '.git') continue; // Skip isolated .cleo/.git repo
      const fullPath = join(dir, entry);
      const relPath = relative(cleoDir, fullPath);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
        } else {
          files.push(relPath);
        }
      } catch {
        // Skip files we can't stat (e.g. broken symlinks)
      }
    }
  }

  walk(cleoDir);
  return files.sort();
}

/**
 * Get the sharing status: which .cleo/ files are tracked vs ignored.
 * @task T4883
 */
export async function getSharingStatus(cwd?: string): Promise<SharingStatus> {
  const config = await loadConfig(cwd);
  const sharing = config.sharing;
  const cleoDir = getCleoDirAbsolute(cwd);

  const allFiles = collectCleoFiles(cleoDir);
  const tracked: string[] = [];
  const ignored: string[] = [];

  for (const file of allFiles) {
    if (matchesAny(file, sharing.denylist)) {
      ignored.push(file);
    } else if (matchesAny(file, sharing.commitAllowlist)) {
      tracked.push(file);
    } else {
      ignored.push(file);
    }
  }

  return {
    mode: sharing.mode,
    allowlist: sharing.commitAllowlist,
    denylist: sharing.denylist,
    tracked,
    ignored,
  };
}

/**
 * Generate .gitignore entries for the managed section.
 * In 'project' mode: ignore everything except allowlisted files.
 * In 'none' mode: ignore all .cleo/ contents.
 * @task T4883
 */
function generateGitignoreEntries(sharing: SharingConfig): string[] {
  if (sharing.mode === 'none') {
    return ['.cleo/'];
  }

  // In 'project' mode: ignore .cleo/ broadly, then un-ignore allowlisted paths
  const entries: string[] = [];

  // First ignore everything in .cleo/
  entries.push('.cleo/');

  // Then un-ignore allowlisted paths (git negation patterns)
  for (const pattern of sharing.commitAllowlist) {
    // Ensure parent directories are also un-ignored
    const parts = pattern.split('/');
    let accumulated = '.cleo';
    for (let i = 0; i < parts.length - 1; i++) {
      accumulated += '/' + parts[i];
      entries.push(`!${accumulated}/`);
    }
    entries.push(`!.cleo/${pattern}`);
  }

  return entries;
}

/**
 * Sync the project .gitignore to match the sharing config.
 * Adds/updates a managed section between CLEO markers.
 * @task T4883
 */
export async function syncGitignore(cwd?: string): Promise<{ updated: boolean; entriesCount: number }> {
  const config = await loadConfig(cwd);
  const projectRoot = getProjectRoot(cwd);
  const gitignorePath = join(projectRoot, '.gitignore');

  const entries = generateGitignoreEntries(config.sharing);
  const managedSection = [
    '',
    GITIGNORE_START,
    ...entries,
    GITIGNORE_END,
    '',
  ].join('\n');

  let content = '';
  if (existsSync(gitignorePath)) {
    content = await readFile(gitignorePath, 'utf-8');
  }

  // Check if managed section already exists
  const startIdx = content.indexOf(GITIGNORE_START);
  const endIdx = content.indexOf(GITIGNORE_END);

  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing managed section
    const before = content.slice(0, startIdx);
    const after = content.slice(endIdx + GITIGNORE_END.length);
    const newContent = before.trimEnd() + managedSection + after.trimStart();
    if (newContent.trim() === content.trim()) {
      return { updated: false, entriesCount: entries.length };
    }
    await writeFile(gitignorePath, newContent);
  } else {
    // Append managed section
    const newContent = content.trimEnd() + '\n' + managedSection;
    await writeFile(gitignorePath, newContent);
  }

  return { updated: true, entriesCount: entries.length };
}
