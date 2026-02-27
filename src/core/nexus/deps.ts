/**
 * NEXUS dependency analysis - global dependency graph across projects.
 *
 * Builds a unified graph of all tasks and cross-project edges,
 * supporting forward/reverse dependency lookups, critical path analysis,
 * blocking impact analysis, and orphan detection.
 *
 * @task T4574
 * @epic T4540
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { Task } from '../../types/task.js';
import { readRegistryRequired, type NexusRegistryFile } from './registry.js';
import { parseQuery, validateSyntax, resolveTask } from './query.js';
import { checkPermission } from './permissions.js';

// ── Schemas ──────────────────────────────────────────────────────────

export const NexusGraphNodeSchema = z.object({
  id: z.string(),
  project: z.string(),
  status: z.string(),
  title: z.string(),
});
export type NexusGraphNode = z.infer<typeof NexusGraphNodeSchema>;

export const NexusGraphEdgeSchema = z.object({
  from: z.string(),
  fromProject: z.string(),
  to: z.string(),
  toProject: z.string(),
});
export type NexusGraphEdge = z.infer<typeof NexusGraphEdgeSchema>;

export const NexusGlobalGraphSchema = z.object({
  nodes: z.array(NexusGraphNodeSchema),
  edges: z.array(NexusGraphEdgeSchema),
});
export type NexusGlobalGraph = z.infer<typeof NexusGlobalGraphSchema>;

/** Result of a dependency query. */
export interface DepsResult {
  task: string;
  project: string;
  depends: DepsEntry[];
  blocking: DepsEntry[];
}

/** Single dependency entry with resolution status. */
export interface DepsEntry {
  query: string;
  project: string;
  status: string;
  title?: string;
}

/** Critical path result. */
export interface CriticalPathResult {
  criticalPath: Array<{ query: string; title: string }>;
  length: number;
  blockedBy: string;
}

/** Blocking analysis result. */
export interface BlockingAnalysisResult {
  task: string;
  blocking: Array<{ query: string; project: string }>;
  impactScore: number;
}

/** Orphan detection result. */
export interface OrphanEntry {
  sourceProject: string;
  sourceTask: string;
  targetProject: string;
  targetTask: string;
  reason: 'project_not_registered' | 'task_not_found';
}

// ── Graph cache ──────────────────────────────────────────────────────

let cachedGraph: NexusGlobalGraph | null = null;
let cachedChecksum: string | null = null;

/** Invalidate the in-memory graph cache. */
export function invalidateGraphCache(): void {
  cachedGraph = null;
  cachedChecksum = null;
}

// ── Graph building ───────────────────────────────────────────────────

/** Cross-project reference pattern: `project-name:T001`. */
const CROSS_REF_RE = /^([a-z0-9_-]+):(.+)$/;

/** Read tasks from a project path, returning empty array on failure. */
async function readProjectTasks(projectPath: string): Promise<Task[]> {
  try {
    let raw: string;
    try {
      raw = await readFile(join(projectPath, '.cleo', 'tasks.json'), 'utf-8');
    } catch {
      raw = await readFile(join(projectPath, '.cleo', 'todo.json'), 'utf-8');
    }
    const data = JSON.parse(raw) as { tasks: Task[] };
    return data.tasks ?? [];
  } catch {
    return [];
  }
}

/** Compute a checksum across all registered project task files. */
async function computeGlobalChecksum(registry: NexusRegistryFile): Promise<string> {
  const hash = createHash('sha256');

  for (const project of Object.values(registry.projects)) {
    try {
      let content: string;
      try {
        content = await readFile(join(project.path, '.cleo', 'tasks.json'), 'utf-8');
      } catch {
        content = await readFile(join(project.path, '.cleo', 'todo.json'), 'utf-8');
      }
      hash.update(content);
    } catch {
      // Skip unreadable projects
    }
  }

  return hash.digest('hex').substring(0, 16);
}

/**
 * Build the global dependency graph from all registered projects.
 * Uses checksum-based caching to avoid unnecessary rebuilds.
 */
export async function buildGlobalGraph(): Promise<NexusGlobalGraph> {
  const registry = await readRegistryRequired();
  const checksum = await computeGlobalChecksum(registry);

  // Return cached if valid
  if (cachedGraph && cachedChecksum === checksum) {
    return cachedGraph;
  }

  const nodes: NexusGraphNode[] = [];
  const edges: NexusGraphEdge[] = [];

  for (const project of Object.values(registry.projects)) {
    // Check read permission
    if (!(await checkPermission(project.name, 'read'))) {
      continue;
    }

    const tasks = await readProjectTasks(project.path);

    // Add nodes
    for (const task of tasks) {
      nodes.push({
        id: task.id,
        project: project.name,
        status: task.status,
        title: task.title,
      });
    }

    // Add edges from dependencies
    for (const task of tasks) {
      if (!task.depends || task.depends.length === 0) continue;

      for (const dep of task.depends) {
        const match = CROSS_REF_RE.exec(dep);
        if (match) {
          // Cross-project dependency
          edges.push({
            from: task.id,
            fromProject: project.name,
            to: match[2],
            toProject: match[1],
          });
        } else {
          // Same-project dependency
          edges.push({
            from: task.id,
            fromProject: project.name,
            to: dep,
            toProject: project.name,
          });
        }
      }
    }
  }

  const graph: NexusGlobalGraph = { nodes, edges };
  cachedGraph = graph;
  cachedChecksum = checksum;
  return graph;
}

