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
  AgentRegistrySubAccessor,
  ArchiveFields,
  ArchiveFile,
  BrainAccessor,
  ConduitAccessor,
  DataAccessor,
  DataAccessorAgentInstance,
  DocsAccessor,
  NexusAccessor,
  QueryTasksResult,
  Session,
  Task,
  TaskAuditLogQuery,
  TaskAuditLogRow,
  TaskFieldUpdates,
  TaskQueryFilters,
  TelemetryAccessor,
  TransactionAccessor,
} from '@cleocode/contracts';
import { resolveOrCwd } from '../paths.js';
import { createBrainAccessor } from './brain-accessor-impl.js';
import {
  createAgentRegistrySubAccessor,
  createConduitAccessor,
  createNexusAccessor,
  createTelemetryAccessor,
} from './role-accessors-impl.js';
import { createSqliteDataAccessor } from './sqlite-data-accessor.js';

/**
 * Logical sub-accessor selector for {@link UmbrellaDataAccessor.getSubAccessor}.
 *
 * These are **domain-level accessor roles** — distinct from the physical
 * DB-open scope (`'project'` | `'global'`, the post-E6 {@link CleoDbRole}).
 * One physical `cleo.db` per scope now backs many of these logical roles
 * (e.g. `tasks` / `brain` / `conduit` / `sessions` all live in the project
 * `cleo.db`; `nexus` / `signaldock` live in the global `cleo.db`).
 *
 * @task T9188, T11526 (E6-L6 — decoupled from CleoDbRole)
 */
export type SubAccessorRole =
  | 'tasks'
  | 'sessions'
  | 'brain'
  | 'conduit'
  | 'nexus'
  | 'signaldock'
  | 'telemetry'
  | 'docs';

/** Union of all typed sub-accessor types (T9188). */
export type TypedSubAccessor =
  | DataAccessor
  | BrainAccessor
  | ConduitAccessor
  | DocsAccessor
  | NexusAccessor
  | AgentRegistrySubAccessor
  | TelemetryAccessor;

export class UmbrellaDataAccessor implements DataAccessor {
  readonly engine = 'sqlite' as const;

  /** Lazy-initialized sub-accessors keyed by logical role. */
  private accessors = new Map<SubAccessorRole, DataAccessor>();

  /** Lazy-initialized role-specific typed sub-accessors (T9188). */
  private typedAccessors = new Map<SubAccessorRole, TypedSubAccessor>();

  /** cwd used for project-tier sub-accessor creation. */
  private cwd: string | undefined;

  constructor(cwd?: string) {
    this.cwd = cwd;
  }

  /**
   * Get (or create) a typed sub-accessor for the given role.
   *
   * Lazily initializes on first call. Returns a role-specific typed accessor:
   *   - 'tasks'      → DataAccessor (full task CRUD)
   *   - 'brain'      → BrainAccessor (memory observe + find)
   *   - 'conduit'    → ConduitAccessor (messaging publish + ping)
   *   - 'nexus'      → NexusAccessor (code intelligence ping)
   *   - 'signaldock' → AgentRegistrySubAccessor (agent identity ping)
   *   - 'telemetry'  → TelemetryAccessor (event recording stub)
   *   - 'docs'       → DocsAccessor (document storage + search)
   *   - 'sessions'   → DataAccessor (session-scoped tasks accessor)
   *
   * @param role - Database role.
   * @returns A typed accessor for that role.
   * @task T9188
   */
  async getSubAccessor(role: SubAccessorRole): Promise<TypedSubAccessor> {
    // Check typed cache first
    const cached = this.typedAccessors.get(role);
    if (cached) return cached;

    let accessor: TypedSubAccessor;

    switch (role) {
      case 'tasks':
      case 'sessions': {
        // DataAccessor — full task/session CRUD
        accessor = await createSqliteDataAccessor(this.cwd);
        this.accessors.set(role, accessor as DataAccessor);
        break;
      }
      case 'brain': {
        // BrainAccessor — memory observe + search
        accessor = createBrainAccessor(this.cwd);
        break;
      }
      case 'conduit': {
        // ConduitAccessor — project-scoped messaging
        accessor = createConduitAccessor(this.cwd);
        break;
      }
      case 'nexus': {
        // NexusAccessor — code intelligence graph. E6-L6 (T11526): the accessor
        // self-opens the global cleo.db via getNexusDb() (which runs the legacy
        // nexus migrations), so no separate ensure-open is required here.
        accessor = createNexusAccessor(this.cwd);
        break;
      }
      case 'signaldock': {
        // AgentRegistrySubAccessor — global agent identity
        accessor = createAgentRegistrySubAccessor();
        break;
      }
      case 'telemetry': {
        // TelemetryAccessor — stub (no backing DB yet)
        accessor = createTelemetryAccessor();
        break;
      }
      case 'docs': {
        // DocsAccessor — documents + llmtxt (T9063)
        const { createDocsAccessor } = await import('./docs-accessor-impl.js');
        accessor = createDocsAccessor(resolveOrCwd(this.cwd));
        break;
      }
      default: {
        // llmtxt and future roles
        throw new Error(
          `UmbrellaDataAccessor.getSubAccessor("${role}"): role not yet implemented.`,
        );
      }
    }

    this.typedAccessors.set(role, accessor);
    return accessor;
  }

  /** Return the canonical 'tasks' sub-accessor (backward compat). */
  private async tasks(): Promise<DataAccessor> {
    return this.getSubAccessor('tasks') as Promise<DataAccessor>;
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

    // Close standard DataAccessors
    for (const [role, accessor] of this.accessors) {
      closers.push(
        accessor.close().catch((err) => {
          console.error(`UmbrellaDataAccessor.close() failed for role "${role}":`, err);
        }),
      );
    }

    // Close typed sub-accessors (T9188)
    for (const [role, accessor] of this.typedAccessors) {
      if (!this.accessors.has(role)) {
        // Only close if not already closed via this.accessors
        const typedAccessor = accessor as { close?: () => Promise<void> };
        if (typeof typedAccessor.close === 'function') {
          closers.push(
            typedAccessor.close().catch((err: unknown) => {
              console.error(`UmbrellaDataAccessor.close() failed for typed role "${role}":`, err);
            }),
          );
        }
      }
    }

    await Promise.all(closers);
    this.accessors.clear();
    this.typedAccessors.clear();
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

  async removeRelation(taskId: string, relatedTo: string, relationType?: string): Promise<void> {
    return (await this.tasks()).removeRelation(taskId, relatedTo, relationType);
  }

  // ---- AC rows (T10508 — pass-through) ----

  async getAcRows(taskId: string) {
    return (await this.tasks()).getAcRows(taskId);
  }

  // ---- AC bindings (T10509 — pass-through) ----

  async getAcBindings(acIds: readonly string[]) {
    return (await this.tasks()).getAcBindings(acIds);
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

  async queryAuditLog(query: TaskAuditLogQuery): Promise<TaskAuditLogRow[]> {
    return (await this.tasks()).queryAuditLog(query);
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

  async shiftPositions(
    parentId: string | null,
    fromPosition: number,
    delta: number,
  ): Promise<void> {
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
