/**
 * Boundary-enforcement predicates for the git-shim (T1591 L2 fence).
 *
 * Pure functions — no I/O, no spawning. Each predicate returns either
 * `null` (allowed) or a {@link BoundaryViolation} (must block).
 *
 * The four T1591 boundaries:
 *
 * 1. **(a) Worktree-path enforcement** — `git add <path>` MUST stage files
 *    inside the active worktree. Cross-worktree adds are blocked.
 * 2. **(b) Commit T-ID gate** — `git commit -m "<msg>"` MUST embed `T<NUM>`
 *    in the subject line.
 * 3. **(c) Merge restriction** — `git merge` is blocked unless
 *    `CLEO_ORCHESTRATE_MERGE=1` (set by `completeAgentWorktreeViaMerge`).
 * 4. **(d) Cherry-pick refusal** — `git cherry-pick <ref>` is blocked when
 *    `<ref>` matches `task/T\d+` (T1587 anti-pattern).
 *
 * @task T1591
 * @adr ADR-062
 */
import { isAbsolute, resolve } from 'node:path';
import { isPathInsideWorktree } from './worktree-path.js';

/**
 * Result returned by a boundary predicate when an operation must be blocked.
 *
 * Stable shape so callers can render consistent error envelopes.
 *
 * @task T1591
 */
export interface BoundaryViolation {
  /** CLEO error code (`E_GIT_BOUNDARY_*`). */
  code:
    | 'E_GIT_BOUNDARY_WORKTREE_PATH'
    | 'E_GIT_BOUNDARY_COMMIT_TASK_ID'
    | 'E_GIT_BOUNDARY_MERGE_FORBIDDEN'
    | 'E_GIT_BOUNDARY_CHERRY_PICK_TASK_BRANCH';
  /** Which boundary letter (a/b/c/d) — kept in audit log for grouping. */
  boundary: 'a' | 'b' | 'c' | 'd';
  /** Short human-readable summary of the violation. */
  message: string;
  /** Suggested operator action (always includes the override path). */
  remediation: string;
  /** Free-form context attached to the audit record. */
  context: Record<string, string>;
}

/** Regex that matches CLEO task IDs in commit subjects. Project-agnostic. */
const TASK_ID_PATTERN = /\bT\d+\b/;

/** Regex that matches a worktree branch ref (`task/T<NUM>`). */
const TASK_BRANCH_PATTERN = /^task\/T\d+$/;

/**
 * Boundary (a) — Worktree-path enforcement.
 *
 * Rejects `git add` of a path outside the active worktree. The shim runs
 * with `cwd === process.cwd()`, so any relative path is rooted there.
 * Absolute paths are checked verbatim.
 *
 * `git add` flags that don't take paths (`-A`, `--all`, `-u`, `--update`,
 * `-i`, `--interactive`, `-p`, `--patch`) are allowed as-is — git itself
 * scopes them to the current repo, which is the worktree.
 *
 * @param args - argv slice after the `add` subcommand.
 * @param cwd - Current working directory at invocation time.
 * @param worktreePath - Active worktree root.
 * @returns Violation when an explicit path escapes the worktree, else null.
 *
 * @task T1591
 */
export function validateAddPaths(
  args: ReadonlyArray<string>,
  cwd: string,
  worktreePath: string,
): BoundaryViolation | null {
  // Walk through args; non-flag arguments are pathspecs.
  for (const arg of args) {
    if (arg.startsWith('-')) continue; // flag — skip
    // Pathspec leaders like `:` or `:/` are skipped — git treats them specially.
    if (arg === '.' || arg === '*' || arg === '') continue;
    if (arg.startsWith(':')) continue;

    const absolute = isAbsolute(arg) ? arg : resolve(cwd, arg);
    if (!isPathInsideWorktree(absolute, worktreePath)) {
      return {
        code: 'E_GIT_BOUNDARY_WORKTREE_PATH',
        boundary: 'a',
        message: `git add refused — path "${arg}" resolves outside agent worktree (${worktreePath})`,
        remediation:
          'Stage only files inside the worktree. To bypass for emergency hotfix set CLEO_ALLOW_GIT=1 (audited).',
        context: {
          attempted_path: arg,
          resolved_path: absolute,
          worktree_path: worktreePath,
        },
      };
    }
  }
  return null;
}

/**
 * Extract every commit-message subject from a `git commit` invocation.
 *
 * Handles `-m <msg>`, `--message <msg>`, `-m=<msg>`, `--message=<msg>`. Each
 * occurrence contributes to a multi-paragraph commit; the **first** message is
 * the subject. We validate every `-m` since git concatenates them with blank
 * lines.
 *
 * @param args - argv slice after the `commit` subcommand.
 * @returns The list of message values present, in order.
 *
 * @task T1591
 */
export function extractCommitMessages(args: ReadonlyArray<string>): string[] {
  const messages: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === '-m' || a === '--message') {
      const next = args[i + 1];
      if (next !== undefined) messages.push(next);
      i++;
      continue;
    }
    if (a.startsWith('-m=')) {
      messages.push(a.slice(3));
      continue;
    }
    if (a.startsWith('--message=')) {
      messages.push(a.slice('--message='.length));
    }
  }
  return messages;
}

/**
 * Determine whether the given commit invocation will produce a new commit.
 *
 * Read-only flags like `--dry-run`, `--allow-empty-message`, the absence of
 * `-m` (which opens an editor — caught by the editor-side hook in T1588), and
 * `--amend` without `-m` all pass through. The shim only enforces when a
 * subject is supplied inline.
 *
 * @param args - argv slice after the `commit` subcommand.
 * @returns true when at least one inline `-m` message was supplied.
 *
 * @task T1591
 */
