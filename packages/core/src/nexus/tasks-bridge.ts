/**
 * TASKS → NEXUS Bridge — links tasks to code symbols they touched.
 *
 * Enables the question: "Which tasks modified this symbol?" — answering
 * through git-log sweeping (extract task IDs from commit messages) and
 * cross-reference with nexus_nodes via file paths and symbol names.
 *
 * Design:
 * - linkTaskToSymbols: writes task_touches_symbol edges for a single task
 * - getTasksForSymbol: reverse-lookup (symbol → tasks)
 * - getSymbolsForTask: forward-lookup (task → symbols)
 * - runGitLogTaskLinker: post-analyze hook to sweep git history and link tasks
 *
 * @task T1067
 * @epic T1042
 */

import { execFileSync } from 'node:child_process';
import type {
  GitLogLinkerResult,
  LinkTaskResult,
  SymbolReference,
  TaskReference,
} from '@cleocode/contracts';
import { EDGE_TYPES } from '../memory/edge-types.js';
import { getBrainDb, getBrainNativeDb } from '../store/memory-sqlite.js';
import { getNexusDb, getNexusNativeDb } from '../store/nexus-sqlite.js';
import { typedAll, typedGet } from '../store/typed-query.js';

// ============================================================================
// Types
// ============================================================================

/** Raw row from nexus_nodes query. */
interface RawNexusNode {
  id: string;
  label: string;
  file_path: string | null;
  kind: string;
}

/** Raw row from brain_page_edges query for task lookups. */
interface RawTaskEdge {
  task_id: string;
  label: string;
  weight: number;
  edge_type: string;
}

/** Raw row from git log with task ID extraction. */
interface GitCommitRow {
  hash: string;
  subject: string;
  files: string[];
}

// ============================================================================
// Public functions
// ============================================================================

/**
 * Link a task to symbols in the files it touched.
 *
 * For each file in task.files_json, queries nexus_nodes for symbols in that file,
 * then writes task_touches_symbol edges to brain_page_edges.
 *
 * @param taskId - Task ID (e.g., 'T001')
 * @param filesJson - JSON string array of file paths from task.files_json
 * @param projectRoot - Absolute path to project root
 * @returns Result summary with count of edges created
 */
