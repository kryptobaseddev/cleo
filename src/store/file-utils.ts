/**
 * File utility helpers for CLEO data access.
 *
 * Extracted from mcp/engine/store.ts to make these utilities available
 * to core modules without creating inverted dependencies.
 *
 * @task T4833
 * @epic T4654
 */

import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Maximum number of operational backups to keep.
 */
const MAX_BACKUPS = 10;

/**
 * Create a numbered backup of a file (Tier 1 operational backup).
 */
function rotateBackup(filePath: string): void {
  const dir = dirname(filePath);
  const name = basename(filePath);
  const backupDir = join(dir, '.backups');

  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  for (let i = MAX_BACKUPS; i >= 1; i--) {
    const current = join(backupDir, `${name}.${i}`);
    if (i === MAX_BACKUPS) {
      try { unlinkSync(current); } catch { /* May not exist */ }
    } else {
      const next = join(backupDir, `${name}.${i + 1}`);
      try {
        if (existsSync(current)) renameSync(current, next);
      } catch { /* Ignore rename errors */ }
    }
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    writeFileSync(join(backupDir, `${name}.1`), content, 'utf-8');
  } catch { /* Non-fatal */ }
}

/**
 * Write a JSON file atomically with backup rotation.
 *
 * Pattern: write temp -> backup original -> rename temp to target
 *
 * @param filePath - Target file path
 * @param data - Data to serialize as JSON
 * @param indent - JSON indentation (default: 2 spaces)
 */
export function writeJsonFileAtomic<T>(
  filePath: string,
  data: T,
  indent: number = 2,
): void {
  const dir = dirname(filePath);
  const tempPath = join(dir, `.${basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`);

  const content = JSON.stringify(data, null, indent) + '\n';

  writeFileSync(tempPath, content, 'utf-8');

  try {
    if (existsSync(filePath)) {
      rotateBackup(filePath);
    }
    renameSync(tempPath, filePath);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* Ignore cleanup errors */ }
    throw error;
  }
}

/**
 * Read a JSON file, returning parsed content or null if not found.
 *
 * @param filePath - Path to the JSON file
 */
export function readJsonFile<T = unknown>(filePath: string): T | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Read log entries from a hybrid JSON/JSONL file (synchronous).
 * Handles legacy JSON `{ "entries": [...] }`, pure JSONL, and
 * hybrid format (JSON object followed by JSONL lines).
 * @task T4622
 */
export function readLogFileEntries(filePath: string): Record<string, unknown>[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8').trim();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (!content) return [];

  // Fast path: try as single JSON
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
      return parsed.entries;
    }
    return [parsed];
  } catch {
    // Hybrid format
  }

  const entries: Record<string, unknown>[] = [];

  if (content.startsWith('{')) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let jsonEnd = -1;
    for (let i = 0; i < content.length; i++) {
      const ch = content[i]!;
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
    }
    if (jsonEnd > 0) {
      try {
        const initial = JSON.parse(content.substring(0, jsonEnd));
        if (initial && Array.isArray(initial.entries)) entries.push(...initial.entries);
      } catch { /* skip corrupted initial JSON */ }
      const remainder = content.substring(jsonEnd).trim();
      if (remainder) {
        for (const line of remainder.split('\n')) {
          const l = line.trim();
          if (!l || !l.startsWith('{')) continue;
          try { entries.push(JSON.parse(l)); } catch { /* skip */ }
        }
      }
    }
  } else {
    for (const line of content.split('\n')) {
      const l = line.trim();
      if (!l || !l.startsWith('{')) continue;
      try { entries.push(JSON.parse(l)); } catch { /* skip */ }
    }
  }

  return entries;
}

/**
 * Get the path to a CLEO data file within a project root.
 *
 * @param projectRoot - Root directory of the project
 * @param filename - Filename within .cleo/ directory
 */
export function getDataPath(projectRoot: string, filename: string): string {
  return join(projectRoot, '.cleo', filename);
}

/**
 * Resolve the project root directory.
 * Checks CLEO_ROOT env, then falls back to cwd.
 */
export function resolveProjectRoot(): string {
  return process.env['CLEO_ROOT'] || process.cwd();
}
