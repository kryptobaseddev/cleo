/**
 * Research manifest CRUD operations.
 * Ports lib/skills/research-manifest.sh.
 *
 * Manages MANIFEST.jsonl (append-only JSONL format) for agent outputs.
 * Supports read, append, find, filter, archive, and rotation.
 *
 * @epic T4454
 * @task T4520
 */

import {
  existsSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from '../../paths.js';
import type { ManifestEntry } from '../types.js';
import { CleoError } from '../../errors.js';
import { ExitCode } from '../../../types/exit-codes.js';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Get agent outputs directory from config or default.
 */
function getOutputDir(cwd?: string): string {
  const projectRoot = getProjectRoot(cwd);
  const configPath = join(projectRoot, '.cleo', 'config.json');

  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      return config.agentOutputs?.directory ?? config.research?.outputDir ?? 'claudedocs/agent-outputs';
    } catch {
      // fallback
    }
  }

  return 'claudedocs/agent-outputs';
}

/**
 * Get the absolute manifest path.
 */
function getManifestPath(cwd?: string): string {
  const outputDir = getOutputDir(cwd);
  const projectRoot = getProjectRoot(cwd);
  const configPath = join(projectRoot, '.cleo', 'config.json');

  let manifestFile = 'MANIFEST.jsonl';
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      manifestFile = config.agentOutputs?.manifestFile ?? config.research?.manifestFile ?? 'MANIFEST.jsonl';
    } catch {
      // fallback
    }
  }

  return join(projectRoot, outputDir, manifestFile);
}

// ============================================================================
// Initialization
// ============================================================================

/**
 * Ensure agent outputs directory and manifest file exist.
 * @task T4520
 */
export function ensureOutputs(cwd?: string): { created: string[] } {
  const outputDir = getOutputDir(cwd);
  const projectRoot = getProjectRoot(cwd);
  const manifestPath = getManifestPath(cwd);
  const archiveDir = join(projectRoot, outputDir, 'archive');
  const created: string[] = [];

  const absOutputDir = join(projectRoot, outputDir);
  if (!existsSync(absOutputDir)) {
    mkdirSync(absOutputDir, { recursive: true });
    created.push(outputDir);
  }

  if (!existsSync(archiveDir)) {
    mkdirSync(archiveDir, { recursive: true });
    created.push('archive/');
  }

  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, '', 'utf-8');
    created.push('MANIFEST.jsonl');
  }

  return { created };
}

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * Read all manifest entries.
 * @task T4520
 */
export function readManifest(cwd?: string): ManifestEntry[] {
  const manifestPath = getManifestPath(cwd);
  if (!existsSync(manifestPath)) return [];

  const content = readFileSync(manifestPath, 'utf-8');
  const entries: ManifestEntry[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Skip invalid lines
    }
  }

  return entries;
}

/**
 * Append a manifest entry (atomic JSONL append).
 * @task T4520
 */
export function appendManifest(entry: ManifestEntry, cwd?: string): void {
  ensureOutputs(cwd);
  const manifestPath = getManifestPath(cwd);

  // Validate entry
  validateEntry(entry);

  // Check for duplicate ID
  const existing = readManifest(cwd);
  if (existing.some(e => e.id === entry.id)) {
    throw new CleoError(
      ExitCode.ID_COLLISION,
      `Manifest entry with id="${entry.id}" already exists`,
    );
  }

  // Atomic append (single line, no pretty-print)
  const line = JSON.stringify(entry) + '\n';
  appendFileSync(manifestPath, line, 'utf-8');
}

/**
 * Find a manifest entry by ID.
 * @task T4520
 */
export function findEntry(id: string, cwd?: string): ManifestEntry | null {
  const entries = readManifest(cwd);
  return entries.find(e => e.id === id) ?? null;
}

/**
 * Filter manifest entries by criteria.
 * @task T4520
 */
export function filterEntries(
  criteria: {
    status?: string;
    agentType?: string;
    topic?: string;
    linkedTask?: string;
    actionable?: boolean;
  },
  cwd?: string,
): ManifestEntry[] {
  let entries = readManifest(cwd);

  if (criteria.status) {
    const s = criteria.status;
    entries = entries.filter(e => e.status === s);
  }
  if (criteria.agentType) {
    const at = criteria.agentType;
    entries = entries.filter(e => e.agent_type === at);
  }
  if (criteria.topic) {
    const t = criteria.topic;
    entries = entries.filter(e => e.topics.includes(t));
  }
  if (criteria.linkedTask) {
    const lt = criteria.linkedTask;
    entries = entries.filter(e => e.linked_tasks?.includes(lt));
  }
  if (criteria.actionable !== undefined) {
    entries = entries.filter(e => e.actionable === criteria.actionable);
  }

  return entries;
}

/**
 * Get entries with pending follow-ups.
 * @task T4520
 */
export function getPendingFollowup(cwd?: string): ManifestEntry[] {
  const entries = readManifest(cwd);
  return entries.filter(e =>
    Array.isArray(e.needs_followup) && e.needs_followup.length > 0,
  );
}

