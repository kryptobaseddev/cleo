/**
 * Migration Script: ~/.claude/projects/<project>/memory/*.md -> brain.db
 *
 * Migrates Claude Code provider-specific memory files to provider-neutral
 * brain.db storage. After migration, all memory reads go through
 * `cleo memory find/fetch` rather than flat markdown files.
 *
 * Safe to re-run — content hashes are used to skip already-imported entries.
 *
 * Usage:
 *   pnpm dlx tsx scripts/migrate-memory-md-to-brain.ts [--dry-run] [--dir <path>]
 *
 * Options:
 *   --dry-run   Print what would be imported without writing anything
 *   --dir       Source directory (default: ~/.claude/projects/-mnt-projects-cleocode/memory)
 *
 * Type mapping (frontmatter `type` field → cleo memory command):
 *   feedback  → memory store --type learning   (feedback is a learning)
 *   project   → memory observe --type feature  (project context is an observation)
 *   reference → memory observe --type discovery
 *   user      → memory observe --type change
 *   (default) → memory observe --type discovery
 *
 * @task T629
 * @epic T627
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const dirArgIdx = args.indexOf('--dir');
const sourceDir =
  dirArgIdx !== -1 && args[dirArgIdx + 1]
    ? args[dirArgIdx + 1]!
    : join(homedir(), '.claude', 'projects', '-mnt-projects-cleocode', 'memory');

const PROJECT_ROOT = process.cwd();

// Dedup state file — tracks hashes of already-imported entries
const DEDUP_STATE_PATH = join(PROJECT_ROOT, '.cleo', 'migrate-memory-hashes.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ParsedMemoryFile {
  filePath: string;
  fileName: string;
  frontmatter: {
    name?: string;
    description?: string;
    type?: string;
    originSessionId?: string;
  };
  body: string;
  contentHash: string;
}

interface MigrationStats {
  total: number;
  imported: number;
  skipped: number;
  errors: number;
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from a markdown file.
 * Supports simple key: value pairs only (no nested YAML).
 *
 * @param raw - Raw file content
 * @returns Parsed frontmatter object and body text
 */
