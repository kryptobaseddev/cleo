/**
 * JSON file-based implementation of the DataAccessor interface.
 *
 * Delegates to readJson/readJsonRequired/saveJson/appendJsonl for all I/O,
 * and uses path helpers from ../core/paths.js for file location resolution.
 *
 * @epic T4454
 */

import type { TodoFile } from '../types/task.js';
import type { DataAccessor, ArchiveFile, SessionsFile } from './data-accessor.js';
import { readJson, readJsonRequired, saveJson, appendJsonl } from './json.js';
import {
  getTodoPath,
  getArchivePath,
  getSessionsPath,
  getLogPath,
  getBackupDir,
} from '../core/paths.js';

/**
 * Create a JSON file-backed DataAccessor.
 *
 * @param cwd - Working directory for path resolution (defaults to process.cwd())
 */
export async function createJsonDataAccessor(cwd?: string): Promise<DataAccessor> {
  return {
    engine: 'json' as const,

    async loadTodoFile(): Promise<TodoFile> {
      return readJsonRequired<TodoFile>(getTodoPath(cwd));
    },

    async saveTodoFile(data: TodoFile): Promise<void> {
      await saveJson(getTodoPath(cwd), data, { backupDir: getBackupDir(cwd) });
    },

    async loadArchive(): Promise<ArchiveFile | null> {
      return readJson<ArchiveFile>(getArchivePath(cwd));
    },

    async saveArchive(data: ArchiveFile): Promise<void> {
      await saveJson(getArchivePath(cwd), data, { backupDir: getBackupDir(cwd) });
    },

    async loadSessions(): Promise<SessionsFile> {
      const data = await readJson<SessionsFile>(getSessionsPath(cwd));
      if (data) {
        // Ensure _meta exists even on old sessions files
        if (!data._meta) {
          data._meta = { schemaVersion: '1.0.0', lastUpdated: new Date().toISOString() };
        }
        if (!data.version) {
          data.version = '1.0.0';
        }
        return data;
      }
      return {
        sessions: [],
        version: '1.0.0',
        _meta: { schemaVersion: '1.0.0', lastUpdated: new Date().toISOString() },
      };
    },

    async saveSessions(data: SessionsFile): Promise<void> {
      await saveJson(getSessionsPath(cwd), data, { backupDir: getBackupDir(cwd) });
    },

    async appendLog(entry: Record<string, unknown>): Promise<void> {
      await appendJsonl(getLogPath(cwd), entry);
    },

    async close(): Promise<void> {
      // No-op: JSON files don't hold open resources.
    },
  };
}
