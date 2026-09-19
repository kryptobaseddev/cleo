/**
 * TASKS → NEXUS Bridge — associates tasks with symbols in evidenced files.
 *
 * Provides file-level associations, never proof that every symbol changed,
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
  TaskKnowledgeEvidence,
  TaskReference,
} from '@cleocode/contracts';
import { pushWarning } from '@cleocode/lafs';
import { EDGE_TYPES } from '../memory/edge-types.js';
import { getBrainDb, getBrainNativeDb } from '../store/memory-sqlite.js';
import { getNexusDb, getNexusNativeDb } from '../store/nexus-sqlite.js';
import { typedAll, typedGet } from '../store/typed-query.js';
import { recordKnowledgeGap } from './knowledge.js';
import { getTaskKnowledgeEvidence } from './task-evidence.js';

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
 * @param commitRefs - Explicit commits supplying the file association, when available.
 * @returns Result summary with count of edges created or an explicit failure state.
 * @remarks Persisted file evidence associates symbols with the file; it does not prove each symbol changed.
 * @example
 * ```ts
 * const result = await linkTaskToSymbols('T448', '["src/rush.ts"]', projectRoot, commitRefs);
 * ```
 */
export async function linkTaskToSymbols(
  taskId: string,
  filesJson: string,
  projectRoot: string,
  commitRefs: readonly string[] = [],
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
      throw new Error('Task file evidence is not valid JSON.');
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
    await getNexusDb(projectRoot);

    const brainNative = getBrainNativeDb(projectRoot);
    const nexusNative = getNexusNativeDb(projectRoot);

    if (!brainNative || !nexusNative) throw new Error('Task symbol stores are unavailable.');

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
            JSON.stringify({
              source: 'git-log-file-match',
              precision: 'file',
              filePath,
              commitRefs: [...commitRefs].sort(),
            }),
            now,
          );

        edgesCreated++;
      }
    }

    return {
      linked: edgesCreated,
      taskId,
      filesProcessed: files.length,
      symbolsFound,
    };
  } catch (err) {
    // T9771: route task-symbol-link failure to LAFS meta.warnings.
    pushWarning({
      code: 'W_TASKS_BRIDGE_FAILED',
      message: `linkTaskToSymbols failed for ${taskId}`,
      severity: 'warn',
      context: {
        bridge: 'tasks',
        operation: 'linkTaskToSymbols',
        taskId,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return {
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
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
    const brainNative = getBrainNativeDb(projectRoot);

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
      precision: 'file',
    }));
  } catch (err) {
    // T9771: route task-symbol-lookup failure to LAFS meta.warnings.
    pushWarning({
      code: 'W_TASKS_BRIDGE_FAILED',
      message: `getTasksForSymbol failed for ${symbolId}`,
      severity: 'warn',
      context: {
        bridge: 'tasks',
        operation: 'getTasksForSymbol',
        symbolId,
        error: err instanceof Error ? err.message : String(err),
      },
    });
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
  taskEvidence?: TaskKnowledgeEvidence,
): Promise<SymbolReference[]> {
  const evidence = taskEvidence ?? (await getTaskKnowledgeEvidence(taskId, projectRoot));
  try {
    // Ensure both DBs are initialized
    await getBrainDb(projectRoot);
    await getNexusDb(projectRoot);

    const brainNative = getBrainNativeDb(projectRoot);
    const nexusNative = getNexusNativeDb(projectRoot);

    if (!brainNative || !nexusNative) {
      recordKnowledgeGap(evidence.coverage, 'failed', 'Task symbol stores are unavailable.');
      return [];
    }

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

    // Hydrate symbol details from nexus
    const results: SymbolReference[] = [];
    for (const edge of edgeRows) {
      const symbol = typedGet<RawNexusNode>(
        nexusNative.prepare(
          `SELECT id, label, file_path, kind FROM nexus_nodes WHERE id = ? LIMIT 1`,
        ),
        edge.to_id,
      );

      if (symbol) {
        const currentFile = evidence.files.find((file) => file.path === symbol.file_path);
        if (
          evidence.coverage.evidence.some((ref) => ref.id === 'graph_assessment') &&
          !currentFile
        ) {
          recordKnowledgeGap(
            evidence.coverage,
            'partial',
            `Historical derived link requires evidence revalidation: ${symbol.id}`,
          );
          continue;
        }
        results.push({
          nexusNodeId: symbol.id,
          label: symbol.label,
          kind: symbol.kind,
          filePath: symbol.file_path,
          weight: edge.weight,
          matchStrategy: 'legacy-file-association',
          precision: 'file',
          evidence: evidence.files.find((file) => file.path === symbol.file_path)?.evidence ?? [],
        });
      }
    }

    const known = new Set(results.map((symbol) => symbol.nexusNodeId));
    for (const file of evidence.files) {
      const nodes = typedAll<RawNexusNode>(
        nexusNative.prepare(
          `SELECT id, label, file_path, kind FROM nexus_nodes WHERE file_path = ?
         AND kind NOT IN ('file', 'folder', 'community', 'process')`,
        ),
        file.path,
      );
      if (!nodes.length)
        recordKnowledgeGap(
          evidence.coverage,
          'partial',
          `Evidence file has no indexed symbols: ${file.path}`,
        );
      for (const node of nodes) {
        if (known.has(node.id)) continue;
        known.add(node.id);
        results.push({
          nexusNodeId: node.id,
          label: node.label,
          kind: node.kind,
          filePath: node.file_path,
          weight: 1,
          matchStrategy: 'explicit-file-evidence',
          precision: 'file',
          evidence: file.evidence,
        });
      }
    }
    return results;
  } catch (err) {
    recordKnowledgeGap(
      evidence.coverage,
      'failed',
      err instanceof Error ? err.message : String(err),
    );
    // T9771: route task-symbol-lookup failure to LAFS meta.warnings.
    pushWarning({
      code: 'W_TASKS_BRIDGE_FAILED',
      message: `getSymbolsForTask failed for ${taskId}`,
      severity: 'warn',
      context: {
        bridge: 'tasks',
        operation: 'getSymbolsForTask',
        taskId,
        error: err instanceof Error ? err.message : String(err),
      },
    });
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
 * Idempotent: stores the last-synced commit hash in main._nexus_meta
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
    await getNexusDb(projectRoot);

    const brainNative = getBrainNativeDb(projectRoot);
    const nexusNative = getNexusNativeDb(projectRoot);

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
      // Try to read last-synced commit from main._nexus_meta
      try {
        const meta = nexusNative
          .prepare(`SELECT value FROM main._nexus_meta WHERE key = ?`)
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
      // Use "%H %s" so each commit header line contains both hash and subject,
      // allowing task-ID extraction from commit messages (e.g. "feat(T001): …").
      const args = ['log', '--pretty=format:%H %s', '--name-only'];
      if (since) {
        args.push(`${since}..HEAD`);
      }

      gitLogOutput = execFileSync('git', args, {
        cwd: projectRoot,
        encoding: 'utf-8',
        // T9771: capture stderr (pipe) so git's own diagnostics do NOT leak
        // to the parent's stderr when running under JSON-emitting handlers.
        // Without this, "fatal: not a git repository" from git would land in
        // the user's terminal even though we route the failure through
        // pushWarning() for envelope-only delivery.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      // T9771: git command failed — likely not a git repo; surface as
      // envelope warning instead of stderr so JSON consumers stay clean.
      pushWarning({
        code: 'W_TASKS_BRIDGE_FAILED',
        message:
          'runGitLogTaskLinker: git log failed — directory may not be a git repository. Skipping task-symbol linking.',
        severity: 'warn',
        context: {
          bridge: 'tasks',
          operation: 'runGitLogTaskLinker',
          projectRoot,
        },
      });
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
    const taskCommits = new Map<string, Set<string>>();

    for (const commit of commits) {
      const taskMatch = commit.subject.match(/T\d+/);
      if (taskMatch) {
        const taskId = taskMatch[0];
        if (!taskFiles.has(taskId)) {
          taskFiles.set(taskId, new Set());
          taskCommits.set(taskId, new Set());
        }
        taskCommits.get(taskId)?.add(commit.hash);
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
        [...(taskCommits.get(taskId) ?? [])],
      );
      totalEdges += result.linked;
    }

    // Store the newest (HEAD) commit hash for idempotency (main._nexus_meta is project-scoped).
    // git log returns commits newest-first, so commits[0] is HEAD.
    // On the next run, `HEAD..HEAD` returns nothing → 0 commits processed.
    const lastCommit = commits[0].hash;
    try {
      nexusNative
        .prepare(
          `INSERT INTO main._nexus_meta (key, value)
           VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run('last_task_linker_commit', lastCommit);
    } catch {
      // Ignore if main._nexus_meta doesn't support this
    }

    return {
      linked: totalEdges,
      commitsProcessed: commits.length,
      tasksFound: taskFiles.size,
      lastCommitHash: lastCommit,
    };
  } catch (err) {
    // T9771: route git-log linker failure to LAFS meta.warnings.
    pushWarning({
      code: 'W_TASKS_BRIDGE_FAILED',
      message: 'runGitLogTaskLinker failed',
      severity: 'warn',
      context: {
        bridge: 'tasks',
        operation: 'runGitLogTaskLinker',
        error: err instanceof Error ? err.message : String(err),
      },
    });
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
 * Parse git log --pretty=format:"%H %s" --name-only output.
 *
 * Each commit's header line contains "<hash> <subject>" (hash + space + subject),
 * followed by file paths on subsequent lines, with commits separated by blank lines.
 *
 * Returns array of commits with hash, subject (the commit message subject), and file list.
 */
function parseGitLogOutput(output: string): GitCommitRow[] {
  const commits: GitCommitRow[] = [];
  const lines = output.split('\n');

  let currentHash: string | null = null;
  let currentSubject = '';
  let currentFiles: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Empty lines separate commits
    if (!trimmed) {
      if (currentHash) {
        commits.push({
          hash: currentHash,
          subject: currentSubject,
          files: currentFiles,
        });
        currentHash = null;
        currentSubject = '';
        currentFiles = [];
      }
      continue;
    }

    // If we don't have a hash yet, this is the commit header: "<hash> <subject>"
    if (!currentHash) {
      // Git SHA-1 hashes are 40 hex chars; SHA-256 hashes are 64 hex chars.
      // Split on the first space to separate hash from subject.
      const spaceIdx = trimmed.indexOf(' ');
      if (spaceIdx > 0) {
        currentHash = trimmed.slice(0, spaceIdx);
        currentSubject = trimmed.slice(spaceIdx + 1);
      } else {
        // No space — treat entire line as hash (subject is empty)
        currentHash = trimmed;
        currentSubject = '';
      }
    } else {
      // Subsequent non-empty lines are file paths touched by this commit
      currentFiles.push(trimmed);
    }
  }

  // Don't forget the last commit if output doesn't end with a blank line
  if (currentHash) {
    commits.push({
      hash: currentHash,
      subject: currentSubject,
      files: currentFiles,
    });
  }

  return commits;
}
