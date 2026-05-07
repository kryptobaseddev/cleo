/**
 * UmbrellaDataAccessor — composes sub-accessors by CleoDbRole.
 *
 * Implements the DataAccessor interface by delegating all existing methods
 * to the 'tasks' sub-accessor. This maintains backward compatibility while
 * enabling future multi-DB operations (e.g. cross-db transactions, brain
 * decision reads, nexus lookups) via getSubAccessor(role).
 *
 * Sub-accessors are lazily initialized on first use.
 *
 * @task T9050
 * @epic T9048
 */

import type {
  ArchiveFields,
  ArchiveFile,
  DataAccessor,
  DataAccessorAgentInstance,
  QueryTasksResult,
  Session,
  Task,
  TaskFieldUpdates,
  TaskQueryFilters,
  TransactionAccessor,
} from '@cleocode/contracts';
import type { CleoDbRole } from './open-cleo-db.js';
import { openCleoDb } from './open-cleo-db.js';
import { createSqliteDataAccessor } from './sqlite-data-accessor.js';

export class UmbrellaDataAccessor implements DataAccessor {
  readonly engine = 'sqlite' as const;

  /** Lazy-initialized sub-accessors keyed by role. */
  private accessors = new Map<CleoDbRole, DataAccessor>();

  /** cwd used for project-tier sub-accessor creation. */
  private cwd: string | undefined;

  constructor(cwd?: string) {
    this.cwd = cwd;
  }

  /**
   * Get (or create) a sub-accessor for the given role.
   *
   * Lazily initializes on first call. The 'tasks' accessor is created via
   * the existing createSqliteDataAccessor() factory (which includes safety
   * wrapping). Other roles will use role-specific factories as they are
   * introduced.
   *
   * @param role - Database role.
   * @returns A DataAccessor for that role.
   */
  async getSubAccessor(role: CleoDbRole): Promise<DataAccessor> {
    const existing = this.accessors.get(role);
    if (existing) return existing;

    // For now, only 'tasks' has a full DataAccessor implementation.
    // Future roles (brain, sessions, signaldock, conduit, nexus, llmtxt)
    // will get their own accessor implementations.
    if (role === 'tasks') {
      const accessor = await createSqliteDataAccessor(this.cwd);
      this.accessors.set(role, accessor);
      return accessor;
    }

    // For other roles, we open the DB via openCleoDb so the handle is
    // tracked, but we do NOT yet return a full DataAccessor because the
    // interface methods (loadTasks, saveTasks, etc.) are task-centric.
    // Callers that need brain/nexus/etc. operations should use the raw
    // DBHandle or role-specific APIs. This will evolve as multi-DB
    // accessor interfaces are defined.
    await openCleoDb(role, this.cwd);
    throw new Error(
      `UmbrellaDataAccessor.getSubAccessor("${role}") is not yet implemented. ` +
        `Only "tasks" sub-accessor is available. Track: T9050 follow-ups.`,
    );
  }

  /** Return the canonical 'tasks' sub-accessor (backward compat). */
  private async tasks(): Promise<DataAccessor> {
    return this.getSubAccessor('tasks');
  }

  // =========================================================================
  // DataAccessor interface — all delegate to 'tasks' sub-accessor
  // =========================================================================

  async loadArchive(): Promise<ArchiveFile | null> {
    return (await this.tasks()).loadArchive();
  }

  async saveArchive(data: ArchiveFile): Promise<void> {
    return (await this.tasks()).saveArchive(data);
  }

  async loadSessions(): Promise<Session[]> {
    return (await this.tasks()).loadSessions();
  }

  async saveSessions(sessions: Session[]): Promise<void> {
    return (await this.tasks()).saveSessions(sessions);
  }

  async appendLog(entry: Record<string, unknown>): Promise<void> {
    return (await this.tasks()).appendLog(entry);
  }

  async close(): Promise<void> {
    const closers: Promise<void>[] = [];
    for (const [role, accessor] of this.accessors) {
      closers.push(
        accessor.close().catch((err) => {
          // Log and continue — never let one close failure block others
          console.error(`UmbrellaDataAccessor.close() failed for role "${role}":`, err);
        }),
      );
    }
    await Promise.all(closers);
    this.accessors.clear();
  }

