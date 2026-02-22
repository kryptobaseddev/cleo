/**
 * Agent-outputs directory migration utility.
 *
 * Single source of truth for detecting, migrating, and cleaning up
 * legacy agent-output directories. Handles the full lineage:
 *
 *   1. claudedocs/research-outputs/  (oldest, pre-v0.61.0)
 *   2. claudedocs/agent-outputs/     (intermediate, pre-v0.70.0)
 *   3. .cleo/agent-outputs/          (canonical, v0.80.0+)
 *
 * NOTE: The "research-outputs" naming predates the "agent-outputs" rename
 * (T2348). Projects that still have research-outputs/ get their content
 * merged into .cleo/agent-outputs/ in a single unified pass with
 * MANIFEST.jsonl path rewriting and deduplication.
 *
 * Used by: upgrade.ts (cleo upgrade) and init.ts (cleo init).
 *
 * @task T4700
 * @epic T4454
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  statSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────

/** Result of detecting legacy agent-output directories. */
export interface LegacyDetectionResult {
  /** Whether any legacy directories were found. */
  hasLegacy: boolean;
  /** claudedocs/research-outputs/ exists. */
  hasResearchOutputs: boolean;
  /** claudedocs/agent-outputs/ exists. */
  hasLegacyAgentOutputs: boolean;
  /** .cleo/agent-outputs/ already exists. */
  hasCanonical: boolean;
  /** Human-readable list of found legacy paths. */
  legacyPaths: string[];
}

/** Result of running the agent-outputs migration. */
export interface AgentOutputsMigrationResult {
  /** Whether migration was performed. */
  migrated: boolean;
  /** Number of files copied to canonical location. */
  filesCopied: number;
  /** Number of manifest entries in the merged MANIFEST.jsonl. */
  manifestEntries: number;
  /** Legacy directories that were removed. */
  removed: string[];
  /** Human-readable summary of what happened. */
  summary: string;
}

// ── Constants ────────────────────────────────────────────────────────

/** Canonical agent-outputs directory (relative to project root). */
const CANONICAL_DIR = '.cleo/agent-outputs';

