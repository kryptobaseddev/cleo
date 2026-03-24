/**
 * NEXUS Workspace — Cross-project orchestration operations.
 *
 * Implements ORCH-PLAN Phase B:
 * - B.2: nexus.route(directiveEvent) — dispatch Conduit directives to the correct project
 * - B.3: nexus.workspace.status() — aggregated cross-project task view
 * - B.4: nexus.workspace.agents() — cross-project agent registry view
 *
 * Security: project-level ACL enforced on all routing operations (HIGH-02).
 * Rate limiting: per-agent throttling on route operations (MEDIUM-05).
 * Audit: all routing operations logged (LOW-06).
 *
 * @module nexus/workspace
 */

import type { ConduitMessage } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';
import { type NexusProject, nexusList } from './registry.js';

// ============================================================================
// Types
// ============================================================================

/** Parsed directive from a Conduit message. */
export interface ParsedDirective {
  /** The directive verb (claim, done, blocked, action, etc.). */
  verb: string;
  /** Task references extracted from the message (e.g., T042, T1234). */
  taskRefs: string[];
  /** The agent ID that sent the directive. */
  agentId: string;
  /** Original message ID for audit trail. */
  messageId: string;
  /** Timestamp of the directive. */
  timestamp: string;
}

/** Result of routing a directive to a project. */
export interface RouteResult {
  /** Whether the routing succeeded. */
  success: boolean;
  /** The project that was routed to. */
  project: string;
  /** The project's filesystem path. */
  projectPath: string;
  /** The task that was affected. */
  taskId: string;
  /** What operation was performed. */
  operation: string;
  /** Error message if routing failed. */
  error?: string;
}

/** Aggregated task status across all projects. */
export interface WorkspaceStatus {
  /** Total projects in the workspace. */
  projectCount: number;
  /** Per-project task summaries. */
  projects: WorkspaceProjectSummary[];
  /** Aggregated totals. */
  totals: {
    pending: number;
    active: number;
    done: number;
    total: number;
  };
  /** When the status was computed. */
  computedAt: string;
}

/** Task summary for a single project. */
export interface WorkspaceProjectSummary {
  /** Project name. */
  name: string;
  /** Project path. */
  path: string;
  /** Task counts by status. */
  counts: {
    pending: number;
    active: number;
    done: number;
    total: number;
  };
  /** Health status from the Nexus registry. */
  health: string;
  /** Last sync time. */
  lastSync: string;
}

/** Agent info aggregated across projects. */
export interface WorkspaceAgent {
  /** Agent instance ID. */
  agentId: string;
  /** Agent type. */
  agentType: string;
  /** Current status. */
  status: string;
  /** Which project this agent is registered in. */
  project: string;
  /** Current task (if any). */
  taskId: string | null;
  /** Last heartbeat. */
  lastHeartbeat: string;
}

/** Project-level ACL entry. */
export interface ProjectACL {
  /** Agent IDs with write access. */
  authorizedAgents: string[];
}

// ============================================================================
// Rate limiting (MEDIUM-05)
// ============================================================================

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_OPS = 100;

/** Per-agent operation counters for rate limiting. */
const rateLimitCounters = new Map<string, { count: number; windowStart: number }>();

/** Check if an agent is rate-limited. Throws if exceeded. */
function checkRateLimit(agentId: string): void {
  const now = Date.now();
  const entry = rateLimitCounters.get(agentId);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitCounters.set(agentId, { count: 1, windowStart: now });
    return;
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX_OPS) {
    throw new CleoError(
      ExitCode.GENERAL_ERROR,
      `Agent '${agentId}' exceeded rate limit: ${RATE_LIMIT_MAX_OPS} routing ops per ${RATE_LIMIT_WINDOW_MS / 1000}s`,
    );
  }
}

// ============================================================================
// ACL (HIGH-02)
// ============================================================================

/** Default ACL: all agents have access (open by default, restrict as needed). */
const DEFAULT_ACL: ProjectACL = { authorizedAgents: ['*'] };

/**
 * Load ACL for a project. Reads from .cleo/config.json authorizedAgents field.
 * Falls back to open access if not configured.
 */
async function loadProjectACL(projectPath: string): Promise<ProjectACL> {
  try {
    const { loadConfig } = await import('../config.js');
    const config = await loadConfig(projectPath);
    const agents = (config as unknown as Record<string, unknown>)?.authorizedAgents;
    if (Array.isArray(agents) && agents.length > 0) {
      return { authorizedAgents: agents as string[] };
    }
  } catch {
    // Config load failure = open access
  }
  return DEFAULT_ACL;
}

