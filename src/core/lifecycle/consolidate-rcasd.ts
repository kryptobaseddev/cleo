/**
 * One-time migration to consolidate provenance files into the unified
 * `.cleo/rcasd/{epicId}/` structure with stage subdirectories.
 *
 * Migrates files from:
 *   - `.cleo/consensus/` → `rcasd/{epicId}/consensus/`
 *   - `.cleo/contributions/` → `rcasd/{epicId}/contributions/`
 *   - `.cleo/rcasd/T####_*.md` (loose) → `rcasd/{epicId}/research/`
 *   - Suffixed dirs like `T4881_install-channels` → `T4881`
 *
 * @task T5200
 * @epic T4798
 */

import { join, dirname } from 'node:path';
import {
  existsSync,
  mkdirSync,
  renameSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  copyFileSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { getCleoDirAbsolute } from '../paths.js';
import {
  getStagePath,
  ensureStagePath,
  getLooseResearchFiles,
  listEpicDirs,
} from './rcasd-paths.js';
import { addFrontmatter, buildFrontmatter } from './frontmatter.js';

// ============================================================================
// Types
// ============================================================================

interface MoveRecord {
  from: string;
  to: string;
  type: 'move' | 'rename';
  status: 'success' | 'skipped' | 'error';
  reason?: string;
}

interface MigrationResult {
  moves: MoveRecord[];
  totalMoved: number;
  totalSkipped: number;
  totalErrors: number;
  dryRun: boolean;
}

interface ConsolidateOptions {
  dryRun?: boolean;
  cwd?: string;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Safely move a file from `from` to `to`, creating parent directories as needed.
 * Falls back to copy+delete for cross-device moves.
 */
function safeMove(from: string, to: string, dryRun: boolean): MoveRecord {
  if (dryRun) {
    return { from, to, type: 'move', status: 'success', reason: 'dry-run' };
  }

  const targetDir = dirname(to);
  mkdirSync(targetDir, { recursive: true });

  if (existsSync(to)) {
    return { from, to, type: 'move', status: 'skipped', reason: 'target exists' };
  }

  try {
    renameSync(from, to);
    return { from, to, type: 'move', status: 'success' };
  } catch {
    // Cross-device: copy then delete
    try {
      copyFileSync(from, to);
      unlinkSync(from);
      return { from, to, type: 'move', status: 'success' };
    } catch (err) {
      return {
        from,
        to,
        type: 'move',
        status: 'error',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * Safely rename a directory. Falls back to recursive copy for cross-device.
 */
function safeRenameDir(from: string, to: string, dryRun: boolean): MoveRecord {
  if (dryRun) {
    return { from, to, type: 'rename', status: 'success', reason: 'dry-run' };
  }

  if (existsSync(to)) {
    return { from, to, type: 'rename', status: 'skipped', reason: 'target exists' };
  }

  try {
    renameSync(from, to);
    return { from, to, type: 'rename', status: 'success' };
  } catch (err) {
    return {
      from,
      to,
      type: 'rename',
      status: 'error',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Move a file, injecting YAML frontmatter into markdown files during the move.
 * Non-markdown files (JSON, etc.) are delegated to `safeMove` unchanged.
 * Skips `_manifest.json` files entirely.
 */
function safeMoveWithFrontmatter(
  from: string,
  to: string,
  epicId: string,
  stage: string,
  dryRun: boolean,
  relatedLinks?: import('./frontmatter.js').RelatedLink[],
): MoveRecord {
  if (dryRun) {
    return { from, to, type: 'move', status: 'success', reason: 'dry-run' };
  }

  // Skip manifest files
  if (from.endsWith('_manifest.json')) {
    return { from, to, type: 'move', status: 'skipped', reason: 'manifest file' };
  }

  // Only inject frontmatter into markdown files
  if (from.endsWith('.md')) {
    const targetDir = dirname(to);
    mkdirSync(targetDir, { recursive: true });

    if (existsSync(to)) {
      return { from, to, type: 'move', status: 'skipped', reason: 'target exists' };
    }

    try {
      const content = readFileSync(from, 'utf-8');
      const metadata = buildFrontmatter(epicId, stage, {
        task: epicId,
        related: relatedLinks,
      });
      const withFrontmatter = addFrontmatter(content, metadata);
      writeFileSync(to, withFrontmatter, 'utf-8');
      unlinkSync(from);
      return { from, to, type: 'move', status: 'success' };
    } catch (err) {
      return {
        from,
        to,
        type: 'move',
        status: 'error',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Non-markdown files: plain move
  return safeMove(from, to, dryRun);
}

// ============================================================================
// Epic resolution from file content and names
// ============================================================================

/** Pattern for T#### at a word boundary */
const TASK_ID_PATTERN = /\bT(\d{4,})\b/;

/** Pattern for @task or @epic annotations */
const ANNOTATION_PATTERN = /@(?:task|epic)\s+(T\d{4,})/;

/**
 * Extract an epic/task ID from file content by searching for:
 *   1. `@task T####` or `@epic T####` annotations (highest priority)
 *   2. JSON `"task"`, `"epicId"`, or `"taskId"` fields
 *   3. First `T####` at a word boundary (fallback)
 */
export function resolveEpicFromContent(content: string): string | null {
  // Priority 1: @task / @epic annotations
  const annotationMatch = content.match(ANNOTATION_PATTERN);
  if (annotationMatch) return annotationMatch[1];

  // Priority 2: JSON fields like "task": "T####" or "epicId": "T####"
  const jsonFieldPattern = /"(?:task|epicId|taskId)"\s*:\s*"(T\d{4,})"/;
  const jsonMatch = content.match(jsonFieldPattern);
  if (jsonMatch) return jsonMatch[1];

  // Priority 3: First T#### in content
  const idMatch = content.match(TASK_ID_PATTERN);
  if (idMatch) return `T${idMatch[1]}`;

  return null;
}

/**
 * Extract an epic ID from a filename pattern like `T####-*` or `T####_*`.
 */
export function resolveEpicFromFilename(filename: string): string | null {
  const match = filename.match(/^(T\d{4,})[_-]/);
  return match ? match[1] : null;
}

// ============================================================================
// Migration functions
// ============================================================================

/**
 * Rename suffixed epic directories (e.g. `T4881_install-channels` → `T4881`).
 */
export function normalizeDirectoryNames(options: ConsolidateOptions = {}): MoveRecord[] {
  const { dryRun = false, cwd } = options;
  const records: MoveRecord[] = [];

  for (const entry of listEpicDirs(cwd)) {
    // If the directory name differs from the normalized epic ID, rename it
    if (entry.dirName !== entry.epicId) {
      const targetPath = join(dirname(entry.fullPath), entry.epicId);
      records.push(safeRenameDir(entry.fullPath, targetPath, dryRun));
    }
  }

  return records;
}

/**
 * Migrate `.cleo/consensus/` files to appropriate epic's consensus/ subdirectory.
 *
 * - T4869-checkpoint-consensus.json → rcasd/T4869/consensus/
 * - Agent finding files and CONSENSUS-REPORT.md → resolve epic from content
 * - phase1-best-practices-evidence.md → resolve epic from content → research/
 */
export function migrateConsensusFiles(options: ConsolidateOptions = {}): MoveRecord[] {
  const { dryRun = false, cwd } = options;
  const records: MoveRecord[] = [];
  const consensusDir = join(getCleoDirAbsolute(cwd), 'consensus');

  if (!existsSync(consensusDir)) return records;

  let entries: string[];
  try {
    entries = readdirSync(consensusDir);
  } catch {
    return records;
  }

  for (const filename of entries) {
    const filePath = join(consensusDir, filename);

    // Skip directories
    try {
      if (statSync(filePath).isDirectory()) continue;
    } catch {
      continue;
    }

    // Try to resolve the epic from the filename first
    let epicId = resolveEpicFromFilename(filename);

    // Then try content
    if (!epicId) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        epicId = resolveEpicFromContent(content);
      } catch {
        // Can't read file content
      }
    }

    if (!epicId) {
      records.push({
        from: filePath,
        to: '',
        type: 'move',
        status: 'skipped',
        reason: 'could not resolve epic ID',
      });
      continue;
    }

    // Determine target stage: phase1-best-practices-evidence.md goes to research/
    const stage = filename.startsWith('phase1-') ? 'research' : 'consensus';
    const targetDir = dryRun
      ? getStagePath(epicId, stage, cwd)
      : ensureStagePath(epicId, stage, cwd);
    const targetPath = join(targetDir, filename);

    const related =
      stage === 'consensus'
        ? [{ type: 'research' as const, path: '../research/' }]
        : undefined;
    records.push(safeMoveWithFrontmatter(filePath, targetPath, epicId, stage, dryRun, related));
  }

  return records;
}

/**
 * Migrate `.cleo/contributions/` files to appropriate epic's contributions/ subdirectory.
 *
 * Files follow the pattern `T####-session-*.json` with epicId in content.
 */
export function migrateContributionFiles(options: ConsolidateOptions = {}): MoveRecord[] {
  const { dryRun = false, cwd } = options;
  const records: MoveRecord[] = [];
  const contribDir = join(getCleoDirAbsolute(cwd), 'contributions');

  if (!existsSync(contribDir)) return records;

  let entries: string[];
  try {
    entries = readdirSync(contribDir);
  } catch {
    return records;
  }

  for (const filename of entries) {
    const filePath = join(contribDir, filename);

    try {
      if (statSync(filePath).isDirectory()) continue;
    } catch {
      continue;
    }

    // Resolve epic from filename (T####-session-*.json)
    let epicId = resolveEpicFromFilename(filename);

    // Fallback: resolve from JSON content
    if (!epicId) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        epicId = resolveEpicFromContent(content);
      } catch {
        // Can't read
      }
    }

    if (!epicId) {
      records.push({
        from: filePath,
        to: '',
        type: 'move',
        status: 'skipped',
        reason: 'could not resolve epic ID',
      });
      continue;
    }

    const targetDir = dryRun
      ? getStagePath(epicId, 'contribution', cwd)
      : ensureStagePath(epicId, 'contribution', cwd);
    const targetPath = join(targetDir, filename);

    records.push(safeMoveWithFrontmatter(filePath, targetPath, epicId, 'contribution', dryRun));
  }

  return records;
}

/**
 * Migrate loose `T####_*.md` files from `.cleo/rcasd/` root into
 * `rcasd/{epicId}/research/` subdirectories.
 */
export function migrateLooseFiles(options: ConsolidateOptions = {}): MoveRecord[] {
  const { dryRun = false, cwd } = options;
  const records: MoveRecord[] = [];

  const looseFiles = getLooseResearchFiles(cwd);
  for (const { file, epicId, fullPath } of looseFiles) {
    const targetDir = dryRun
      ? getStagePath(epicId, 'research', cwd)
      : ensureStagePath(epicId, 'research', cwd);
    const targetPath = join(targetDir, file);

    records.push(safeMoveWithFrontmatter(fullPath, targetPath, epicId, 'research', dryRun));
  }

  return records;
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Consolidate all provenance files into the unified `.cleo/rcasd/{epicId}/`
 * structure with stage subdirectories.
 *
 * Performs migrations in order:
 *   1. Rename suffixed directories (T4881_install-channels → T4881)
 *   2. Move consensus files to appropriate epic's consensus/ subdirectory
 *   3. Move contribution files to appropriate epic's contributions/ subdirectory
 *   4. Move loose research files to appropriate epic's research/ subdirectory
 *
 * @param options.dryRun - If true, log planned moves without executing them
 * @param options.cwd - Optional working directory override
 */
export function consolidateRcasd(options: ConsolidateOptions = {}): MigrationResult {
  const { dryRun = false } = options;
  const allMoves: MoveRecord[] = [];

  // Step 1: Normalize directory names (must happen first so subsequent
  // moves target the canonical directory names)
  allMoves.push(...normalizeDirectoryNames(options));

  // Step 2: Migrate consensus files
  allMoves.push(...migrateConsensusFiles(options));

  // Step 3: Migrate contribution files
  allMoves.push(...migrateContributionFiles(options));

  // Step 4: Migrate loose research files
  allMoves.push(...migrateLooseFiles(options));

  return {
    moves: allMoves,
    totalMoved: allMoves.filter((m) => m.status === 'success').length,
    totalSkipped: allMoves.filter((m) => m.status === 'skipped').length,
    totalErrors: allMoves.filter((m) => m.status === 'error').length,
    dryRun,
  };
}
