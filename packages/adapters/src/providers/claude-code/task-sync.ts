/**
 * Claude Code TaskSyncProvider — bridges Claude's TodoWrite format
 * to the provider-agnostic reconciliation system.
 *
 * All Claude Code / TodoWrite-specific parsing lives here.
 * The core reconciliation engine never sees TodoWrite formats.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ExternalTask,
  ExternalTaskProvider,
  ExternalTaskStatus,
} from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// TodoWrite native types (Claude-specific, never exposed beyond this file)
// ---------------------------------------------------------------------------

interface TodoWriteItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

interface TodoWriteState {
  todos: TodoWriteItem[];
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a CLEO task ID from TodoWrite content prefix: "[T001] ..." -> "T001".
 */
function parseTaskId(content: string): string | null {
  const match = content.match(/^\[T(\d+)\]/);
  return match ? `T${match[1]}` : null;
}

/**
 * Strip ID and status prefixes from content to extract the clean title.
 */
function stripPrefixes(content: string): string {
  return content
    .replace(/^\[T\d+\]\s*/, '')
    .replace(/^\[!\]\s*/, '')
    .replace(/^\[BLOCKED\]\s*/, '');
}

/**
 * Map TodoWrite status to normalized ExternalTaskStatus.
 */
function mapStatus(twStatus: TodoWriteItem['status']): ExternalTaskStatus {
  switch (twStatus) {
    case 'completed':
      return 'completed';
    case 'in_progress':
      return 'active';
    case 'pending':
      return 'pending';
    default:
      return 'pending';
  }
}

/**
 * Resolve the TodoWrite state file path.
 * Claude Code writes its TodoWrite state to a known location.
 */
function getTodoWriteFilePath(projectDir: string): string {
  return join(projectDir, '.cleo', 'sync', 'todowrite-state.json');
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/**
 * Claude Code TaskSyncProvider.
 *
 * Reads Claude's TodoWrite JSON state, parses [T001]-prefixed task IDs
 * and status, and returns normalized ExternalTask[].
 *
 * Optional: accepts a custom file path for testing.
 */
export class ClaudeCodeTaskSyncProvider implements ExternalTaskProvider {
  private readonly customFilePath?: string;

  constructor(options?: { filePath?: string }) {
    this.customFilePath = options?.filePath;
  }

  async getExternalTasks(projectDir: string): Promise<ExternalTask[]> {
    const filePath = this.customFilePath ?? getTodoWriteFilePath(projectDir);

    // Check file exists
    try {
      await stat(filePath);
    } catch {
      // No TodoWrite state — return empty (no tasks to sync)
      return [];
    }

    // Parse the TodoWrite JSON
    const raw = await readFile(filePath, 'utf-8');
    let state: TodoWriteState;
    try {
      state = JSON.parse(raw) as TodoWriteState;
    } catch {
      return []; // Malformed JSON — treat as empty
    }

    if (!state.todos || !Array.isArray(state.todos)) {
      return [];
    }

    const tasks: ExternalTask[] = [];
    let syntheticIndex = 0;

    for (const item of state.todos) {
      const cleoTaskId = parseTaskId(item.content);
      const title = cleoTaskId ? stripPrefixes(item.content).trim() : item.content.trim();

      if (!title) continue;

      tasks.push({
        externalId: cleoTaskId ?? `tw-new-${syntheticIndex++}`,
        title,
        status: mapStatus(item.status),
        providerMeta: {
          source: 'todowrite',
          cleoTaskId,
          activeForm: item.activeForm,
          rawContent: item.content,
        },
      });
    }

    return tasks;
  }
}
