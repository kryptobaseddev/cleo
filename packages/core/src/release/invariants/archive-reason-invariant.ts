/**
 * Archive-reason post-release invariant — first customer of the registry
 * defined in {@link ./registry}.
 *
 * Workflow (per ADR-056 D5 step 2):
 *   1. Read the tag annotation (`git tag <tag> -l --format='%(contents)'`)
 *      and every commit between `<previousTag>..<tag>` (inclusive of `<tag>`).
 *   2. Extract every `T\d+` reference from subjects + bodies + tag annotation.
 *   3. For each task ID:
 *        - If `status='pending'` AND verification gates have all passed:
 *          stamp `status='done'`, `archive_reason='verified'`,
 *          `release='<tag>'` in one transaction.
 *        - If `status='pending'` AND verification is null/incomplete:
 *          create a follow-up task `T-RECONCILE-FOLLOWUP-<tag>-<idx>` linked
 *          to the unreconciled task ID.
 *        - Otherwise (already done / cancelled / not found): no-op.
 *   4. Append every mutation to `.cleo/audit/reconcile.jsonl`.
 *
 * Tombstone semantics: this invariant NEVER writes
 * `archive_reason='completed-unverified'`. The tombstone is reserved for
 * the T1408 backfill migration. We always stamp `verified` (clean reconcile)
 * or create a follow-up (unreconciled). See contracts SSoT
 * `packages/contracts/src/tasks/archive.ts`.
 *
 * @task T1411
 * @epic T1407
 * @adr ADR-056 D5
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ArchiveReason,
  type ArchiveReasonValue,
  assertArchiveReason,
  type Task,
} from '@cleocode/contracts';
import { getLogger } from '../../logger.js';
import { getAccessor } from '../../store/data-accessor.js';
import { type InvariantResult, type InvariantRunOptions, registerInvariant } from './registry.js';

const log = getLogger('release.invariants.archive-reason');

/** Relative path within the project root for the reconcile audit log. */
export const RECONCILE_AUDIT_FILE = '.cleo/audit/reconcile.jsonl';

/** Stable invariant id surfaced in {@link InvariantResult.id}. */
export const ARCHIVE_REASON_INVARIANT_ID = 'archive-reason';

/** Audit row appended to `reconcile.jsonl` for every mutation. */
export interface ReconcileAuditRow {
  /** ISO-8601 timestamp of the mutation. */
  timestamp: string;
  /** Release tag being reconciled. */
  tag: string;
  /** Task ID the mutation targeted. */
  taskId: string;
  /** What was done — see {@link ReconcileAction}. */
  action: ReconcileAction;
  /** Archive reason stamped (only present for `reconciled` action). */
  reason?: ArchiveReasonValue;
  /** Free-text rationale (e.g. "verification gates passed"). */
  note: string;
  /** Optional follow-up task id created for unreconciled cases. */
  followUpTaskId?: string;
}

/**
 * The four mutation outcomes recorded in `.cleo/audit/reconcile.jsonl`.
 *
 * - `reconciled`           — task stamped done + archive_reason=verified + release=<tag>.
 * - `followup-created`     — follow-up `T-RECONCILE-FOLLOWUP-…` task created.
 * - `noop-already-closed`  — task was already done / cancelled / archived.
 * - `noop-not-found`       — task ID referenced in commits but not in the DB.
 */
export type ReconcileAction =
  | 'reconciled'
  | 'followup-created'
  | 'noop-already-closed'
  | 'noop-not-found';

// ---------------------------------------------------------------------------
// Internal helpers — git plumbing
// ---------------------------------------------------------------------------

/**
 * Run a git command with strict argv (no shell interpolation).
 *
 * Returns trimmed stdout, or `''` if the command exits non-zero (e.g. the
 * tag does not exist yet — common during the first reconcile of a new tag
 * the operator just pushed).
 */
function runGit(cwd: string, args: readonly string[]): string {
  try {
    const out = execFileSync('git', [...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    });
    return out.trim();
  } catch {
    return '';
  }
}

/**
 * Resolve the tag immediately preceding `tag` in semver-ish ordering.
 *
 * Uses `git describe --tags --abbrev=0 <tag>^` which returns the closest
 * older tag reachable from the parent commit of `tag`. When no prior tag
 * exists the function returns an empty string and the caller falls back
 * to `git log <tag>` (single-commit window — usually the tag's own
 * release commit).
 */
function previousTag(repoRoot: string, tag: string): string {
  return runGit(repoRoot, ['describe', '--tags', '--abbrev=0', `${tag}^`]);
}

/**
 * Read the annotation body of an annotated tag (or empty if lightweight).
 *
 * `--format='%(contents)'` prints subject + body + signature minus the
 * leading `tag <name>` header, which is what reconcile cares about.
 */
