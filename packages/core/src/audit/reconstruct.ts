/**
 * Audit lineage reconstruction — SDK primitive.
 *
 * Promotes git-log + release-tag lineage reconstruction to a first-class
 * SDK verb. Git IS the immutable hash-chained ledger; this module mines it
 * to produce a structured {@link ReconstructResult} consumed by T1216 audit tasks.
 *
 * No `.jsonl` sidecar is emitted — git's DAG is the source of truth (per
 * FP peer note, T1322 council verdict 2026-04-24).
 *
 * Security: all git subprocess calls use `execFileSync` with strict `argv`
 * arrays — no shell interpolation or user-controlled string concatenation
 * in the command string.
 *
 * @task T1322
 * @epic T1216
 */

import { execFileSync } from 'node:child_process';
import type { CommitEntry, ReconstructResult, ReleaseTagEntry } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command with strict argv (no shell interpolation).
 *
 * @param cwd - Working directory for the git process.
 * @param args - Argument list passed directly to git (not via shell).
 * @returns stdout as a trimmed UTF-8 string, or `""` on error.
 */
function runGit(cwd: string, args: readonly string[]): string {
  try {
    const output = execFileSync('git', [...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024, // 8 MiB — generous for large repos
    });
    return output.trim();
  } catch {
    return '';
  }
}

/**
 * Parse raw `--pretty=format:"%H\x1f%s\x1f%an\x1f%ai"` git log output into
 * an array of {@link CommitEntry} records.
 *
 * Uses the ASCII unit-separator (0x1F) as the field delimiter to avoid
 * collisions with commit subject text.
 *
 * @param raw - Raw stdout from git log with the expected format string.
 */
function parseGitLog(raw: string): CommitEntry[] {
  if (!raw) return [];
  const results: CommitEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\x1f');
    if (parts.length < 4) continue;
    const [sha, subject, author, authorDate] = parts as [string, string, string, string];
    if (!sha || sha.length < 7) continue;
    results.push({ sha, subject, author, authorDate });
  }
  return results;
}

/**
 * Run `git log --all --grep=<pattern>` with the standard pretty format and
 * return parsed commit entries.
 *
 * The `--fixed-strings` flag prevents the pattern from being interpreted as
 * a POSIX extended regex, which keeps the semantics predictable.
 *
 * @param repoRoot - Absolute path to the git repository.
 * @param pattern - Literal string to grep for in commit messages.
 */
function gitLogGrep(repoRoot: string, pattern: string): CommitEntry[] {
  const raw = runGit(repoRoot, [
    'log',
    '--all',
    '--fixed-strings',
    `--grep=${pattern}`,
    '--pretty=format:%H\x1f%s\x1f%an\x1f%ai',
  ]);
  return parseGitLog(raw);
}

/**
 * Collect all release tags that contain a given commit SHA.
 *
 * Uses `git tag --contains <sha>` which lists all tags reachable from
 * the commit, not just the nearest one.
 *
 * @param repoRoot - Absolute path to the git repository.
 * @param sha - Full commit SHA to query.
 */
