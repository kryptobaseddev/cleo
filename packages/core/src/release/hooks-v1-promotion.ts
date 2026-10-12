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

/** A tracked file at a revision, or `null` when it does not exist there. */
function fileAt(projectRoot: string, rev: string, path: string): string | null {
  try {
    return runGitWithLockRetry(['show', `${rev}:${path}`], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 60_000,
    });
  } catch {
    return null;
  }
}

/** True when the release at `tag` was the hooks-v1 promotion, per its committed plan. */
function promotedAt(projectRoot: string, tag: string): boolean {
  const plan = fileAt(projectRoot, tag, `.cleo/release/${tag}.plan.json`);
  try {
    return (
      plan !== null &&
      (JSON.parse(plan) as { hooksV1Promotion?: unknown }).hooksV1Promotion === true
    );
  } catch {
    return false;
  }
}

/** What {@link parseHooksV1Gate} recognised in a gate source; `null` where the shape is unrecognised. */
export interface HooksV1GateShape {
  /** Whether `UNRELEASED_HOOK_FEATURES` still lists `hooks-v1`. */
  readonly unreleased: boolean | null;
  /** The `hooksV1Released` declaration through its closing brace. */
  readonly released: string | null;
}

/**
 * Recognise the two gate facts in a `release-gate.ts` source.
 *
 * @param source - The file's text.
 * @returns Each fact, or `null` for a shape the detector does not recognise.
 */
export function parseHooksV1Gate(source: string): HooksV1GateShape {
  // `new Set()` with no array literal is an empty set: hooks-v1 released.
  const set = /UNRELEASED_HOOK_FEATURES\b[^=]*=\s*new Set(?:<[^>]*>)?\((?:\[([^\]]*)\])?\)/.exec(
    source,
  );
  return {
    unreleased: set === null ? null : /['"]hooks-v1['"]/.test(set[1] ?? ''),
    released: /export function hooksV1Released\([\s\S]*?\n\}\n/.exec(source)?.[0] ?? null,
  };
}

/**
 * How the source between a release tag and HEAD opens the hooks-v1 gate.
 * Fails closed: a gate shape the detector cannot read counts as opening it.
 *
 * @param projectRoot - Repository root.
 * @param previousTag - The previous release tag.
 * @returns One line per gate-opening change; empty when the gate is untouched,
 * `previousTag` was the promotion (its committed plan sets `hooksV1Promotion`),
 * or `previousTag` already shipped `hooks-v1` released by source.
 */
export function hooksV1GateSourceChanges(projectRoot: string, previousTag: string): string[] {
  // After the promotion the gate is open by release metadata; removing it is the cleanup.
  if (promotedAt(projectRoot, previousTag)) return [];
  const before = fileAt(projectRoot, previousTag, HOOKS_V1_GATE_PATH);
  const after = fileAt(projectRoot, 'HEAD', HOOKS_V1_GATE_PATH);
  if (before === null && after === null) return [];
  const was = before === null ? null : parseHooksV1Gate(before);
  // The previous release already shipped the gate open by source: nothing left to guard.
  if (was?.unreleased === false) return [];
  if (after === null) return [`${HOOKS_V1_GATE_PATH} was deleted`];
  const now = parseHooksV1Gate(after);
  if (now.unreleased === null || now.released === null)
    return [`${HOOKS_V1_GATE_PATH} has a gate shape the release guard cannot read`];
  const changes: string[] = [];
  if (!now.unreleased) changes.push("'hooks-v1' left UNRELEASED_HOOK_FEATURES");
  if (was !== null && was.released !== now.released) changes.push('hooksV1Released changed');
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
