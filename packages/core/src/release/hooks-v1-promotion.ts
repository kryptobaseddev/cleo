/**
 * Release-plan guard for the hooks-v1 gate (T13555).
 *
 * Since T13557 a stable build runs project hooks only when the promotion
 * release stamps `cleo.releasedFeatures: ["hooks-v1"]`, which only a plan with
 * `--hooks-v1-promotion` does, and that plan must pass the pilot evidence
 * gate. The remaining way to ship hooks-v1 without the evidence is a SOURCE
 * edit that opens the gate: dropping `hooks-v1` from `UNRELEASED_HOOK_FEATURES`,
 * changing `hooksV1Released`, or deleting `release-gate.ts`. This module
 * detects such an edit between the previous release tag and HEAD; the plan then
 * requires `--hooks-v1-promotion` or an explicit, audited `--hooks-v1-waiver`.
 *
 * Reads git only; never edits `release-gate.ts` or the pilot digest script.
 *
 * @task T13555
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runGitWithLockRetry } from './engine-ops.js';

/** The hooks-v1 release gate's source, relative to the repository root. */
export const HOOKS_V1_GATE_PATH = 'packages/core/src/hooks/release-gate.ts';

/** Append-only audit of every hooks-v1 waiver a plan used. */
export const HOOKS_V1_WAIVER_AUDIT_FILE = '.cleo/audit/hooks-v1-waiver.jsonl';

/** The gate file at a revision, or `null` when it does not exist there. */
function gateSourceAt(projectRoot: string, rev: string): string | null {
  try {
    return runGitWithLockRetry(['show', `${rev}:${HOOKS_V1_GATE_PATH}`], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 60_000,
    });
  } catch {
    return null;
  }
}

/** The `hooksV1Released` declaration through its closing brace, or `null`. */
function releasedFunction(source: string): string | null {
  return /export function hooksV1Released\([\s\S]*?\n\}\n/.exec(source)?.[0] ?? null;
}

/** True when the source keeps `hooks-v1` in `UNRELEASED_HOOK_FEATURES`. */
function keepsHooksUnreleased(source: string): boolean {
  const set = /UNRELEASED_HOOK_FEATURES\b[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(source)?.[1];
  return set !== undefined && /['"]hooks-v1['"]/.test(set);
}

/**
 * How the source between a release tag and HEAD opens the hooks-v1 gate.
 *
 * @param projectRoot - Repository root.
 * @param previousTag - The previous release tag.
 * @returns One line per gate-opening change; empty when the gate is untouched.
 */
export function hooksV1GateSourceChanges(projectRoot: string, previousTag: string): string[] {
  const before = gateSourceAt(projectRoot, previousTag);
  const after = gateSourceAt(projectRoot, 'HEAD');
  if (before === null && after === null) return [];
  if (after === null) return [`${HOOKS_V1_GATE_PATH} was deleted`];
  const changes: string[] = [];
  if (!keepsHooksUnreleased(after) && (before === null || keepsHooksUnreleased(before)))
    changes.push("'hooks-v1' left UNRELEASED_HOOK_FEATURES");
  if (before !== null && releasedFunction(before) !== releasedFunction(after))
    changes.push('hooksV1Released changed');
  return changes;
}

/** Options of {@link appendHooksV1Waiver}. */
export interface HooksV1WaiverRecordOptions {
  /** Repository root. */
  readonly projectRoot: string;
  /** The planned version. */
  readonly version: string;
  /** The previous release tag the changes were measured from. */
  readonly previousTag: string;
  /** The operator's reason. */
  readonly reason: string;
  /** The waived gate-opening changes. */
  readonly changes: readonly string[];
}

/**
 * Record a used waiver in {@link HOOKS_V1_WAIVER_AUDIT_FILE}.
 *
 * @param opts - What was waived, and why.
 * @remarks Throws on a write failure: a waiver that cannot be audited is refused.
 */
export function appendHooksV1Waiver(opts: HooksV1WaiverRecordOptions): void {
  const path = join(opts.projectRoot, HOOKS_V1_WAIVER_AUDIT_FILE);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      version: opts.version,
      previousTag: opts.previousTag,
      operator: process.env['USER'] ?? 'unknown',
      reason: opts.reason,
      changes: opts.changes,
    })}\n`,
    'utf-8',
  );
}