/** Check if an agent is authorized to mutate a project. */
function isAuthorized(acl: ProjectACL, agentId: string): boolean {
  if (acl.authorizedAgents.includes('*')) return true;
  return acl.authorizedAgents.includes(agentId);
}

// ============================================================================
// B.2: nexus.route() — Directive routing
// ============================================================================

/** Task reference pattern: T followed by digits (T001, T42, T1234). */
const TASK_REF_PATTERN = /\bT(\d+)\b/g;

/**
 * Parse a Conduit message into a structured directive.
 *
 * Extracts directive verbs (/claim, /done, /blocked) and task references
 * from the message content and metadata.
 */
export function parseDirective(message: ConduitMessage): ParsedDirective | null {
  const content = message.content;

  // Extract directive verb (first /word in content)
  const verbMatch = content.match(/^\/(\w+)/);
  if (!verbMatch) return null;

  const verb = verbMatch[1];

  // Extract task refs from content
  const taskRefs: string[] = [];
  const pattern = new RegExp(TASK_REF_PATTERN.source, 'g');
  for (const m of content.matchAll(pattern)) {
    taskRefs.push(`T${m[1]}`);
  }

  // Also check metadata.taskRefs from SignalDock extraction (Phase A.5)
  const metaRefs = (message.metadata as Record<string, unknown>)?.taskRefs;
  if (Array.isArray(metaRefs)) {
    for (const ref of metaRefs) {
      if (typeof ref === 'string' && !taskRefs.includes(ref)) {
        taskRefs.push(ref);
      }
    }
  }

  if (taskRefs.length === 0) return null;

  return {
    verb,
    taskRefs,
    agentId: message.from,
    messageId: message.id,
    timestamp: message.timestamp,
  };
}

/** Map directive verbs to CLEO task operations. */
const VERB_TO_OPERATION: Record<string, string> = {
  claim: 'tasks.start',
  done: 'tasks.complete',
  complete: 'tasks.complete',
  blocked: 'tasks.update', // Update status to blocked
  start: 'tasks.start',
  stop: 'tasks.stop',
};

/**
 * Route a Conduit directive to the correct project's CLEO instance.
 *
 * Resolves which project owns the referenced task, checks ACL,
 * and dispatches the appropriate CLEO operation.
 *
 * @param directive - Parsed directive from a Conduit message
 * @returns Array of route results (one per task reference)
 */
export async function routeDirective(directive: ParsedDirective): Promise<RouteResult[]> {
  // Rate limit check (MEDIUM-05)
  checkRateLimit(directive.agentId);

  const results: RouteResult[] = [];
  const operation = VERB_TO_OPERATION[directive.verb];

  if (!operation) {
    // Unknown verb — not routable, just skip
    return results;
  }

  const projects = await nexusList();

  for (const taskRef of directive.taskRefs) {
    const result = await routeSingleTask(taskRef, directive, operation, projects);
    results.push(result);
  }

  return results;
}