  async upsertSingleTask(task: Task): Promise<void> {
    return (await this.tasks()).upsertSingleTask(task);
  }

  async archiveSingleTask(taskId: string, fields: ArchiveFields): Promise<void> {
    return (await this.tasks()).archiveSingleTask(taskId, fields);
  }

  async removeSingleTask(taskId: string): Promise<void> {
    return (await this.tasks()).removeSingleTask(taskId);
  }

  async loadSingleTask(taskId: string): Promise<Task | null> {
    return (await this.tasks()).loadSingleTask(taskId);
  }

  async addRelation(
    taskId: string,
    relatedTo: string,
    relationType: string,
    reason?: string,
  ): Promise<void> {
    return (await this.tasks()).addRelation(taskId, relatedTo, relationType, reason);
  }

  async getMetaValue<T>(key: string): Promise<T | null> {
    return (await this.tasks()).getMetaValue<T>(key);
  }

  async setMetaValue(key: string, value: unknown): Promise<void> {
    return (await this.tasks()).setMetaValue(key, value);
  }

  async getSchemaVersion(): Promise<string | null> {
    return (await this.tasks()).getSchemaVersion();
  }

  async queryTasks(filters: TaskQueryFilters): Promise<QueryTasksResult> {
    return (await this.tasks()).queryTasks(filters);
  }

  async countTasks(filters?: { status?: string | string[]; parentId?: string }): Promise<number> {
    return (await this.tasks()).countTasks(filters as Parameters<DataAccessor['countTasks']>[0]);
  }

  async getChildren(parentId: string): Promise<Task[]> {
    return (await this.tasks()).getChildren(parentId);
  }

  async countChildren(parentId: string): Promise<number> {
    return (await this.tasks()).countChildren(parentId);
  }

  async countActiveChildren(parentId: string): Promise<number> {
    return (await this.tasks()).countActiveChildren(parentId);
  }

  async getAncestorChain(taskId: string): Promise<Task[]> {
    return (await this.tasks()).getAncestorChain(taskId);
  }

  async getSubtree(rootId: string): Promise<Task[]> {
    return (await this.tasks()).getSubtree(rootId);
  }

  async getDependents(taskId: string): Promise<Task[]> {
    return (await this.tasks()).getDependents(taskId);
  }

  async getDependencyChain(taskId: string): Promise<string[]> {
    return (await this.tasks()).getDependencyChain(taskId);
  }

  async taskExists(taskId: string): Promise<boolean> {
    return (await this.tasks()).taskExists(taskId);
  }

  async loadTasks(taskIds: string[]): Promise<Task[]> {
    return (await this.tasks()).loadTasks(taskIds);
  }

  async updateTaskFields(taskId: string, fields: TaskFieldUpdates): Promise<void> {
    return (await this.tasks()).updateTaskFields(taskId, fields);
  }

  async getNextPosition(parentId: string | null): Promise<number> {
    return (await this.tasks()).getNextPosition(parentId);
  }

  async shiftPositions(parentId: string | null, fromPosition: number, delta: number): Promise<void> {
    return (await this.tasks()).shiftPositions(parentId, fromPosition, delta);
  }

  async transaction<T>(fn: (tx: TransactionAccessor) => Promise<T>): Promise<T> {
    return (await this.tasks()).transaction(fn);
  }

  async getActiveSession(): Promise<Session | null> {
    return (await this.tasks()).getActiveSession();
  }

  async upsertSingleSession(session: Session): Promise<void> {
    return (await this.tasks()).upsertSingleSession(session);
  }

  async removeSingleSession(sessionId: string): Promise<void> {
    return (await this.tasks()).removeSingleSession(sessionId);
  }

  async listAgentInstances(filters?: {
    status?: string | string[];
    agentType?: string | string[];
  }): Promise<DataAccessorAgentInstance[]> {
    return (await this.tasks()).listAgentInstances(filters);
  }

  async getAgentInstance(agentId: string): Promise<DataAccessorAgentInstance | null> {
    return (await this.tasks()).getAgentInstance(agentId);
  }

  async claimTask(taskId: string, agentId: string): Promise<void> {
    return (await this.tasks()).claimTask(taskId, agentId);
  }

  async unclaimTask(taskId: string): Promise<void> {
    return (await this.tasks()).unclaimTask(taskId);
  }
}