function tagAnnotation(repoRoot: string, tag: string): string {
  return runGit(repoRoot, ['tag', '-l', '--format=%(contents)', tag]);
}

/**
 * Return the concatenated subject + body of every commit in the tag's
 * range, separated by null bytes.
 *
 * Range:
 *   - `<previousTag>..<tag>` when a previous tag exists.
 *   - `<tag>` (single commit) otherwise.
 */
function commitMessagesInTagRange(repoRoot: string, tag: string): string {
  const prev = previousTag(repoRoot, tag);
  const range = prev ? `${prev}..${tag}` : tag;
  // %s = subject, %b = body, %x00 = null separator (avoids collisions with
  // any plausible commit-message content).
  return runGit(repoRoot, ['log', '--no-color', '--pretty=format:%s%n%b%x00', range]);
}

// ---------------------------------------------------------------------------
// Internal helpers — task-ID extraction
// ---------------------------------------------------------------------------

/**
 * Extract every unique `T<digits>` task ID from a corpus of text.
 *
 * Matches `T1411`, `T-1411` is intentionally NOT matched (the dash form is
 * reserved for follow-up tasks like `T-RECONCILE-FOLLOWUP-…`). Order is
 * preserved by first-occurrence so audit rows render predictably.
 */
export function extractTaskIds(text: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const re = /\bT(\d+)\b/g;
  for (const match of text.matchAll(re)) {
    const id = `T${match[1]}`;
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Internal helpers — audit log
// ---------------------------------------------------------------------------

/**
 * Append a single {@link ReconcileAuditRow} to `.cleo/audit/reconcile.jsonl`.
 *
 * Failures are logged but never thrown — audit writes MUST NOT block the
 * reconcile loop (matches the convention used in `appendContractViolation`).
 */
function appendReconcileAudit(repoRoot: string, row: ReconcileAuditRow): void {
  try {
    const filePath = join(repoRoot, RECONCILE_AUDIT_FILE);
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(row)}\n`, { encoding: 'utf-8' });
  } catch (err) {
    log.warn({ err, taskId: row.taskId }, 'failed to append reconcile audit row');
  }
}

// ---------------------------------------------------------------------------
// Invariant implementation
// ---------------------------------------------------------------------------

/**
 * Determine whether a task's verification record is fully passed.
 *
 * A task is considered verified iff `verification.passed === true` AND at
 * least one gate is recorded as `true`. The second guard rejects tasks
 * with empty gate dictionaries (theoretically possible if a buggy writer
 * left `passed=true` with no gate map).
 */
function isFullyVerified(task: Task): boolean {
  const v = task.verification;
  if (!v || v.passed !== true) return false;
  const gates = v.gates;
  if (!gates) return false;
  return Object.values(gates).some((g) => g === true);
}

/**
 * The check function registered with the invariants gate.
 */
async function checkArchiveReasonInvariant(opts: InvariantRunOptions): Promise<InvariantResult> {
  const { tag, repoRoot, dryRun, cwd } = opts;

  const annotation = tagAnnotation(repoRoot, tag);
  const commitText = commitMessagesInTagRange(repoRoot, tag);
  const taskIds = extractTaskIds(`${annotation}\n${commitText}`);

  if (taskIds.length === 0) {
    return {
      id: ARCHIVE_REASON_INVARIANT_ID,
      severity: 'info',
      message: `tag ${tag}: no task IDs referenced in tag annotation or commit range`,
      processed: 0,
      reconciled: 0,
      unreconciled: 0,
      errors: 0,
      details: { tag, taskIds: [] },
    };
  }

  const accessor = await getAccessor(cwd ?? repoRoot);
  const reconciledIds: string[] = [];
  const unreconciledIds: string[] = [];
  const followUpIds: string[] = [];
  const noopAlreadyClosed: string[] = [];
  const noopNotFound: string[] = [];
  let errors = 0;

  for (let idx = 0; idx < taskIds.length; idx++) {
    const taskId = taskIds[idx] as string;
    try {
      const task = await accessor.loadSingleTask(taskId);

      if (!task) {
        noopNotFound.push(taskId);
        if (!dryRun) {
          appendReconcileAudit(repoRoot, {
            timestamp: new Date().toISOString(),
            tag,
            taskId,
            action: 'noop-not-found',
            note: 'commit referenced taskId but no row exists in tasks.db',
          });
        }
        continue;
      }

      // Already-closed (done / cancelled / archived) tasks are never re-stamped.
      if (task.status === 'done' || task.status === 'cancelled' || task.status === 'archived') {
        noopAlreadyClosed.push(taskId);
        if (!dryRun) {
          appendReconcileAudit(repoRoot, {
            timestamp: new Date().toISOString(),
            tag,
            taskId,
            action: 'noop-already-closed',
            note: `status='${task.status}' — no reconcile needed`,
          });
        }
        continue;
      }

      if (isFullyVerified(task)) {
        // Clean reconcile path — stamp done + archive_reason=verified + release=<tag>.
        // assertArchiveReason() rejects 'completed-unverified' (tombstone) per
        // T1409 contract; passing 'verified' is always safe.
        const reason: ArchiveReasonValue = ArchiveReason.enum.verified;
        assertArchiveReason(reason, taskId);

        if (!dryRun) {
          await accessor.transaction(async (tx) => {
            const nowIso = new Date().toISOString();
            // T877 invariant: status='done' requires pipeline_stage IN
            // ('contribution','cancelled'). Set explicitly so the trigger
            // does not reject the row.
            await tx.updateTaskFields(taskId, {
              status: 'done',
              pipelineStage: 'contribution',
              completedAt: nowIso,
              updatedAt: nowIso,
            });
            await tx.archiveSingleTask(taskId, {
              archivedAt: nowIso,
              archiveReason: reason,
            });
            // Persist release linkage for downstream reporting.
            await tx.setMetaValue(`reconcile.${taskId}.release`, tag);
          });
        }

        reconciledIds.push(taskId);
        if (!dryRun) {
          appendReconcileAudit(repoRoot, {
            timestamp: new Date().toISOString(),
            tag,
            taskId,
            action: 'reconciled',
            reason,
            note: `verification gates passed; stamped done + archive_reason=${reason}`,
          });
        }
        continue;
      }

      // Unreconciled — verification null, incomplete, or failed.
      // Create a follow-up task linked to the original.
      const followUpId = `T-RECONCILE-FOLLOWUP-${tag}-${idx}`;
      unreconciledIds.push(taskId);
      followUpIds.push(followUpId);

      if (!dryRun) {
        await accessor.upsertSingleTask({
          id: followUpId,
          title: `Reconcile ${taskId} for ${tag} (verification absent)`,
          description: `Auto-generated by archive-reason invariant after release ${tag}.\n\nThe parent task ${taskId} was referenced in a release commit but its verification record was null or incomplete. An operator should:\n  1. Inspect ${taskId} (\`cleo show ${taskId}\`)\n  2. Capture missing evidence with \`cleo verify\`\n  3. Re-run \`cleo reconcile release --tag ${tag}\` if applicable\n\nReference: ADR-056 D5 (post-release reconciliation).`,
          status: 'pending',
          priority: 'medium',
          createdAt: new Date().toISOString(),
          provenance: {
            createdBy: 'release-invariants:archive-reason',
            modifiedBy: 'release-invariants:archive-reason',
            sessionId: null,
          },
        });
        // `relates` is stored in the task_relations table, not on the task
        // row itself. addRelation() handles the cross-table insert.
        await accessor.addRelation(followUpId, taskId, 'related', `reconcile follow-up for ${tag}`);
      }

      if (!dryRun) {
        appendReconcileAudit(repoRoot, {
          timestamp: new Date().toISOString(),
          tag,
          taskId,
          action: 'followup-created',
          followUpTaskId: followUpId,
          note: 'verification null/incomplete; follow-up task created',
        });
      }
    } catch (err) {
      errors++;
      log.error({ err, tag, taskId }, 'archive-reason invariant raised on task');
    }
  }

  const severity = errors > 0 ? 'error' : unreconciledIds.length > 0 ? 'warning' : 'info';
  const message =
    `tag ${tag}: ${reconciledIds.length} reconciled, ${unreconciledIds.length} unreconciled, ` +
    `${noopAlreadyClosed.length} already-closed, ${noopNotFound.length} not-found, ${errors} errors` +
    (dryRun ? ' (dry-run)' : '');

  return {
    id: ARCHIVE_REASON_INVARIANT_ID,
    severity,
    message,
    processed: taskIds.length,
    reconciled: reconciledIds.length,
    unreconciled: unreconciledIds.length,
    errors,
    details: {
      tag,
      taskIds,
      reconciled: reconciledIds,
      unreconciled: unreconciledIds,
      followUp: followUpIds,
      noopAlreadyClosed,
      noopNotFound,
      dryRun,
    },
  };
}

/**
 * Register the archive-reason invariant. Called once on module load via
 * the side-effect import in `./index.ts`.
 */
export function registerArchiveReasonInvariant(): void {
  registerInvariant({
    id: ARCHIVE_REASON_INVARIANT_ID,
    description:
      'Stamp verified tasks referenced in tag commits as done; create follow-ups for unverified tasks.',
    severity: 'warning',
    check: checkArchiveReasonInvariant,
  });
}