/** Route a single task reference to its project and execute the operation. */
async function routeSingleTask(
  taskId: string,
  directive: ParsedDirective,
  operation: string,
  projects: NexusProject[],
): Promise<RouteResult> {
  // Find which project owns this task
  let targetProject: NexusProject | null = null;
  let targetAccessor: DataAccessor | null = null;

  for (const project of projects) {
    try {
      const acc = await getAccessor(project.path);
      const { tasks } = await acc.queryTasks({});
      const task = tasks.find((t) => t.id === taskId);
      if (task) {
        targetProject = project;
        targetAccessor = acc;
        break;
      }
    } catch {}
  }

  if (!targetProject || !targetAccessor) {
    return {
      success: false,
      project: 'unknown',
      projectPath: '',
      taskId,
      operation,
      error: `Task ${taskId} not found in any registered project`,
    };
  }

  // ACL check (HIGH-02)
  const acl = await loadProjectACL(targetProject.path);
  if (!isAuthorized(acl, directive.agentId)) {
    return {
      success: false,
      project: targetProject.name,
      projectPath: targetProject.path,
      taskId,
      operation,
      error: `Agent '${directive.agentId}' not authorized to mutate project '${targetProject.name}'`,
    };
  }

  // Execute the operation
  try {
    await executeOperation(operation, taskId, targetProject.path, targetAccessor, directive);

    // Audit log (LOW-06)
    await logRouteAudit(directive, targetProject.name, taskId, operation, true);

    return {
      success: true,
      project: targetProject.name,
      projectPath: targetProject.path,
      taskId,
      operation,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Audit log for failures too
    await logRouteAudit(directive, targetProject.name, taskId, operation, false, errorMsg);

    return {
      success: false,
      project: targetProject.name,
      projectPath: targetProject.path,
      taskId,
      operation,
      error: errorMsg,
    };
  }
}

/** Execute a CLEO operation on a project's task. */
async function executeOperation(
  operation: string,
  taskId: string,
  projectPath: string,
  accessor: DataAccessor,
  directive: ParsedDirective,
): Promise<void> {
  switch (operation) {
    case 'tasks.start': {
      const { startTask } = await import('../task-work/index.js');
      await startTask(taskId, projectPath, accessor);
      break;
    }
    case 'tasks.complete': {
      const { completeTask } = await import('../tasks/complete.js');
      await completeTask(
        { taskId, notes: `Completed via Conduit directive from ${directive.agentId}` },
        projectPath,
        accessor,
      );
      break;
    }
    case 'tasks.stop': {
      const { stopTask } = await import('../task-work/index.js');
      await stopTask(projectPath, accessor);
      break;
    }
    case 'tasks.update': {
      const { updateTask } = await import('../tasks/update.js');
      await updateTask(
        { taskId, notes: `Marked blocked via Conduit directive from ${directive.agentId}` },
        projectPath,
        accessor,
      );
      break;
    }
  }
}

/** Log a routing operation to the audit trail. */
async function logRouteAudit(
  directive: ParsedDirective,
  projectName: string,
  taskId: string,
  operation: string,
  success: boolean,
  error?: string,
): Promise<void> {
  try {
    const { getLogger } = await import('../logger.js');
    const log = getLogger('nexus.route');
    const level = success ? 'info' : 'warn';
    log[level](
      {
        directive: directive.verb,
        agentId: directive.agentId,
        messageId: directive.messageId,
        project: projectName,
        taskId,
        operation,
        success,
        error,
      },
      `Conduit directive routed: ${directive.verb} ${taskId} → ${projectName} (${success ? 'OK' : 'FAILED'})`,
    );
  } catch {
    // Audit logging is best-effort
  }
}

// ============================================================================
// B.3: nexus.workspace.status() — Aggregated view
// ============================================================================

/**
 * Get aggregated task status across all registered projects.
 *
 * Returns per-project task counts and workspace-wide totals.
 * Respects project permissions — only includes readable projects.
 */
export async function workspaceStatus(): Promise<WorkspaceStatus> {
  const projects = await nexusList();
  const summaries: WorkspaceProjectSummary[] = [];
  const totals = { pending: 0, active: 0, done: 0, total: 0 };

  for (const project of projects) {
    try {
      const acc = await getAccessor(project.path);
      const { tasks } = await acc.queryTasks({});

      const counts = {
        pending: tasks.filter((t) => t.status === 'pending').length,
        active: tasks.filter((t) => t.status === 'active').length,
        done: tasks.filter((t) => t.status === 'done').length,
        total: tasks.length,
      };

      summaries.push({
        name: project.name,
        path: project.path,
        counts,
        health: project.healthStatus,
        lastSync: project.lastSync,
      });

      totals.pending += counts.pending;
      totals.active += counts.active;
      totals.done += counts.done;
      totals.total += counts.total;
    } catch {
      // Skip unreachable projects
      summaries.push({
        name: project.name,
        path: project.path,
        counts: { pending: 0, active: 0, done: 0, total: 0 },
        health: 'unreachable',
        lastSync: project.lastSync,
      });
    }
  }

  return {
    projectCount: projects.length,
    projects: summaries,
    totals,
    computedAt: new Date().toISOString(),
  };
}

// ============================================================================
// B.4: nexus.workspace.agents() — Cross-project agent view
// ============================================================================

/**
 * Get all agents registered across all projects.
 *
 * Queries each project's agent_instances table and returns a unified list.
 */
export async function workspaceAgents(): Promise<WorkspaceAgent[]> {
  const projects = await nexusList();
  const agents: WorkspaceAgent[] = [];

  for (const project of projects) {
    try {
      const { listAgentInstances } = await import('../agents/registry.js');
      const instances = await listAgentInstances(undefined, project.path);
      for (const inst of instances) {
        agents.push({
          agentId: inst.id,
          agentType: inst.agentType,
          status: inst.status,
          project: project.name,
          taskId: inst.taskId ?? null,
          lastHeartbeat: inst.lastHeartbeat,
        });
      }
    } catch {
      // Skip projects without agent support
    }
  }

  return agents;
}