export function commitHasInlineMessage(args: ReadonlyArray<string>): boolean {
  return extractCommitMessages(args).length > 0;
}

/**
 * Boundary (b) — Commit T-ID gate.
 *
 * Rejects `git commit -m "<msg>"` when the subject lacks a CLEO task ID
 * (`T<NUM>`). Multi-`-m` invocations validate the FIRST message (the
 * subject — git concatenates subsequent `-m` values as paragraphs).
 *
 * @param args - argv slice after the `commit` subcommand.
 * @param expectedTaskId - Optional hard-anchor: when provided, the subject
 *   must contain this exact ID, not just any `T<NUM>`.
 * @returns Violation when the inline subject lacks a task ID, else null.
 *
 * @task T1591
 */
export function validateCommitSubject(
  args: ReadonlyArray<string>,
  expectedTaskId: string | null,
): BoundaryViolation | null {
  const messages = extractCommitMessages(args);
  if (messages.length === 0) return null; // editor flow — handled by hooks (T1588)
  const subject = messages[0] ?? '';

  if (expectedTaskId) {
    // Anchor check: subject must contain the active worktree's task ID.
    const literal = new RegExp(`\\b${expectedTaskId}\\b`);
    if (!literal.test(subject)) {
      return {
        code: 'E_GIT_BOUNDARY_COMMIT_TASK_ID',
        boundary: 'b',
        message: `git commit refused — subject "${subject}" missing task ID "${expectedTaskId}"`,
        remediation: `Include "${expectedTaskId}" in the subject (e.g. "feat(${expectedTaskId}): …"). Bypass with CLEO_ALLOW_GIT=1 (audited).`,
        context: { subject, expected_task_id: expectedTaskId },
      };
    }
    return null;
  }

  // No expected ID — fall back to any `T<NUM>` (project-agnostic CLEO convention).
  if (!TASK_ID_PATTERN.test(subject)) {
    return {
      code: 'E_GIT_BOUNDARY_COMMIT_TASK_ID',
      boundary: 'b',
      message: `git commit refused — subject "${subject}" missing CLEO task ID (T<NUM>)`,
      remediation:
        'Add a task ID to the subject (e.g. "fix(T1234): …"). Bypass with CLEO_ALLOW_GIT=1 (audited).',
      context: { subject },
    };
  }
  return null;
}

/**
 * Boundary (c) — Merge restriction.
 *
 * Rejects `git merge` invocations from agent worktrees unless the
 * `CLEO_ORCHESTRATE_MERGE` env var is set. That env var is supplied
 * exclusively by `completeAgentWorktreeViaMerge` (ADR-062 / T1587), so a
 * direct `git merge` from an agent will always fail.
 *
 * Merge subcommand variants that DON'T merge (`--abort`, `--continue`,
 * `--quit`) pass through.
 *
 * @param args - argv slice after the `merge` subcommand.
 * @param env - Snapshot of relevant env vars.
 * @returns Violation when merge is blocked, else null.
 *
 * @task T1591
 * @adr ADR-062
 */
export function validateMergeAllowed(
  args: ReadonlyArray<string>,
  env: { CLEO_ORCHESTRATE_MERGE?: string },
): BoundaryViolation | null {
  // Allow control-flow flags that don't perform a merge.
  for (const arg of args) {
    if (arg === '--abort' || arg === '--continue' || arg === '--quit') {
      return null;
    }
  }

  if (env.CLEO_ORCHESTRATE_MERGE === '1') return null;

  return {
    code: 'E_GIT_BOUNDARY_MERGE_FORBIDDEN',
    boundary: 'c',
    message: 'git merge refused — agents MUST NOT merge directly (ADR-062 / T1587)',
    remediation:
      'Use `cleo orchestrate complete <taskId>` so the orchestrator runs git merge --no-ff with the right env. Bypass with CLEO_ALLOW_GIT=1 (audited).',
    context: {
      args: args.join(' '),
    },
  };
}

/**
 * Boundary (d) — Cherry-pick refusal from worktree branches.
 *
 * Rejects `git cherry-pick <ref>` when `<ref>` is a `task/T<NUM>` branch.
 * Cherry-pick from those branches is the deprecated integration path
 * (ADR-062 supersedes it with `git merge --no-ff`).
 *
 * Also catches `git cherry-pick task/T<NUM>..HEAD` and similar range syntax.
 *
 * @param args - argv slice after the `cherry-pick` subcommand.
 * @returns Violation when a task-branch ref is referenced, else null.
 *
 * @task T1591
 * @adr ADR-062
 */
export function validateCherryPickSource(args: ReadonlyArray<string>): BoundaryViolation | null {
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    // Range syntax like `task/T123..HEAD` or `task/T123^..task/T123`.
    const refs = arg.split(/\.{2,3}/);
    for (const ref of refs) {
      const trimmed = ref.replace(/[\^~].*$/, '');
      if (TASK_BRANCH_PATTERN.test(trimmed)) {
        return {
          code: 'E_GIT_BOUNDARY_CHERRY_PICK_TASK_BRANCH',
          boundary: 'd',
          message: `git cherry-pick refused — source ref "${trimmed}" is an agent worktree branch (ADR-062: use git merge --no-ff)`,
          remediation:
            'Run `cleo orchestrate complete <taskId>` to integrate via merge. Bypass with CLEO_ALLOW_GIT=1 (audited).',
          context: { source_ref: trimmed, original_arg: arg },
        };
      }
    }
  }
  return null;
}