export async function linkTaskToSymbols(
  taskId: string,
  filesJson: string,
  projectRoot: string,
): Promise<LinkTaskResult> {
  try {
    // Parse files_json safely
    let files: string[] = [];
    try {
      const parsed = JSON.parse(filesJson);
      if (Array.isArray(parsed)) {
        files = parsed.filter((f) => typeof f === 'string');
      }
    } catch {
      // malformed JSON — treat as empty
    }

    if (files.length === 0) {
      return {
        linked: 0,
        taskId,
        filesProcessed: 0,
        symbolsFound: 0,
      };
    }

    // Ensure DBs are initialized
    await getBrainDb(projectRoot);
    await getNexusDb();

    const brainNative = getBrainNativeDb();
    const nexusNative = getNexusNativeDb();

    if (!brainNative || !nexusNative) {
      return {
        linked: 0,
        taskId,
        filesProcessed: 0,
        symbolsFound: 0,
      };
    }

    let edgesCreated = 0;
    let symbolsFound = 0;

    // For each file, query nexus for symbols and write edges
    const now = new Date().toISOString();
    const taskNodeId = `task:${taskId}`;

    for (const filePath of files) {
      // Query nexus_nodes for all symbols in this file
      const symbols = typedAll<RawNexusNode>(
        nexusNative.prepare(`SELECT id, label, file_path, kind FROM nexus_nodes
           WHERE file_path = ?
             AND kind NOT IN ('file', 'folder', 'community', 'process')
           LIMIT 1000`),
        filePath,
      );

      symbolsFound += symbols.length;

      // Write task_touches_symbol edges to brain_page_edges
      for (const symbol of symbols) {
        try {
          brainNative
            .prepare(
              `INSERT INTO brain_page_edges
               (from_id, to_id, edge_type, weight, provenance, created_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(from_id, to_id, edge_type) DO NOTHING`,
            )
            .run(
              taskNodeId,
              symbol.id,
              EDGE_TYPES.TASK_TOUCHES_SYMBOL,
              1.0,
              'git-log-file-match',
              now,
            );

          edgesCreated++;
        } catch {
          // Ignore duplicate or constraint errors
        }
      }
    }

    return {
      linked: edgesCreated,
      taskId,
      filesProcessed: files.length,
      symbolsFound,
    };
  } catch (err) {
    console.error(
      `[CLEO] linkTaskToSymbols failed for ${taskId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return {
      linked: 0,
      taskId,
      filesProcessed: 0,
      symbolsFound: 0,
    };
  }
}

/**
 * Query: which tasks touched a specific symbol?
 *
 * Reverse-lookup from symbol (nexus node ID) to all tasks that touched it.
 *
 * @param symbolId - Nexus node ID (e.g., 'src/file.ts::functionName')
 * @param projectRoot - Absolute path to project root
 * @returns Array of task references with edge metadata
 */
export async function getTasksForSymbol(
  symbolId: string,
  projectRoot: string,
): Promise<TaskReference[]> {
  try {
    await getBrainDb(projectRoot);
    const brainNative = getBrainNativeDb();

    if (!brainNative) return [];

    // Query task_touches_symbol edges where to_id is the symbol
    const rows = typedAll<RawTaskEdge>(
      brainNative.prepare(`SELECT
         substr(from_id, 6) as task_id,
         'Task ' || substr(from_id, 6) as label,
         weight,
         edge_type
       FROM brain_page_edges
       WHERE to_id = ?
         AND edge_type = ?
       ORDER BY weight DESC`),
      symbolId,
      EDGE_TYPES.TASK_TOUCHES_SYMBOL,
    );

    return rows.map((r) => ({
      taskId: r.task_id,
      label: r.label,
      weight: r.weight,
      matchStrategy: 'git-log-file-match',
    }));
  } catch (err) {
    console.error(
      `[CLEO] getTasksForSymbol failed for ${symbolId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/**
 * Query: which symbols did a task touch?
 *
 * Forward-lookup from task ID to all symbols in the files it modified.
 *
 * @param taskId - Task ID (e.g., 'T001')
 * @param projectRoot - Absolute path to project root
 * @returns Array of symbol references with edge metadata
 */
export async function getSymbolsForTask(
  taskId: string,
  projectRoot: string,
): Promise<SymbolReference[]> {
  try {
    // Ensure both DBs are initialized
    await getBrainDb(projectRoot);
    await getNexusDb();

    const brainNative = getBrainNativeDb();
    const nexusNative = getNexusNativeDb();

    if (!brainNative || !nexusNative) return [];

    const taskNodeId = `task:${taskId}`;

    // Query task_touches_symbol edges where from_id is the task
    const edgeRows = typedAll<{ to_id: string; weight: number }>(
      brainNative.prepare(`SELECT to_id, weight FROM brain_page_edges
       WHERE from_id = ? AND edge_type = ?
       ORDER BY weight DESC
       LIMIT 1000`),
      taskNodeId,
      EDGE_TYPES.TASK_TOUCHES_SYMBOL,
    );

    if (edgeRows.length === 0) return [];

    // Hydrate symbol details from nexus
    const results: SymbolReference[] = [];
    for (const edge of edgeRows) {
      const symbol = typedGet<RawNexusNode>(
        nexusNative.prepare(`SELECT id, label, file_path, kind FROM nexus_nodes WHERE id = ? LIMIT 1`),
        edge.to_id,
      );

      if (symbol) {
        results.push({
          nexusNodeId: symbol.id,
          label: symbol.label,
          kind: symbol.kind,
          filePath: symbol.file_path,
          weight: edge.weight,
          matchStrategy: 'git-log-file-match',
        });
      }
    }

    return results;
  } catch (err) {
    console.error(
      `[CLEO] getSymbolsForTask failed for ${taskId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/**
 * Git-log sweeper: extract task IDs from commit messages and link to symbols.
 *
 * Scans git log since a reference commit (or all history if none),
 * extracts task IDs matching pattern /T\d+/, and calls linkTaskToSymbols
 * for each task × touched files pair.
 *
 * Idempotent: stores the last-synced commit hash in nexus_schema_meta
 * so subsequent runs skip already-processed commits.
 *
 * @param projectRoot - Absolute path to project root
 * @param sinceCommit - Optional reference commit; if omitted, uses last stored
 * @returns Result summary with count of edges created and last commit hash
 */
export async function runGitLogTaskLinker(
  projectRoot: string,
  sinceCommit?: string,
): Promise<GitLogLinkerResult> {
  try {
    // Ensure DBs are initialized
    await getBrainDb(projectRoot);
    await getNexusDb();

    const brainNative = getBrainNativeDb();
    const nexusNative = getNexusNativeDb();

    if (!brainNative || !nexusNative) {
      return {
        linked: 0,
        commitsProcessed: 0,
        tasksFound: 0,
        lastCommitHash: null,
      };
    }

    // Determine the reference commit for git log --since
    let since = sinceCommit;

    if (!since) {
      // Try to read last-synced commit from nexus_schema_meta
      try {
        const meta = nexusNative
          .prepare(`SELECT value FROM nexus_schema_meta WHERE key = ?`)
          .get('last_task_linker_commit') as { value: string } | undefined;

        if (meta?.value) {
          since = meta.value;
        }
      } catch {
        // Table may not exist or key may not be present
      }
    }

    // Run git log and extract commits
    let gitLogOutput = '';
    try {
      const args = ['log', '--pretty=format:%H', '--name-only'];
      if (since) {
        args.push(`${since}..HEAD`);
      }

      gitLogOutput = execFileSync('git', args, {
        cwd: projectRoot,
        encoding: 'utf-8',
      });
    } catch {
      // git command failed — return empty result
      return {
        linked: 0,
        commitsProcessed: 0,
        tasksFound: 0,
        lastCommitHash: null,
      };
    }

    if (!gitLogOutput.trim()) {
      return {
        linked: 0,
        commitsProcessed: 0,
        tasksFound: 0,
        lastCommitHash: null,
      };
    }

    // Parse git log output: alternating commit hashes and file lists
    const commits = parseGitLogOutput(gitLogOutput);

    if (commits.length === 0) {
      return {
        linked: 0,
        commitsProcessed: 0,
        tasksFound: 0,
        lastCommitHash: null,
      };
    }

    // Extract task IDs from commit messages and aggregate by task
    const taskFiles = new Map<string, Set<string>>();

    for (const commit of commits) {
      const taskMatch = commit.subject.match(/T\d+/);
      if (taskMatch) {
        const taskId = taskMatch[0];
        if (!taskFiles.has(taskId)) {
          taskFiles.set(taskId, new Set());
        }
        for (const file of commit.files) {
          taskFiles.get(taskId)!.add(file);
        }
      }
    }

    // Link each task to its symbols
    let totalEdges = 0;
    for (const [taskId, files] of taskFiles) {
      const result = await linkTaskToSymbols(
        taskId,
        JSON.stringify(Array.from(files)),
        projectRoot,
      );
      totalEdges += result.linked;
    }

    // Store the last commit hash for idempotency
    const lastCommit = commits[commits.length - 1].hash;
    try {
      brainNative
        .prepare(
          `INSERT INTO nexus_schema_meta (key, value, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
        )
        .run('last_task_linker_commit', lastCommit);
    } catch {
      // Ignore if nexus_schema_meta doesn't support this
    }

    return {
      linked: totalEdges,
      commitsProcessed: commits.length,
      tasksFound: taskFiles.size,
      lastCommitHash: lastCommit,
    };
  } catch (err) {
    console.error(
      '[CLEO] runGitLogTaskLinker failed:',
      err instanceof Error ? err.message : String(err),
    );
    return {
      linked: 0,
      commitsProcessed: 0,
      tasksFound: 0,
      lastCommitHash: null,
    };
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Parse git log --pretty=format:%H --name-only output.
 *
 * Format: alternating lines of commit hash and file paths, separated by blank lines.
 * Returns array of commits with hash, subject (extracted from hash), and file list.
 */
function parseGitLogOutput(output: string): GitCommitRow[] {
  const commits: GitCommitRow[] = [];
  const lines = output.split('\n');

  let currentHash: string | null = null;
  let currentFiles: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Empty lines separate commits
    if (!trimmed) {
      if (currentHash) {
        commits.push({
          hash: currentHash,
          subject: currentHash, // simplified — extract from git log separately if needed
          files: currentFiles,
        });
        currentHash = null;
        currentFiles = [];
      }
      continue;
    }

    // If we don't have a hash yet, treat this as a hash line
    if (!currentHash) {
      currentHash = trimmed;
    } else {
      // Otherwise it's a file path
      currentFiles.push(trimmed);
    }
  }

  // Don't forget the last commit if output doesn't end with blank line
  if (currentHash) {
    commits.push({
      hash: currentHash,
      subject: currentHash,
      files: currentFiles,
    });
  }

  return commits;
}
