/**
 * Claude Code TaskSyncProvider — bridges Claude's TodoWrite format
 * to the provider-agnostic reconciliation system.
 *
 * All Claude Code / TodoWrite-specific parsing lives here.
 * The core reconciliation engine never sees TodoWrite formats.
 *
 * @task T5800
 */
import type { AdapterTaskSyncProvider, ExternalTask } from '@cleocode/contracts';
/**
 * Claude Code TaskSyncProvider.
 *
 * Reads Claude's TodoWrite JSON state, parses [T001]-prefixed task IDs
 * and status, and returns normalized ExternalTask[].
 *
 * Optional: accepts a custom file path for testing.
 */
export declare class ClaudeCodeTaskSyncProvider implements AdapterTaskSyncProvider {
  private readonly customFilePath?;
  constructor(options?: {
    filePath?: string;
  });
  getExternalTasks(projectDir: string): Promise<ExternalTask[]>;
  cleanup(projectDir: string): Promise<void>;
}
//# sourceMappingURL=task-sync.d.ts.map