/**
 * Get unique follow-up task IDs from all manifest entries.
 * @task T4520
 */
export function getFollowupTaskIds(cwd?: string): string[] {
  const entries = getPendingFollowup(cwd);
  const ids = new Set<string>();

  for (const entry of entries) {
    for (const id of entry.needs_followup) {
      if (!id.startsWith('BLOCKED:')) {
        ids.add(id);
      }
    }
  }

  return [...ids];
}

/**
 * Check if a task has linked research.
 * @task T4520
 */
export function taskHasResearch(taskId: string, cwd?: string): { hasResearch: boolean; count: number } {
  const entries = readManifest(cwd);
  const linked = entries.filter(e => e.linked_tasks?.includes(taskId));
  return { hasResearch: linked.length > 0, count: linked.length };
}

/**
 * Archive a manifest entry (move to archive status).
 * @task T4520
 */
export function archiveEntry(entryId: string, cwd?: string): boolean {
  const manifestPath = getManifestPath(cwd);
  if (!existsSync(manifestPath)) return false;

  const content = readFileSync(manifestPath, 'utf-8');
  const lines = content.split('\n');
  let found = false;
  const newLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      newLines.push(line);
      continue;
    }

    try {
      const entry = JSON.parse(trimmed) as ManifestEntry;
      if (entry.id === entryId) {
        entry.status = 'archived';
        newLines.push(JSON.stringify(entry));
        found = true;
      } else {
        newLines.push(line);
      }
    } catch {
      newLines.push(line);
    }
  }

  if (found) {
    writeFileSync(manifestPath, newLines.join('\n'), 'utf-8');
  }

  return found;
}

/**
 * Rotate manifest by archiving old entries.
 * @task T4520
 */
export function rotateManifest(maxEntries: number = 100, cwd?: string): number {
  const entries = readManifest(cwd);
  if (entries.length <= maxEntries) return 0;

  const manifestPath = getManifestPath(cwd);
  const projectRoot = getProjectRoot(cwd);
  const outputDir = getOutputDir(cwd);
  const archiveDir = join(projectRoot, outputDir, 'archive');

  // Archive older entries
  const toKeep = entries.slice(-maxEntries);
  const toArchive = entries.slice(0, entries.length - maxEntries);

  if (!existsSync(archiveDir)) {
    mkdirSync(archiveDir, { recursive: true });
  }

  // Write archive file
  const archivePath = join(archiveDir, `MANIFEST-${new Date().toISOString().split('T')[0]}.jsonl`);
  const archiveContent = toArchive.map(e => JSON.stringify(e)).join('\n') + '\n';
  appendFileSync(archivePath, archiveContent, 'utf-8');

  // Rewrite main manifest with kept entries
  const keepContent = toKeep.map(e => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(manifestPath, keepContent, 'utf-8');

  return toArchive.length;
}

// ============================================================================
// Validation
// ============================================================================

const VALID_STATUSES = new Set(['complete', 'partial', 'blocked', 'archived']);
const VALID_AGENT_TYPES = new Set([
  'research', 'consensus', 'specification', 'decomposition',
  'implementation', 'contribution', 'release',
  'validation', 'documentation', 'analysis', 'testing',
  'cleanup', 'design', 'architecture', 'report',
  'synthesis', 'orchestrator', 'handoff', 'verification', 'review',
]);

/**
 * Validate a manifest entry before appending.
 * @task T4520
 */
function validateEntry(entry: ManifestEntry): void {
  if (!entry.id) {
    throw new CleoError(ExitCode.VALIDATION_ERROR, 'Manifest entry missing "id" field');
  }
  if (!entry.file) {
    throw new CleoError(ExitCode.VALIDATION_ERROR, 'Manifest entry missing "file" field');
  }
  if (!entry.title) {
    throw new CleoError(ExitCode.VALIDATION_ERROR, 'Manifest entry missing "title" field');
  }
  if (!entry.date || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
    throw new CleoError(ExitCode.VALIDATION_ERROR, `Invalid date format: ${entry.date}`);
  }
  if (!VALID_STATUSES.has(entry.status)) {
    throw new CleoError(ExitCode.VALIDATION_ERROR, `Invalid status: ${entry.status}`);
  }
  if (!Array.isArray(entry.topics)) {
    throw new CleoError(ExitCode.VALIDATION_ERROR, 'topics must be an array');
  }
  if (!Array.isArray(entry.key_findings)) {
    throw new CleoError(ExitCode.VALIDATION_ERROR, 'key_findings must be an array');
  }
  if (typeof entry.actionable !== 'boolean') {
    throw new CleoError(ExitCode.VALIDATION_ERROR, 'actionable must be a boolean');
  }

  // Validate agent_type if present
  if (entry.agent_type && !VALID_AGENT_TYPES.has(entry.agent_type) && !entry.agent_type.startsWith('ct-')) {
    throw new CleoError(ExitCode.VALIDATION_ERROR, `Invalid agent_type: ${entry.agent_type}`);
  }
}