function parseFrontmatter(raw: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const FENCE_RE = /^---\s*$/m;
  const lines = raw.split('\n');
  if (!lines[0]?.trim().startsWith('---')) {
    return { frontmatter: {}, body: raw.trim() };
  }

  const endIdx = lines.slice(1).findIndex((l) => FENCE_RE.test(l));
  if (endIdx === -1) {
    return { frontmatter: {}, body: raw.trim() };
  }

  const fmLines = lines.slice(1, endIdx + 1);
  const body = lines.slice(endIdx + 2).join('\n').trim();

  const frontmatter: Record<string, string> = {};
  for (const line of fmLines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) {
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

// ---------------------------------------------------------------------------
// Content hash (for dedup)
// ---------------------------------------------------------------------------

/**
 * Generate a SHA-256 hash for a memory entry (title + body).
 * Used to skip re-importing the same content.
 *
 * @param title - Entry title
 * @param body - Entry body text
 * @returns 16-char hex prefix of SHA-256 hash
 */
function contentHash(title: string, body: string): string {
  return createHash('sha256').update(`${title}\n${body}`).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Dedup state management
// ---------------------------------------------------------------------------

/** Load set of already-imported content hashes from state file. */
function loadImportedHashes(): Set<string> {
  try {
    if (!existsSync(DEDUP_STATE_PATH)) return new Set();
    const raw = readFileSync(DEDUP_STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as { hashes: string[] };
    return new Set(parsed.hashes);
  } catch {
    return new Set();
  }
}

/** Persist updated set of imported hashes. */
function saveImportedHashes(hashes: Set<string>): void {
  const dir = join(PROJECT_ROOT, '.cleo');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(DEDUP_STATE_PATH, JSON.stringify({ hashes: [...hashes] }, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Discover all markdown files under a memory directory, excluding MEMORY.md
 * (the index file — generated, not a memory artifact).
 *
 * @param dir - Directory to scan
 * @returns Array of absolute file paths
 */
function discoverMemoryFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    console.error(`Source directory not found: ${dir}`);
    process.exit(1);
  }

  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
    .map((f) => join(dir, f));
}

// ---------------------------------------------------------------------------
// File parser
// ---------------------------------------------------------------------------

/**
 * Parse a single memory markdown file into a structured representation.
 *
 * @param filePath - Absolute path to the memory file
 * @returns Parsed memory file or null on error
 */
function parseMemoryFile(filePath: string): ParsedMemoryFile | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return null;

    const { frontmatter, body } = parseFrontmatter(raw);
    const fileName = filePath.split('/').pop() ?? filePath;

    // Derive a title: prefer frontmatter `name`, fall back to filename slug
    const name = frontmatter.name ?? fileName.replace(/\.md$/, '').replace(/-/g, ' ');

    return {
      filePath,
      fileName,
      frontmatter: {
        name,
        description: frontmatter.description,
        type: frontmatter.type,
        originSessionId: frontmatter.originSessionId,
      },
      body,
      contentHash: contentHash(name, body),
    };
  } catch (err) {
    console.error(`Failed to parse ${filePath}:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// cleo CLI caller
// ---------------------------------------------------------------------------

/**
 * Invoke the cleo CLI with given arguments, returning parsed JSON output.
 *
 * @param cmdArgs - CLI argument array
 * @returns Parsed response or null on failure
 */
function callCleo(cmdArgs: string[]): { success: boolean; error?: string } | null {
  const proc = spawnSync('cleo', cmdArgs, {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, LOG_LEVEL: 'silent' },
  });

  if (proc.error) {
    return null;
  }

  const raw = (proc.stdout ?? '').trim();
  const lines = raw.split('\n');
  const jsonStartIdx = lines.findIndex((l) => l.trim().startsWith('{'));
  if (jsonStartIdx === -1) return null;

  try {
    return JSON.parse(lines.slice(jsonStartIdx).join('\n')) as {
      success: boolean;
      error?: string;
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Memory type routing
// ---------------------------------------------------------------------------

/**
 * Import a single memory file into brain.db via cleo CLI.
 *
 * Type mapping:
 *   feedback  → learning.store (feedback encodes a lesson learned)
 *   project   → observe --type feature (project context/decisions)
 *   reference → observe --type discovery
 *   user      → observe --type change
 *   default   → observe --type discovery
 *
 * @param entry - Parsed memory file
 * @param dryRun - If true, print command but do not execute
 * @returns true on success, false on failure
 */
function importEntry(entry: ParsedMemoryFile, dryRun: boolean): boolean {
  const title = entry.frontmatter.name ?? entry.fileName;
  const type = entry.frontmatter.type ?? 'project';
  // Combine description and body so brain.db holds full content
  const bodyParts = [entry.frontmatter.description, entry.body].filter(Boolean);
  const fullText = bodyParts.join('\n\n').trim();

  if (!fullText) {
    console.log(`  [SKIP] ${entry.fileName} — empty body`);
    return true;
  }

  let cmdArgs: string[];

  if (type === 'feedback') {
    // Feedback → learning
    cmdArgs = [
      'memory',
      'store',
      '--type',
      'learning',
      '--content',
      fullText,
      '--context',
      `Migrated from Claude Code MEMORY.md: ${title}`,
      '--confidence',
      '0.80',
      '--json',
    ];
  } else {
    // project | reference | user | default → observation
    const observeType =
      type === 'project'
        ? 'feature'
        : type === 'reference'
          ? 'discovery'
          : type === 'user'
            ? 'change'
            : 'discovery';

    cmdArgs = [
      'memory',
      'observe',
      `[MIGRATED] ${title}: ${fullText}`,
      '--title',
      `[MIGRATED] ${title}`,
      '--type',
      observeType,
      '--sourceType',
      'manual',
      '--json',
    ];
  }

  if (dryRun) {
    console.log(`  [DRY-RUN] cleo ${cmdArgs.join(' ').slice(0, 120)}...`);
    return true;
  }

  const result = callCleo(cmdArgs);
  if (!result || !result.success) {
    console.error(`  [ERROR] ${entry.fileName}: ${result?.error ?? 'unknown error'}`);
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run the migration.
 *
 * @returns Migration statistics
 */
async function main(): Promise<MigrationStats> {
  console.log('=== CLEO Memory Migration: MEMORY.md → brain.db ===');
  console.log(`Source: ${sourceDir}`);
  console.log(`Project root: ${PROJECT_ROOT}`);
  if (isDryRun) console.log('Mode: DRY RUN (no writes)');
  console.log('');

  const files = discoverMemoryFiles(sourceDir);
  console.log(`Found ${files.length} memory files`);

  const importedHashes = isDryRun ? new Set<string>() : loadImportedHashes();
  const stats: MigrationStats = {
    total: files.length,
    imported: 0,
    skipped: 0,
    errors: 0,
    dryRun: isDryRun,
  };

  for (const filePath of files) {
    const entry = parseMemoryFile(filePath);
    if (!entry) {
      stats.errors++;
      continue;
    }

    if (!isDryRun && importedHashes.has(entry.contentHash)) {
      console.log(`  [SKIP] ${entry.fileName} — already imported (hash: ${entry.contentHash})`);
      stats.skipped++;
      continue;
    }

    console.log(`  [IMPORT] ${entry.fileName} (type: ${entry.frontmatter.type ?? 'unknown'})`);
    const ok = importEntry(entry, isDryRun);

    if (ok) {
      stats.imported++;
      if (!isDryRun) importedHashes.add(entry.contentHash);
    } else {
      stats.errors++;
    }
  }

  if (!isDryRun) {
    saveImportedHashes(importedHashes);
  }

  console.log('');
  console.log('=== Migration Complete ===');
  console.log(`Total files:    ${stats.total}`);
  console.log(`Imported:       ${stats.imported}`);
  console.log(`Skipped (dup):  ${stats.skipped}`);
  console.log(`Errors:         ${stats.errors}`);

  return stats;
}

main().catch((err) => {
  console.error('Migration FAILED:', err);
  process.exit(1);
});