// ── Dependency queries ───────────────────────────────────────────────

/**
 * Show dependencies for a task across projects.
 * Supports forward (what this depends on) and reverse (what depends on this) lookups.
 */
export async function nexusDeps(
  taskQuery: string,
  direction: 'forward' | 'reverse' = 'forward',
): Promise<DepsResult> {
  if (!validateSyntax(taskQuery)) {
    throw new CleoError(
      ExitCode.NEXUS_INVALID_SYNTAX,
      `Invalid query syntax: ${taskQuery}`,
    );
  }

  const parsed = parseQuery(taskQuery);

  // Check read permission
  if (!(await checkPermission(parsed.project, 'read'))) {
    throw new CleoError(
      ExitCode.NEXUS_PERMISSION_DENIED,
      `Read permission required for project '${parsed.project}'`,
    );
  }

  // Resolve the task
  const task = await resolveTask(taskQuery);
  if (Array.isArray(task)) {
    throw new CleoError(
      ExitCode.NEXUS_QUERY_FAILED,
      'Wildcard queries not supported for dependency analysis',
    );
  }

  const graph = await buildGlobalGraph();
  const result: DepsResult = {
    task: taskQuery,
    project: parsed.project,
    depends: [],
    blocking: [],
  };

  if (direction === 'reverse') {
    // Find what depends on this task
    const dependents = graph.edges.filter(
      e => e.to === parsed.taskId && e.toProject === parsed.project,
    );

    for (const edge of dependents) {
      const entry: DepsEntry = {
        query: `${edge.fromProject}:${edge.from}`,
        project: edge.fromProject,
        status: 'unknown',
      };

      try {
        const depTask = await resolveTask(entry.query);
        if (!Array.isArray(depTask)) {
          entry.status = depTask.status;
          entry.title = depTask.title;
        }
      } catch {
        entry.status = 'not_found';
      }

      result.blocking.push(entry);
    }
  } else {
    // Forward: what this task depends on
    const deps = task.depends ?? [];

    for (const dep of deps) {
      const match = CROSS_REF_RE.exec(dep);
      const depProject = match ? match[1] : parsed.project;
      const depTaskId = match ? match[2] : dep;
      const depQuery = `${depProject}:${depTaskId}`;

      const entry: DepsEntry = {
        query: depQuery,
        project: depProject,
        status: 'unknown',
      };

      // Check permission before resolving
      if (!(await checkPermission(depProject, 'read'))) {
        entry.status = 'permission_denied';
        result.depends.push(entry);
        continue;
      }

      try {
        const depTask = await resolveTask(depQuery);
        if (!Array.isArray(depTask)) {
          entry.status = depTask.status;
          entry.title = depTask.title;
        }
      } catch {
        entry.status = 'not_found';
      }

      result.depends.push(entry);
    }
  }

  return result;
}

/**
 * Resolve an array of dependencies (local or cross-project).
 */
export async function resolveCrossDeps(
  depsArray: string[],
  sourceProject: string,
): Promise<DepsEntry[]> {
  const resolved: DepsEntry[] = [];

  for (const dep of depsArray) {
    const match = CROSS_REF_RE.exec(dep);
    const depProject = match ? match[1] : sourceProject;
    const depTaskId = match ? match[2] : dep;
    const depQuery = `${depProject}:${depTaskId}`;

    const entry: DepsEntry = {
      query: depQuery,
      project: depProject,
      status: 'unknown',
    };

    if (!(await checkPermission(depProject, 'read'))) {
      entry.status = 'permission_denied';
      resolved.push(entry);
      continue;
    }

    try {
      const resolvedTask = await resolveTask(depQuery);
      if (!Array.isArray(resolvedTask)) {
        entry.status = resolvedTask.status;
        entry.title = resolvedTask.title;
      }
    } catch {
      entry.status = 'not_found';
    }

    resolved.push(entry);
  }

  return resolved;
}

/**
 * Calculate the critical path across project boundaries.
 * Returns the longest dependency chain in the global graph.
 */
