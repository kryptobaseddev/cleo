/**
 * Research commands and manifest operations.
 * @task T4465
 * @epic T4454
 */

import { readJsonRequired, saveJson, appendJsonl, readJson } from '../../store/json.js';
import { safeReadFile } from '../../store/atomic.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { TodoFile } from '../../types/task.js';
import { getTodoPath, getBackupDir, getLogPath, getCleoDirAbsolute } from '../paths.js';
import { logOperation } from '../tasks/add.js';
import { join } from 'node:path';

/** Research entry attached to a task. */
export interface ResearchEntry {
  id: string;
  taskId: string;
  topic: string;
  findings: string[];
  sources: string[];
  status: 'pending' | 'complete' | 'partial';
  createdAt: string;
  updatedAt: string;
}

/** Manifest entry (JSONL line). */
export interface ManifestEntry {
  id: string;
  file: string;
  title: string;
  date: string;
  status: 'complete' | 'partial' | 'blocked';
  agent_type: string;
  topics: string[];
  key_findings: string[];
  actionable: boolean;
  needs_followup: string[];
  linked_tasks: string[];
}

/** Options for adding research. */
export interface AddResearchOptions {
  taskId: string;
  topic: string;
  findings?: string[];
  sources?: string[];
}

/** Options for listing research. */
export interface ListResearchOptions {
  taskId?: string;
  status?: 'pending' | 'complete' | 'partial';
}

/** Manifest query options. */
export interface ManifestQueryOptions {
  status?: string;
  agentType?: string;
  topic?: string;
  taskId?: string;
  limit?: number;
}

/**
 * Get the research file path.
 * @task T4465
 */
function getResearchPath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), 'research.json');
}

/**
 * Get the manifest file path.
 * @task T4465
 */
function getManifestPath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), '..', 'claudedocs', 'agent-outputs', 'MANIFEST.jsonl');
}

/**
 * Read or initialize the research file.
 * @task T4465
 */
async function readResearch(cwd?: string): Promise<{ entries: ResearchEntry[] }> {
  const path = getResearchPath(cwd);
  const data = await readJson<{ entries: ResearchEntry[] }>(path);
  return data ?? { entries: [] };
}

/**
 * Add a research entry.
 * @task T4465
 */
export async function addResearch(options: AddResearchOptions, cwd?: string): Promise<ResearchEntry> {
  const todoPath = getTodoPath(cwd);
  const data = await readJsonRequired<TodoFile>(todoPath);

  // Validate task exists
  const task = data.tasks.find(t => t.id === options.taskId);
  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${options.taskId}`);
  }

  if (!options.topic || options.topic.trim().length === 0) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Research topic is required');
  }

  const research = await readResearch(cwd);
  const now = new Date().toISOString();

  const entry: ResearchEntry = {
    id: `R${Date.now().toString(36)}`,
    taskId: options.taskId,
    topic: options.topic.trim(),
    findings: options.findings ?? [],
    sources: options.sources ?? [],
    status: (options.findings?.length ?? 0) > 0 ? 'complete' : 'pending',
    createdAt: now,
    updatedAt: now,
  };

  research.entries.push(entry);

  await saveJson(getResearchPath(cwd), research, { backupDir: getBackupDir(cwd) });
  await logOperation(getLogPath(cwd), 'research_added', entry.id, {
    taskId: options.taskId,
    topic: options.topic,
  });

  return entry;
}

/**
 * Show a specific research entry.
 * @task T4465
 */
export async function showResearch(researchId: string, cwd?: string): Promise<ResearchEntry> {
  const research = await readResearch(cwd);
  const entry = research.entries.find(e => e.id === researchId);

  if (!entry) {
    throw new CleoError(ExitCode.NOT_FOUND, `Research entry not found: ${researchId}`);
  }

  return entry;
}

/**
 * List research entries with optional filtering.
 * @task T4465
 */
export async function listResearch(options: ListResearchOptions = {}, cwd?: string): Promise<ResearchEntry[]> {
  const research = await readResearch(cwd);
  let entries = research.entries;

  if (options.taskId) {
    entries = entries.filter(e => e.taskId === options.taskId);
  }
  if (options.status) {
    entries = entries.filter(e => e.status === options.status);
  }

  return entries;
}

/**
 * List pending research entries.
 * @task T4465
 */
export async function pendingResearch(cwd?: string): Promise<ResearchEntry[]> {
  return listResearch({ status: 'pending' }, cwd);
}

/**
 * Link a research entry to a task.
 * @task T4465
 */
export async function linkResearch(
  researchId: string,
  taskId: string,
  cwd?: string,
): Promise<{ researchId: string; taskId: string }> {
  const research = await readResearch(cwd);
  const entry = research.entries.find(e => e.id === researchId);

  if (!entry) {
    throw new CleoError(ExitCode.NOT_FOUND, `Research entry not found: ${researchId}`);
  }

  // Validate task exists
  const todoData = await readJsonRequired<TodoFile>(getTodoPath(cwd));
  const task = todoData.tasks.find(t => t.id === taskId);
  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${taskId}`);
  }

  entry.taskId = taskId;
  entry.updatedAt = new Date().toISOString();

  await saveJson(getResearchPath(cwd), research, { backupDir: getBackupDir(cwd) });

  return { researchId, taskId };
}

/**
 * Update research findings.
 * @task T4465
 */
export async function updateResearch(
  researchId: string,
  updates: { findings?: string[]; sources?: string[]; status?: 'pending' | 'complete' | 'partial' },
  cwd?: string,
): Promise<ResearchEntry> {
  const research = await readResearch(cwd);
  const entry = research.entries.find(e => e.id === researchId);

  if (!entry) {
    throw new CleoError(ExitCode.NOT_FOUND, `Research entry not found: ${researchId}`);
  }

  if (updates.findings) entry.findings = updates.findings;
  if (updates.sources) entry.sources = updates.sources;
  if (updates.status) entry.status = updates.status;
  entry.updatedAt = new Date().toISOString();

  await saveJson(getResearchPath(cwd), research, { backupDir: getBackupDir(cwd) });

  return entry;
}

// === MANIFEST OPERATIONS ===

/**
 * Read manifest entries from MANIFEST.jsonl.
 * @task T4465
 */
export async function readManifest(cwd?: string): Promise<ManifestEntry[]> {
  const manifestPath = getManifestPath(cwd);
  const content = await safeReadFile(manifestPath);
  if (!content) return [];

  const entries: ManifestEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as ManifestEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/**
 * Append a manifest entry.
 * @task T4465
 */
export async function appendManifest(entry: ManifestEntry, cwd?: string): Promise<void> {
  const manifestPath = getManifestPath(cwd);
  await appendJsonl(manifestPath, entry);
}

/**
 * Query manifest entries.
 * @task T4465
 */
export async function queryManifest(
  options: ManifestQueryOptions = {},
  cwd?: string,
): Promise<ManifestEntry[]> {
  let entries = await readManifest(cwd);

  if (options.status) {
    entries = entries.filter(e => e.status === options.status);
  }
  if (options.agentType) {
    entries = entries.filter(e => e.agent_type === options.agentType);
  }
  if (options.topic) {
    entries = entries.filter(e => e.topics.includes(options.topic!));
  }
  if (options.taskId) {
    entries = entries.filter(e => e.linked_tasks.includes(options.taskId!));
  }
  if (options.limit && options.limit > 0) {
    entries = entries.slice(0, options.limit);
  }

  return entries;
}