/** Path rewrites applied to MANIFEST.jsonl entries during migration. */
const MANIFEST_PATH_REWRITES: ReadonlyArray<[RegExp, string]> = [
  [/claudedocs\/research-outputs\//g, `${CANONICAL_DIR}/`],
  [/claudedocs\/agent-outputs\//g, `${CANONICAL_DIR}/`],
];

// ── Detection ────────────────────────────────────────────────────────

/**
 * Detect legacy agent-output directories in a project.
 *
 * Read-only check — never modifies the filesystem.
 *
 * @param projectRoot - Absolute path to project root
 * @param cleoDir - Absolute path to .cleo/ directory
 */
export function detectLegacyAgentOutputs(
  projectRoot: string,
  cleoDir: string,
): LegacyDetectionResult {
  const hasResearchOutputs = existsSync(join(projectRoot, 'claudedocs', 'research-outputs'));
  const hasLegacyAgentOutputs = existsSync(join(projectRoot, 'claudedocs', 'agent-outputs'));
  const hasCanonical = existsSync(join(cleoDir, 'agent-outputs'));

  const legacyPaths: string[] = [];
  if (hasResearchOutputs) legacyPaths.push('claudedocs/research-outputs/');
  if (hasLegacyAgentOutputs) legacyPaths.push('claudedocs/agent-outputs/');

  return {
    hasLegacy: hasResearchOutputs || hasLegacyAgentOutputs,
    hasResearchOutputs,
    hasLegacyAgentOutputs,
    hasCanonical,
    legacyPaths,
  };
}

// ── Migration ────────────────────────────────────────────────────────

/**
 * Run the full agent-outputs migration.
 *
 * Copies files from all legacy locations into .cleo/agent-outputs/,
 * merges MANIFEST.jsonl entries with path rewriting and deduplication,
 * updates config.json, and removes legacy directories.
 *
 * Safe to call when no legacy directories exist (returns early).
 * Safe to call when canonical directory already exists (merges).
 *
 * @param projectRoot - Absolute path to project root
 * @param cleoDir - Absolute path to .cleo/ directory
 */
export function migrateAgentOutputs(
  projectRoot: string,
  cleoDir: string,
): AgentOutputsMigrationResult {
  const detection = detectLegacyAgentOutputs(projectRoot, cleoDir);

  if (!detection.hasLegacy) {
    return {
      migrated: false,
      filesCopied: 0,
      manifestEntries: 0,
      removed: [],
      summary: 'No legacy output directories found',
    };
  }

  const newDir = join(cleoDir, 'agent-outputs');
  const hadCanonical = detection.hasCanonical;
  mkdirSync(newDir, { recursive: true });

  let totalCopied = 0;
  const mergedManifestLines: string[] = [];
  const copiedFiles = new Set<string>();

  // ── Phase 1: Copy files from legacy dirs (oldest first) ──────────
  const legacySources: Array<{ path: string; exists: boolean }> = [
    { path: join(projectRoot, 'claudedocs', 'research-outputs'), exists: detection.hasResearchOutputs },
    { path: join(projectRoot, 'claudedocs', 'agent-outputs'), exists: detection.hasLegacyAgentOutputs },
  ];

  for (const source of legacySources) {
    if (!source.exists) continue;
    totalCopied += copyDirContents(source.path, newDir, mergedManifestLines, copiedFiles);
  }

  // ── Phase 2: Merge manifests ─────────────────────────────────────
  const manifestEntries = mergeManifests(newDir, hadCanonical, mergedManifestLines);

  // ── Phase 3: Update config ───────────────────────────────────────
  updateConfigPaths(cleoDir);

  // ── Phase 4: Remove legacy directories ───────────────────────────
  const removed = removeLegacyDirs(projectRoot, detection);

  // ── Build summary ────────────────────────────────────────────────
  const parts = [`Migrated ${totalCopied} files → ${CANONICAL_DIR}/`];
  if (manifestEntries > 0) parts.push(`merged ${manifestEntries} manifest entries`);
  if (removed.length > 0) parts.push(`removed: ${removed.join(', ')}`);

  return {
    migrated: true,
    filesCopied: totalCopied,
    manifestEntries,
    removed,
    summary: parts.join('; '),
  };
}

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Recursively copy a source directory's contents into the target directory.
 *
 * - Skips MANIFEST.jsonl (collected separately for merge).
 * - Skips files already present in copiedFiles set (newer wins).
 * - Handles one level of subdirectories.
 */
function copyDirContents(
  srcDir: string,
  dstDir: string,
  manifestLines: string[],
  copiedFiles: Set<string>,
): number {
  let count = 0;
  const entries = readdirSync(srcDir);

  for (const entry of entries) {
    if (entry === 'MANIFEST.jsonl') {
      collectManifestLines(join(srcDir, entry), manifestLines);
      continue;
    }

    const srcPath = join(srcDir, entry);
    const dstPath = join(dstDir, entry);

    try {
      const st = statSync(srcPath);
      if (st.isDirectory()) {
        mkdirSync(dstPath, { recursive: true });
        for (const sf of readdirSync(srcPath)) {
          if (!copiedFiles.has(sf)) {
            try {
              copyFileSync(join(srcPath, sf), join(dstPath, sf));
              copiedFiles.add(sf);
              count++;
            } catch { /* skip individual file errors */ }
          }
        }
      } else if (!copiedFiles.has(entry)) {
        copyFileSync(srcPath, dstPath);
        copiedFiles.add(entry);
        count++;
      }
    } catch { /* skip individual file errors */ }
  }

  return count;
}

/**
 * Read MANIFEST.jsonl lines from a source file and rewrite paths.
 */
function collectManifestLines(manifestPath: string, out: string[]): void {
  try {
    const content = readFileSync(manifestPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let rewritten = line;
      for (const [pattern, replacement] of MANIFEST_PATH_REWRITES) {
        rewritten = rewritten.replace(pattern, replacement);
      }
      out.push(rewritten);
    }
  } catch { /* skip unreadable manifest */ }
}

/**
 * Merge manifest entries: existing canonical entries take priority,
 * legacy entries are appended with deduplication by ID.
 *
 * @returns Total number of entries in the merged manifest.
 */
function mergeManifests(
  newDir: string,
  hadCanonical: boolean,
  legacyLines: string[],
): number {
  const manifestPath = join(newDir, 'MANIFEST.jsonl');

  // Collect existing canonical entries
  const existingLines: string[] = [];
  if (hadCanonical && existsSync(manifestPath)) {
    try {
      const existing = readFileSync(manifestPath, 'utf-8');
      for (const line of existing.split('\n')) {
        if (line.trim()) existingLines.push(line);
      }
    } catch { /* ignore */ }
  }

  // Deduplicate: existing IDs take priority
  const seenIds = new Set<string>();
  const finalLines: string[] = [];

  for (const line of existingLines) {
    try { const p = JSON.parse(line); if (p.id) seenIds.add(p.id); } catch { /* keep */ }
    finalLines.push(line);
  }

  for (const line of legacyLines) {
    try {
      const p = JSON.parse(line);
      if (p.id && seenIds.has(p.id)) continue;
      if (p.id) seenIds.add(p.id);
    } catch { /* keep */ }
    finalLines.push(line);
  }

  if (finalLines.length > 0) {
    writeFileSync(manifestPath, finalLines.join('\n') + '\n');
  }

  return finalLines.length;
}

/**
 * Update config.json to point to the canonical path and remove deprecated keys.
 */
function updateConfigPaths(cleoDir: string): void {
  const configPath = join(cleoDir, 'config.json');
  if (!existsSync(configPath)) return;

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const currentDir = config.agentOutputs?.directory
      ?? config.agentOutputs
      ?? config.research?.outputDir;

    if (currentDir && currentDir !== CANONICAL_DIR) {
      if (typeof config.agentOutputs === 'object') {
        config.agentOutputs.directory = CANONICAL_DIR;
      } else {
        config.agentOutputs = { directory: CANONICAL_DIR };
      }

      // Remove deprecated research.outputDir
      if (config.research?.outputDir) {
        delete config.research.outputDir;
        if (Object.keys(config.research).length === 0) {
          delete config.research;
        }
      }

      writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
  } catch { /* config update is best-effort */ }
}

/**
 * Remove legacy directories and clean up empty claudedocs/.
 *
 * @returns List of removed directory paths (relative).
 */
function removeLegacyDirs(
  projectRoot: string,
  detection: LegacyDetectionResult,
): string[] {
  const removed: string[] = [];

  if (detection.hasResearchOutputs) {
    try {
      rmSync(join(projectRoot, 'claudedocs', 'research-outputs'), { recursive: true, force: true });
      removed.push('claudedocs/research-outputs/');
    } catch { /* best-effort */ }
  }

  if (detection.hasLegacyAgentOutputs) {
    try {
      rmSync(join(projectRoot, 'claudedocs', 'agent-outputs'), { recursive: true, force: true });
      removed.push('claudedocs/agent-outputs/');
    } catch { /* best-effort */ }
  }

  // Remove empty claudedocs/ parent
  const claudedocsDir = join(projectRoot, 'claudedocs');
  if (existsSync(claudedocsDir)) {
    try {
      if (readdirSync(claudedocsDir).length === 0) {
        rmSync(claudedocsDir, { recursive: true, force: true });
        removed.push('claudedocs/ (empty)');
      }
    } catch { /* best-effort */ }
  }

  return removed;
}