function tagsContaining(repoRoot: string, sha: string): string[] {
  const raw = runGit(repoRoot, ['tag', '--contains', sha]);
  if (!raw) return [];
  return raw
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Resolve a tag name to its target commit SHA using `git rev-parse <tag>^{}`.
 *
 * The `^{}` dereferences annotated tags to the underlying commit object.
 *
 * @param repoRoot - Absolute path to the git repository.
 * @param tag - Tag name to resolve.
 */
function resolveTagCommit(repoRoot: string, tag: string): string {
  return runGit(repoRoot, ['rev-parse', `${tag}^{}`]);
}

/**
 * Fetch the commit subject for a given SHA.
 *
 * @param repoRoot - Absolute path to the git repository.
 * @param sha - Full commit SHA.
 */
function commitSubject(repoRoot: string, sha: string): string {
  return runGit(repoRoot, ['log', '-1', '--pretty=format:%s', sha]);
}

/**
 * Infer the numeric child ID range for a parent task ID.
 *
 * Strategy (in order of priority):
 * 1. Mine commit messages for adjacent task-ID mentions (e.g. T994, T995, …)
 *    from the parent's direct-commit subjects — zero git calls.
 * 2. Adjacency heuristic: issue ONE `git log --all` with an extended-regex
 *    pattern covering the ±20 window around the parent ID, then extract all
 *    matching task IDs from the output. This replaces 40 sequential git-log
 *    calls with a single pass.
 *
 * Returns `null` when no children can be inferred.
 *
 * @param repoRoot - Absolute path to the git repository.
 * @param parentNumeric - Numeric portion of the parent task ID (e.g. 991 for T991).
 * @param directCommits - The parent's own direct commits (used to extract sibling mentions).
 */
function inferChildRange(
  repoRoot: string,
  parentNumeric: number,
  directCommits: CommitEntry[],
): { min: string; max: string; ids: string[] } | null {
  const foundIds = new Set<number>();

  // Step 1: Mine sibling mentions from direct-commit subjects (no git calls).
  const combinedText = directCommits.map((c) => c.subject).join('\n');
  const taskPattern = /\bT(\d+)\b/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((match = taskPattern.exec(combinedText)) !== null) {
    const n = parseInt(match[1] ?? '0', 10);
    // Accept IDs within ±50 of the parent as likely sibling cluster members
    if (n !== parentNumeric && Math.abs(n - parentNumeric) <= 50) {
      foundIds.add(n);
    }
  }

  // Step 2: Single-pass adjacency probe using ONE git log call with an ERE
  // pattern that matches any T<n> in the ±20 window.
  // Build an alternation of the 40 candidate IDs, avoiding shell interpolation
  // by passing the pattern directly to git as an argument.
  const lo = Math.max(1, parentNumeric - 20);
  const hi = parentNumeric + 20;
  const candidates: number[] = [];
  for (let n = lo; n <= hi; n++) {
    if (n !== parentNumeric) candidates.push(n);
  }

  // ERE alternation: \b(T971|T972|...|T1011)\b — git --regexp-ignore-case is
  // NOT used so the pattern is case-sensitive (task IDs are always upper-case T).
  const alternation = candidates.map((n) => `T${n}`).join('|');
  const raw = runGit(repoRoot, [
    'log',
    '--all',
    '--extended-regexp',
    `--grep=\\b(${alternation})\\b`,
    '--pretty=format:%s',
  ]);

  if (raw) {
    const linePattern = /\bT(\d+)\b/g;
    let lineMatch: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
    while ((lineMatch = linePattern.exec(raw)) !== null) {
      const n = parseInt(lineMatch[1] ?? '0', 10);
      if (n !== parentNumeric && Math.abs(n - parentNumeric) <= 20) {
        foundIds.add(n);
      }
    }
  }

  if (foundIds.size === 0) return null;

  const sorted = [...foundIds].sort((a, b) => a - b);
  const minId = sorted[0]!;
  const maxId = sorted[sorted.length - 1]!;

  return {
    min: `T${minId}`,
    max: `T${maxId}`,
    ids: sorted.map((n) => `T${n}`),
  };
}

/**
 * Compute the earliest ISO-8601 date across a flat list of commit entries.
 *
 * @param commits - Commit entries to examine.
 */
function earliestDate(commits: CommitEntry[]): string | null {
  if (commits.length === 0) return null;
  return commits.reduce<string>(
    (acc, c) => (c.authorDate < acc ? c.authorDate : acc),
    commits[0]!.authorDate,
  );
}

/**
 * Compute the latest ISO-8601 date across a flat list of commit entries.
 *
 * @param commits - Commit entries to examine.
 */
function latestDate(commits: CommitEntry[]): string | null {
  if (commits.length === 0) return null;
  return commits.reduce<string>(
    (acc, c) => (c.authorDate > acc ? c.authorDate : acc),
    commits[0]!.authorDate,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reconstruct the git-backed lineage for a task and its inferred children.
 *
 * This is the first-class SDK verb for audit lineage reconstruction (T1322).
 * It queries git directly and returns a fully-typed {@link ReconstructResult}
 * that T1216 audit tasks consume for their 4-outcome verdict.
 *
 * **Algorithm**:
 * 1. Find direct commits whose message references `taskId`.
 * 2. Infer child ID range from commit-message mining and numeric adjacency.
 * 3. Find child commits for each inferred child ID.
 * 4. Collect all release tags containing any direct or child commit.
 * 5. Compute first/last timestamps across the full commit set.
 *
 * @param taskId - The task ID to reconstruct (e.g. `"T991"`).
 * @param repoRoot - Absolute path to the git repository. Defaults to `process.cwd()`.
 * @returns A fully-typed {@link ReconstructResult} with all git-derived lineage data.
 *
 * @example
 * ```ts
 * import { reconstructLineage } from '@cleocode/core/audit/reconstruct.js';
 *
 * const result = await reconstructLineage('T991');
 * console.log(result.releaseTags.map(t => t.tag));
 * // → ['v2026.4.98', 'v2026.4.99', ...]
 * ```
 *
 * @task T1322
 * @epic T1216
 */
export async function reconstructLineage(
  taskId: string,
  repoRoot: string = process.cwd(),
): Promise<ReconstructResult> {
  // 1. Direct commits — messages that reference the exact task ID
  const directCommits = gitLogGrep(repoRoot, taskId);

  // 2. Infer child ID range
  const numericMatch = taskId.match(/^T(\d+)$/i);
  const parentNumeric = numericMatch ? parseInt(numericMatch[1] ?? '0', 10) : 0;

  const rangeResult =
    parentNumeric > 0 ? inferChildRange(repoRoot, parentNumeric, directCommits) : null;

  const childIdRange: ReconstructResult['childIdRange'] = rangeResult
    ? { min: rangeResult.min, max: rangeResult.max }
    : null;

  const inferredChildren: string[] = rangeResult ? rangeResult.ids : [];

  // 3. Child commits — one git-log query per inferred child ID
  const childCommits: Record<string, CommitEntry[]> = {};
  for (const childId of inferredChildren) {
    const hits = gitLogGrep(repoRoot, childId);
    if (hits.length > 0) {
      childCommits[childId] = hits;
    }
  }

  // 4. Release tags — collect all tags containing any direct or child commit SHA
  const allCommitShas = new Set<string>(directCommits.map((c) => c.sha));
  for (const commits of Object.values(childCommits)) {
    for (const c of commits) {
      allCommitShas.add(c.sha);
    }
  }

  const tagSet = new Set<string>();
  for (const sha of allCommitShas) {
    for (const tag of tagsContaining(repoRoot, sha)) {
      tagSet.add(tag);
    }
  }

  const releaseTags: ReleaseTagEntry[] = [...tagSet]
    .sort()
    .map((tag) => {
      const commitSha = resolveTagCommit(repoRoot, tag);
      const subject = commitSha ? commitSubject(repoRoot, commitSha) : '';
      return { tag, commitSha, subject };
    })
    .filter((entry) => entry.commitSha.length > 0);

  const releaseCommitShas = releaseTags.map((t) => t.commitSha);

  // 5. Timing bounds
  const allWorkCommits: CommitEntry[] = [...directCommits, ...Object.values(childCommits).flat()];

  const firstSeenAt = earliestDate(allWorkCommits);
  const lastSeenAt = latestDate(allWorkCommits);

  return {
    taskId,
    directCommits,
    childIdRange,
    childCommits,
    releaseTags,
    releaseCommitShas,
    firstSeenAt,
    lastSeenAt,
    inferredChildren,
  };
}
