/**
 * Agent instance registry -- runtime tracking of live agent processes.
 *
 * Provides CRUD operations for the `agent_instances` table:
 * registration, deregistration, heartbeat, status updates, and queries.
 *
 * This is the DB-backed runtime registry for live agent *instances*.
 * The file-based registry in `skills/agents/registry.ts` tracks installed
 * agent *definitions* -- those are complementary, not competing, concepts.
 *
 * @module agents/registry
 */

import { randomBytes } from 'node:crypto';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { getDb } from '../store/sqlite.js';
import {
  type AgentErrorLogRow,
  type AgentErrorType,
  type AgentInstanceRow,
  type AgentInstanceStatus,
  type AgentType,
  agentErrorLog,
  agentInstances,
} from './agent-schema.js';

// ============================================================================
// ID generation
// ============================================================================

/**
 * Generate a unique agent instance ID.
 * Format: `agt_{YYYYMMDDHHmmss}_{6hex}`
 */
export function generateAgentId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').substring(0, 14);
  const hex = randomBytes(3).toString('hex');
  return `agt_${ts}_${hex}`;
}

// ============================================================================
// Registration
// ============================================================================

/** Options for registering a new agent instance. */
export interface RegisterAgentOptions {
  agentType: AgentType;
  sessionId?: string;
  taskId?: string;
  parentAgentId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Register a new agent instance in the database.
 * Sets initial status to 'starting' and records the first heartbeat.
 */
export async function registerAgent(
  opts: RegisterAgentOptions,
  cwd?: string,
): Promise<AgentInstanceRow> {
  const db = await getDb(cwd);
  const id = generateAgentId();
  const now = new Date().toISOString();

  const row: typeof agentInstances.$inferInsert = {
    id,
    agentType: opts.agentType,
    status: 'starting',
    sessionId: opts.sessionId ?? null,
    taskId: opts.taskId ?? null,
    startedAt: now,
    lastHeartbeat: now,
    stoppedAt: null,
    errorCount: 0,
    totalTasksCompleted: 0,
    capacity: '1.0',
    metadataJson: opts.metadata ? JSON.stringify(opts.metadata) : '{}',
    parentAgentId: opts.parentAgentId ?? null,
  };

  await db.insert(agentInstances).values(row);
  return row as AgentInstanceRow;
}

/**
 * Deregister (stop) an agent instance.
 * Sets status to 'stopped' and records the stop timestamp.
 */
export async function deregisterAgent(id: string, cwd?: string): Promise<AgentInstanceRow | null> {
  const db = await getDb(cwd);
  const now = new Date().toISOString();

  const existing = await db.select().from(agentInstances).where(eq(agentInstances.id, id)).get();
  if (!existing) return null;

  // Already stopped -- idempotent
  if (existing.status === 'stopped') return existing;

  await db
    .update(agentInstances)
    .set({ status: 'stopped', stoppedAt: now })
    .where(eq(agentInstances.id, id));

  return { ...existing, status: 'stopped', stoppedAt: now };
}

// ============================================================================
// Heartbeat
// ============================================================================

/**
 * Record a heartbeat for an agent instance.
 * Updates `last_heartbeat` and returns the current status so the agent
 * can detect if it has been externally marked for shutdown.
 */
export async function heartbeat(id: string, cwd?: string): Promise<AgentInstanceStatus | null> {
  const db = await getDb(cwd);
  const now = new Date().toISOString();

  const existing = await db.select().from(agentInstances).where(eq(agentInstances.id, id)).get();
  if (!existing) return null;

  // Do not update heartbeat for terminal states
  if (existing.status === 'stopped' || existing.status === 'crashed') {
    return existing.status;
  }

  await db.update(agentInstances).set({ lastHeartbeat: now }).where(eq(agentInstances.id, id));

  return existing.status;
}

// ============================================================================
// Status management
// ============================================================================

/** Options for updating agent status. */
export interface UpdateStatusOptions {
  status: AgentInstanceStatus;
  error?: string;
  taskId?: string;
}

/**
 * Update agent status with optional error tracking.
 * When status is 'error' or 'crashed', increments the error count
 * and logs the error to the agent_error_log table.
 */
export async function updateAgentStatus(
  id: string,
  opts: UpdateStatusOptions,
  cwd?: string,
): Promise<AgentInstanceRow | null> {
  const db = await getDb(cwd);

  const existing = await db.select().from(agentInstances).where(eq(agentInstances.id, id)).get();
  if (!existing) return null;

  const updates: Partial<typeof agentInstances.$inferInsert> = {
    status: opts.status,
  };

  if (opts.taskId !== undefined) {
    updates.taskId = opts.taskId;
  }

  // If transitioning to active, update heartbeat
  if (opts.status === 'active') {
    updates.lastHeartbeat = new Date().toISOString();
  }

  // Track errors
  if (opts.status === 'error' || opts.status === 'crashed') {
    updates.errorCount = existing.errorCount + 1;

    if (opts.error) {
      const errorType = classifyError(new Error(opts.error));
      await db.insert(agentErrorLog).values({
        agentId: id,
        errorType,
        message: opts.error,
        occurredAt: new Date().toISOString(),
      });
    }
  }

  // If stopped, set stoppedAt
  if (opts.status === 'stopped') {
    updates.stoppedAt = new Date().toISOString();
  }

  await db.update(agentInstances).set(updates).where(eq(agentInstances.id, id));

  return { ...existing, ...updates } as AgentInstanceRow;
}

/**
 * Increment the completed task count for an agent.
 */
export async function incrementTasksCompleted(id: string, cwd?: string): Promise<void> {
  const db = await getDb(cwd);
  await db
    .update(agentInstances)
    .set({ totalTasksCompleted: sql`${agentInstances.totalTasksCompleted} + 1` })
    .where(eq(agentInstances.id, id));
}

// ============================================================================
// Queries
// ============================================================================

/** Filters for listing agent instances. */
export interface ListAgentFilters {
  status?: AgentInstanceStatus | AgentInstanceStatus[];
  agentType?: AgentType | AgentType[];
  sessionId?: string;
  parentAgentId?: string;
}

/**
 * List agent instances with optional filters.
 */
export async function listAgentInstances(
  filters?: ListAgentFilters,
  cwd?: string,
): Promise<AgentInstanceRow[]> {
  const db = await getDb(cwd);

  const conditions = [];

  if (filters?.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    conditions.push(inArray(agentInstances.status, statuses));
  }

  if (filters?.agentType) {
    const types = Array.isArray(filters.agentType) ? filters.agentType : [filters.agentType];
    conditions.push(inArray(agentInstances.agentType, types));
  }

  if (filters?.sessionId) {
    conditions.push(eq(agentInstances.sessionId, filters.sessionId));
  }

  if (filters?.parentAgentId) {
    conditions.push(eq(agentInstances.parentAgentId, filters.parentAgentId));
  }

  if (conditions.length === 0) {
    return db.select().from(agentInstances).all();
  }

  return db
    .select()
    .from(agentInstances)
    .where(and(...conditions))
    .all();
}

/**
 * Get a single agent instance by ID.
 */
export async function getAgentInstance(id: string, cwd?: string): Promise<AgentInstanceRow | null> {
  const db = await getDb(cwd);
  const row = await db.select().from(agentInstances).where(eq(agentInstances.id, id)).get();
  return row ?? null;
}

// ============================================================================
// Error classification
// ============================================================================

/** Patterns indicating retriable errors. */
const RETRIABLE_PATTERNS = [
  /timeout/i,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /EPIPE/,
  /ETIMEDOUT/,
  /rate.?limit/i,
  /429/,
  /503/,
  /502/,
  /SQLITE_BUSY/i,
  /database is locked/i,
  /temporarily unavailable/i,
  /too many requests/i,
  /network/i,
  /socket hang up/i,
];

/** Patterns indicating permanent (non-retriable) errors. */
const PERMANENT_PATTERNS = [
  /permission denied/i,
  /EACCES/,
  /authentication/i,
  /unauthorized/i,
  /401/,
  /403/,
  /404/,
  /not found/i,
  /invalid.*token/i,
  /SQLITE_CONSTRAINT/i,
  /syntax error/i,
  /type error/i,
  /reference error/i,
];

/**
 * Classify an error as retriable, permanent, or unknown.
 *
 * Retriable errors are transient conditions (network, rate limits, locks)
 * where a retry may succeed. Permanent errors are structural (auth,
 * not found, constraint violations) where retrying is pointless.
 */
export function classifyError(error: unknown): AgentErrorType {
  const message = error instanceof Error ? error.message : String(error);

  for (const pattern of RETRIABLE_PATTERNS) {
    if (pattern.test(message)) return 'retriable';
  }

  for (const pattern of PERMANENT_PATTERNS) {
    if (pattern.test(message)) return 'permanent';
  }

  return 'unknown';
}

/**
 * Get the error history for a specific agent.
 */
export async function getAgentErrorHistory(
  agentId: string,
  cwd?: string,
): Promise<AgentErrorLogRow[]> {
  const db = await getDb(cwd);
  return db.select().from(agentErrorLog).where(eq(agentErrorLog.agentId, agentId)).all();
}

// ============================================================================
// Health Monitoring
// ============================================================================

/**
 * Check agent health by finding instances whose last heartbeat exceeds the threshold.
 * Default threshold: 30000ms (30 seconds) as specified by the BRAIN spec.
 *
 * Returns agents that appear to have crashed (stale heartbeat).
 */
export async function checkAgentHealth(
  thresholdMs: number = 30_000,
  cwd?: string,
): Promise<AgentInstanceRow[]> {
  const db = await getDb(cwd);
  const cutoff = new Date(Date.now() - thresholdMs).toISOString();

  return db
    .select()
    .from(agentInstances)
    .where(
      and(
        inArray(agentInstances.status, ['active', 'idle', 'starting']),
        lt(agentInstances.lastHeartbeat, cutoff),
      ),
    )
    .all();
}

/**
 * Mark an agent instance as crashed.
 * Increments error count and sets status to 'crashed'.
 */
export async function markCrashed(
  id: string,
  reason?: string,
  cwd?: string,
): Promise<AgentInstanceRow | null> {
  return updateAgentStatus(
    id,
    { status: 'crashed', error: reason ?? 'Heartbeat timeout — agent presumed crashed' },
    cwd,
  );
}

/** Agent health report summary. */
export interface AgentHealthReport {
  total: number;
  active: number;
  idle: number;
  starting: number;
  error: number;
  crashed: number;
  stopped: number;
  totalErrors: number;
  staleAgents: AgentInstanceRow[];
}

/**
 * Generate a health report summarizing all agent instances.
 * Includes counts by status and identifies stale agents.
 */
export async function getHealthReport(
  thresholdMs: number = 30_000,
  cwd?: string,
): Promise<AgentHealthReport> {
  const allAgents = await listAgentInstances(undefined, cwd);
  const staleAgents = await checkAgentHealth(thresholdMs, cwd);

  const report: AgentHealthReport = {
    total: allAgents.length,
    active: 0,
    idle: 0,
    starting: 0,
    error: 0,
    crashed: 0,
    stopped: 0,
    totalErrors: 0,
    staleAgents,
  };

  for (const agent of allAgents) {
    switch (agent.status) {
      case 'active':
        report.active++;
        break;
      case 'idle':
        report.idle++;
        break;
      case 'starting':
        report.starting++;
        break;
      case 'error':
        report.error++;
        break;
      case 'crashed':
        report.crashed++;
        break;
      case 'stopped':
        report.stopped++;
        break;
    }
    report.totalErrors += agent.errorCount;
  }

  return report;
}
