/**
 * CLI nexus command group - Cross-project NEXUS operations.
 *
 * Ports the 4 bash NEXUS scripts into a unified `cleo nexus` command:
 *   - nexus.sh         -> discover/query/register/unregister/list/deps/sync/init
 *   - nexus-discover.sh -> discover subcommand
 *   - nexus-query.sh    -> query subcommand
 *   - nexus-search.sh   -> search subcommand
 *
 * @task T4554
 * @epic T4545
 */

import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  nexusInit,
  nexusRegister,
  nexusUnregister,
  nexusList,
  nexusGetProject,
  nexusSync,
  nexusSyncAll,
  readRegistry,
  type NexusPermissionLevel,
} from '../../core/nexus/index.js';
import {
  resolveTask,
  parseQuery,
  validateSyntax,
} from '../../core/nexus/index.js';
import {
  nexusDeps,
} from '../../core/nexus/index.js';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';

/**
 * Register the nexus command group.
 * @task T4554
 */
export function registerNexusCommand(program: Command): void {
  const nexus = program
    .command('nexus')
    .description('Cross-project NEXUS operations');

  // ── nexus init ──────────────────────────────────────────────────────

  nexus
    .command('init')
    .description('Initialize NEXUS directory structure and registry')
    .action(async () => {
      try {
        await nexusInit();
        cliOutput(
          { initialized: true, path: '~/.cleo/nexus/' },
          { command: 'nexus', message: 'Nexus initialized' },
        );
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // ── nexus register ──────────────────────────────────────────────────

  nexus
    .command('register <path>')
    .description('Register a project in the global registry')
    .option('--name <name>', 'Custom project name (default: directory name)')
    .option('--permissions <perms>', 'Permissions: read|write|execute', 'read')
    .action(async (projectPath: string, opts: Record<string, unknown>) => {
      try {
        const permissions = opts['permissions'] as NexusPermissionLevel;
        const name = opts['name'] as string | undefined;
        const hash = await nexusRegister(projectPath, name, permissions);
        const project = await nexusGetProject(hash);
        cliOutput({
          project: {
            hash,
            name: project?.name ?? name ?? projectPath.split('/').pop(),
            path: projectPath,
            permissions,
          },
        }, { command: 'nexus' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // ── nexus unregister ────────────────────────────────────────────────

  nexus
    .command('unregister <nameOrHash>')
    .description('Remove a project from the registry')
    .action(async (nameOrHash: string) => {
      try {
        await nexusUnregister(nameOrHash);
        cliOutput(
          { unregistered: nameOrHash },
          { command: 'nexus', message: 'Project unregistered' },
        );
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // ── nexus list ──────────────────────────────────────────────────────

  nexus
    .command('list')
    .description('List all registered projects')
    .action(async () => {
      try {
        const projects = await nexusList();
        cliOutput({
          projects,
          total: projects.length,
        }, { command: 'nexus' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // ── nexus status ────────────────────────────────────────────────────

  nexus
    .command('status')
    .description('Show NEXUS registry status')
    .action(async () => {
      try {
        const registry = await readRegistry();
        if (!registry) {
          cliOutput(
            { initialized: false, projectCount: 0 },
            { command: 'nexus', message: 'Nexus not initialized' },
          );
          process.exit(ExitCode.NO_DATA);
        }
        const projects = Object.values(registry.projects);
        const healthCounts = { healthy: 0, degraded: 0, unreachable: 0, unknown: 0 };
        for (const p of projects) {
          healthCounts[p.healthStatus]++;
        }
        cliOutput({
          initialized: true,
          schemaVersion: registry.schemaVersion,
          lastUpdated: registry.lastUpdated,
          projectCount: projects.length,
          health: healthCounts,
          totalTasks: projects.reduce((sum, p) => sum + p.taskCount, 0),
        }, { command: 'nexus' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // ── nexus show ─────────────────────────────────────────────────────

  nexus
    .command('show <taskId>')
    .alias('query')
    .description('Show a task across projects (project:T### or T###)')
    .action(async (taskId: string) => {
      try {
        const result = await resolveTask(taskId);
        cliOutput({
          query: taskId,
          task: result,
        }, { command: 'nexus' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // ── nexus discover ──────────────────────────────────────────────────

  nexus
    .command('discover <taskQuery>')
    .description('Find related tasks across projects')
    .option('--method <method>', 'Discovery method: labels|description|files|auto', 'auto')
    .option('--limit <n>', 'Max results', parseInt, 10)
    .action(async (taskQuery: string, opts: Record<string, unknown>) => {
      try {
        const method = opts['method'] as string;
        const limit = opts['limit'] as number;
        const results = await discoverRelatedTasks(taskQuery, method, limit);
        cliOutput({
          query: taskQuery,
          method,
          results,
          total: results.length,
        }, { command: 'nexus' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // ── nexus search ────────────────────────────────────────────────────

  nexus
    .command('search <pattern>')
    .description('Search tasks across projects by pattern')
    .option('--project <name>', 'Limit search to specific project')
    .option('--limit <n>', 'Max results', parseInt, 20)
    .action(async (pattern: string, opts: Record<string, unknown>) => {
      try {
        const projectFilter = opts['project'] as string | undefined;
        const limit = opts['limit'] as number;
        const results = await searchAcrossProjects(pattern, projectFilter, limit);
        cliOutput({
          pattern,
          results,
          resultCount: results.length,
        }, { command: 'nexus' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // ── nexus deps ──────────────────────────────────────────────────────

  nexus
    .command('deps <taskQuery>')
    .description('Show cross-project dependencies')
    .option('--reverse', 'Show reverse dependencies (what depends on this)')
    .action(async (taskQuery: string, opts: Record<string, unknown>) => {
      try {
        const direction = opts['reverse'] ? 'reverse' as const : 'forward' as const;
        const result = await nexusDeps(taskQuery, direction);
        cliOutput({
          query: taskQuery,
          direction,
          dependencies: result,
        }, { command: 'nexus' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // ── nexus sync ──────────────────────────────────────────────────────

  nexus
    .command('sync [project]')
    .description('Sync project metadata (task count, labels)')
    .action(async (project?: string) => {
      try {
        if (project) {
          await nexusSync(project);
          cliOutput(
            { project, synced: true },
            { command: 'nexus', message: `Synced project: ${project}` },
          );
        } else {
          const result = await nexusSyncAll();
          cliOutput(result, { command: 'nexus' });
        }
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}

// ── Discovery engine ──────────────────────────────────────────────────

interface DiscoveryResult {
  project: string;
  taskId: string;
  title: string;
  score: number;
  type: string;
  reason: string;
}

/**
 * Discover related tasks across registered projects.
 * Implements label-based, description-based, and auto discovery methods.
 * @task T4554
 */
async function discoverRelatedTasks(
  taskQuery: string,
  method: string,
  limit: number,
): Promise<DiscoveryResult[]> {
  if (!validateSyntax(taskQuery)) {
    throw new CleoError(
      ExitCode.NEXUS_INVALID_SYNTAX,
      `Invalid query syntax: ${taskQuery}. Expected: T001, project:T001, .:T001, or *:T001`,
    );
  }

  // Resolve the source task to get labels and description
  const sourceTask = await resolveTask(taskQuery);
  if (Array.isArray(sourceTask)) {
    throw new CleoError(
      ExitCode.NEXUS_QUERY_FAILED,
      'Wildcard queries not supported for discovery. Specify a single task.',
    );
  }

  const sourceLabels = new Set(sourceTask.labels ?? []);
  const sourceDesc = (sourceTask.description ?? '').toLowerCase();
  const sourceTitle = (sourceTask.title ?? '').toLowerCase();
  const sourceWords = extractKeywords(sourceTitle + ' ' + sourceDesc);
  const parsed = parseQuery(taskQuery);

  // Read all tasks from all registered projects
  const registry = await readRegistry();
  if (!registry) return [];

  const candidates: DiscoveryResult[] = [];

  for (const project of Object.values(registry.projects)) {
    let tasks: Array<{ id: string; title: string; description?: string; labels?: string[]; status: string }>;
    try {
      const todoPath = join(project.path, '.cleo', 'todo.json');
      const raw = await readFile(todoPath, 'utf-8');
      const data = JSON.parse(raw) as { tasks: typeof tasks };
      tasks = data.tasks ?? [];
    } catch {
      continue;
    }

    for (const task of tasks) {
      // Skip the source task itself
      if (task.id === parsed.taskId && project.name === parsed.project) continue;

      let score = 0;
      let matchType = 'none';
      let reason = '';

      if (method === 'labels' || method === 'auto') {
        const taskLabels = task.labels ?? [];
        const overlap = taskLabels.filter(l => sourceLabels.has(l));
        if (overlap.length > 0) {
          const labelScore = overlap.length / Math.max(sourceLabels.size, taskLabels.length, 1);
          if (method === 'labels' || labelScore > score) {
            score = Math.max(score, labelScore);
            matchType = 'labels';
            reason = `Shared labels: ${overlap.join(', ')}`;
          }
        }
      }

      if (method === 'description' || method === 'auto') {
        const taskDesc = ((task.description ?? '') + ' ' + (task.title ?? '')).toLowerCase();
        const taskWords = extractKeywords(taskDesc);
        const commonWords = sourceWords.filter(w => taskWords.includes(w));
        if (commonWords.length > 0) {
          const descScore = commonWords.length / Math.max(sourceWords.length, taskWords.length, 1);
          if (descScore > score) {
            score = descScore;
            matchType = 'description';
            reason = `Keyword match: ${commonWords.slice(0, 5).join(', ')}`;
          }
        }
      }

      if (score > 0) {
        candidates.push({
          project: project.name,
          taskId: task.id,
          title: task.title,
          score: Math.round(score * 100) / 100,
          type: matchType,
          reason,
        });
      }
    }
  }

  // Sort by score descending, then limit
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
}

/** Extract meaningful keywords from text (stop-word filtered). */
function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'to', 'of',
    'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
    'during', 'before', 'after', 'above', 'below', 'and', 'but', 'or', 'nor',
    'not', 'so', 'yet', 'both', 'either', 'neither', 'each', 'every', 'all',
    'any', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'only',
    'own', 'same', 'than', 'too', 'very', 'just', 'because', 'if', 'when',
    'this', 'that', 'these', 'those', 'it', 'its',
  ]);

  return text
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
}

// ── Search engine ─────────────────────────────────────────────────────

interface SearchResult {
  id: string;
  title: string;
  status: string;
  priority?: string;
  description?: string;
  _project: string;
}

/**
 * Search tasks across registered projects by pattern.
 * Supports wildcard query syntax (*:T001) and regex-based matching.
 * @task T4554
 */
async function searchAcrossProjects(
  pattern: string,
  projectFilter?: string,
  limit = 20,
): Promise<SearchResult[]> {
  // Handle wildcard query syntax (*:T001) - delegate to resolveTask
  if (/^\*:.+$/.test(pattern)) {
    try {
      const result = await resolveTask(pattern);
      const tasks = Array.isArray(result) ? result : [result];
      return tasks.slice(0, limit).map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        description: t.description,
        _project: t._project,
      }));
    } catch {
      // Fall through to pattern search if resolveTask fails
    }
  }

  const registry = await readRegistry();
  if (!registry) return [];

  // Convert shell glob pattern to regex safely
  // First escape all regex special chars, then convert glob wildcards
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const regexPattern = escaped.replace(/\*/g, '.*');
  let regex: RegExp;
  try {
    regex = new RegExp(regexPattern, 'i');
  } catch {
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      `Invalid search pattern: ${pattern}`,
    );
  }

  const results: SearchResult[] = [];
  const projectEntries = projectFilter
    ? Object.values(registry.projects).filter(p => p.name === projectFilter)
    : Object.values(registry.projects);

  if (projectFilter && projectEntries.length === 0) {
    throw new CleoError(
      ExitCode.NEXUS_PROJECT_NOT_FOUND,
      `Project not found in registry: ${projectFilter}`,
    );
  }

  for (const project of projectEntries) {
    let tasks: Array<{ id: string; title: string; description?: string; status: string; priority?: string }>;
    try {
      const todoPath = join(project.path, '.cleo', 'todo.json');
      const raw = await readFile(todoPath, 'utf-8');
      const data = JSON.parse(raw) as { tasks: typeof tasks };
      tasks = data.tasks ?? [];
    } catch {
      continue;
    }

    for (const task of tasks) {
      const matchesId = regex.test(task.id);
      const matchesTitle = regex.test(task.title);
      const matchesDesc = regex.test(task.description ?? '');

      if (matchesId || matchesTitle || matchesDesc) {
        results.push({
          id: task.id,
          title: task.title,
          status: task.status,
          priority: task.priority,
          description: task.description,
          _project: project.name,
        });
      }
    }
  }

  return results.slice(0, limit);
}