export async function criticalPath(): Promise<CriticalPathResult> {
  const graph = await buildGlobalGraph();

  // Find all leaf nodes (no outgoing dependency edges)
  const nodesWithOutgoing = new Set(graph.edges.map(e => `${e.fromProject}:${e.from}`));
  const allNodeKeys = graph.nodes.map(n => `${n.project}:${n.id}`);
  const leaves = allNodeKeys.filter(k => !nodesWithOutgoing.has(k));

  let longestPath: Array<{ query: string; title: string }> = [];
  let maxLength = 0;

  for (const leafKey of leaves) {
    const colonIdx = leafKey.indexOf(':');
    const project = leafKey.substring(0, colonIdx);
    const id = leafKey.substring(colonIdx + 1);
    const path = traceBack(graph, id, project, new Set());

    if (path.length > maxLength) {
      maxLength = path.length;
      longestPath = path.reverse().map(n => ({
        query: `${n.project}:${n.id}`,
        title: n.title,
      }));
    }
  }

  // Find first blocker (pending/blocked task in path)
  let blockedBy = '';
  for (const item of longestPath) {
    try {
      const resolvedTask = await resolveTask(item.query);
      if (!Array.isArray(resolvedTask) && (resolvedTask.status === 'pending' || resolvedTask.status === 'blocked')) {
        blockedBy = item.query;
        break;
      }
    } catch {
      // Skip unresolvable tasks
    }
  }

  return { criticalPath: longestPath, length: maxLength, blockedBy };
}

/** Trace back from a node following dependency edges (DFS). */
function traceBack(
  graph: NexusGlobalGraph,
  taskId: string,
  project: string,
  visited: Set<string>,
): NexusGraphNode[] {
  const key = `${project}:${taskId}`;
  if (visited.has(key)) return [];
  visited.add(key);

  const node = graph.nodes.find(n => n.id === taskId && n.project === project);
  if (!node) return [];

  // Find dependencies (edges where this task is the source)
  const deps = graph.edges.filter(e => e.from === taskId && e.fromProject === project);

  let longestSubpath: NexusGraphNode[] = [];
  for (const dep of deps) {
    const subpath = traceBack(graph, dep.to, dep.toProject, visited);
    if (subpath.length > longestSubpath.length) {
      longestSubpath = subpath;
    }
  }

  return [node, ...longestSubpath];
}

/**
 * Analyze the blocking impact of a task across all projects.
 * Uses BFS to find all direct and transitive dependents.
 */
export async function blockingAnalysis(taskQuery: string): Promise<BlockingAnalysisResult> {
  if (!validateSyntax(taskQuery)) {
    throw new CleoError(
      ExitCode.NEXUS_INVALID_SYNTAX,
      `Invalid query syntax: ${taskQuery}`,
    );
  }

  const parsed = parseQuery(taskQuery);
  const graph = await buildGlobalGraph();

  // BFS to find all dependents
  const allDependents: Array<{ query: string; project: string }> = [];
  const visited = new Set<string>([`${parsed.project}:${parsed.taskId}`]);
  const queue: Array<{ id: string; project: string }> = [
    { id: parsed.taskId, project: parsed.project },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;

    // Find edges where current task is a dependency target (others depend on it)
    const dependents = graph.edges.filter(
      e => e.to === current.id && e.toProject === current.project,
    );

    for (const dep of dependents) {
      const key = `${dep.fromProject}:${dep.from}`;
      if (visited.has(key)) continue;
      visited.add(key);

      const depEntry = { query: key, project: dep.fromProject };
      allDependents.push(depEntry);
      queue.push({ id: dep.from, project: dep.fromProject });
    }
  }

  return {
    task: taskQuery,
    blocking: allDependents,
    impactScore: allDependents.length,
  };
}

/**
 * Detect orphaned cross-project dependencies.
 * Finds tasks with dependency references to projects or tasks that don't exist.
 */
export async function orphanDetection(): Promise<OrphanEntry[]> {
  const registry = await readRegistryRequired();
  const orphans: OrphanEntry[] = [];

  for (const project of Object.values(registry.projects)) {
    const tasks = await readProjectTasks(project.path);

    for (const task of tasks) {
      if (!task.depends || task.depends.length === 0) continue;

      for (const dep of task.depends) {
        const match = CROSS_REF_RE.exec(dep);
        if (!match) continue; // Only check cross-project refs

        const targetProject = match[1];
        const targetTask = match[2];

        // Check if target project exists
        const targetEntry = Object.values(registry.projects).find(p => p.name === targetProject);
        if (!targetEntry) {
          orphans.push({
            sourceProject: project.name,
            sourceTask: task.id,
            targetProject,
            targetTask,
            reason: 'project_not_registered',
          });
          continue;
        }

        // Check if target task exists
        const targetTasks = await readProjectTasks(targetEntry.path);
        if (!targetTasks.find(t => t.id === targetTask)) {
          orphans.push({
            sourceProject: project.name,
            sourceTask: task.id,
            targetProject,
            targetTask,
            reason: 'task_not_found',
          });
        }
      }
    }
  }

  return orphans;
}
