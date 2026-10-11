/**
 * Binding a `qa-run:` receipt — a recorded native typecheck or lint run — to
 * the change it claims to check (T13427, design note
 * `t13427-qa-run-binding-design`, owner decision option 1).
 *
 * What a bound atom guarantees, exactly:
 *  1. **Result.** The receipt states exit code 0 and zero error diagnostics.
 *  2. **Freshness.** The same clock as `test-run:` ({@link reportFreshness}):
 *     the run is not older than the change's commits, edits or deletions.
 *  3. **Coverage.** Every changed code path (evidence-scoped, docs ignored)
 *     lies under one of the receipt's `roots`; in a workspace, every package
 *     that depends on a changed package is covered by a root at or above its
 *     directory, since a type change breaks importers. A workspace-wide change
 *     (a path outside every package) is refused: only a whole-project run
 *     speaks for it.
 *  4. **Identity.** HEAD and the tool-cache tree hash are recorded by the
 *     validator; `cleo complete` refuses the atom once the tree moves, unless
 *     merged CI carries the gate.
 *
 * With no origin default branch to diff against (no merge base), nothing is
 * judged beyond the result: the receipt binds with no coverage check, as a
 * `test-run:` report does there.
 *
 * It does NOT prove the run happened (a receipt is a file the caller
 * supplies), and a scoped typecheck does not see unchanged files outside its
 * roots that import a changed export. Merged CI (`ci:<pr>`) or a whole-project
 * `tool:typecheck` speaks for the whole program.
 *
 * @task T13427
 */

import { isAbsolute } from 'node:path';
import { isCiDocumentPath } from '../release/ci-evidence.js';
import {
  deriveAffectedPackages,
  inPackageDir,
  listWorkspacePackages,
} from './affected-packages.js';
import { reportFreshness } from './test-run-binding.js';

/** The QA checks a receipt can record: one of each satisfies `qaPassed`. */
export const QA_RUN_KINDS = ['typecheck', 'lint'] as const;

/** A QA check a receipt records. */
export type QaRunKind = (typeof QA_RUN_KINDS)[number];

/** A receipt that passed shape validation. */
export interface QaRunReceipt {
  /** Which check ran. */
  kind: QaRunKind;
  /** The argv that ran. */
  command: string[];
  /** Root-relative directories or files the run covered (`''` = the whole root). */
  roots: string[];
  /** Epoch ms the run started, when stated. */
  startTime?: number;
  /** Tool name, when stated. */
  toolName?: string;
  /** Tool version, when stated. */
  toolVersion?: string;
}

/** The receipt, or why its shape is refused. */
export type QaRunParse =
  | { ok: true; receipt: QaRunReceipt }
  | {
      ok: false;
      codeName: 'E_EVIDENCE_INVALID' | 'E_EVIDENCE_TOOL_FAILED';
      reason: string;
    };

/** Example shape, named in every refusal. */
export const QA_RUN_SHAPE_HINT =
  '{"kind":"typecheck"|"lint","command":["tsc","--noEmit",…],"exitCode":0,' +
  '"diagnostics":{"errors":0},"roots":["src/a"],"startTime":<epoch ms>}';

/** A root as the binding compares it: slash-separated, no `./`, no trailing `/`; `.` is `''`. */
function normaliseRoot(root: string): string {
  const slashed = root.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return slashed === '.' ? '' : slashed;
}

/**
 * Validate a parsed receipt's shape and result.
 *
 * @param raw - The parsed JSON.
 * @returns The receipt, or the refusal.
 * @task T13427
 */
export function parseQaRunReceipt(raw: unknown): QaRunParse {
  const invalid = (reason: string): QaRunParse => ({
    ok: false,
    codeName: 'E_EVIDENCE_INVALID',
    reason: `${reason}. Expected: ${QA_RUN_SHAPE_HINT}`,
  });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return invalid('qa-run receipt is not a JSON object');
  }
  const r = raw as Record<string, unknown>;
  const kind = r['kind'];
  if (kind !== 'typecheck' && kind !== 'lint') {
    return invalid(
      `qa-run receipt's "kind" is ${JSON.stringify(kind)}; it must be "typecheck" or "lint"`,
    );
  }
  const command = r['command'];
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((w): w is string => typeof w === 'string' && w !== '')
  ) {
    return invalid('qa-run receipt\'s "command" must be a non-empty array of strings');
  }
  const exitCode = r['exitCode'];
  if (typeof exitCode !== 'number' || !Number.isInteger(exitCode)) {
    return invalid('qa-run receipt\'s "exitCode" must be an integer');
  }
  const diagnostics = r['diagnostics'];
  const errors =
    diagnostics !== null && typeof diagnostics === 'object' && !Array.isArray(diagnostics)
      ? (diagnostics as Record<string, unknown>)['errors']
      : undefined;
  if (typeof errors !== 'number' || !Number.isInteger(errors) || errors < 0) {
    return invalid('qa-run receipt\'s "diagnostics.errors" must be a non-negative integer');
  }
  if (exitCode !== 0 || errors !== 0) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_TOOL_FAILED',
      reason: `qa-run ${kind} receipt reports exit code ${exitCode} with ${errors} error diagnostic(s); it must pass with none`,
    };
  }
  const roots = r['roots'];
  if (
    !Array.isArray(roots) ||
    roots.length === 0 ||
    !roots.every((p): p is string => typeof p === 'string' && p.trim() !== '')
  ) {
    return invalid('qa-run receipt\'s "roots" must be a non-empty array of root-relative paths');
  }
  const outside = roots.find((p) => {
    const n = normaliseRoot(p);
    return isAbsolute(p) || n === '..' || n.startsWith('../');
  });
  if (outside !== undefined) {
    return invalid(
      `qa-run receipt root ${JSON.stringify(outside)} is not relative to the project root`,
    );
  }
  const startTime = r['startTime'];
  if (startTime !== undefined && (typeof startTime !== 'number' || !Number.isFinite(startTime))) {
    return invalid('qa-run receipt\'s "startTime" must be epoch milliseconds');
  }
  const tool = r['tool'];
  const toolField = (field: string): string | undefined => {
    const v =
      tool !== null && typeof tool === 'object' && !Array.isArray(tool)
        ? (tool as Record<string, unknown>)[field]
        : undefined;
    return typeof v === 'string' && v !== '' ? v : undefined;
  };
  const toolName = toolField('name');
  const toolVersion = toolField('version');
  return {
    ok: true,
    receipt: {
      kind,
      command,
      roots: [...new Set(roots.map(normaliseRoot))].sort(),
      ...(typeof startTime === 'number' ? { startTime } : {}),
      ...(toolName ? { toolName } : {}),
      ...(toolVersion ? { toolVersion } : {}),
    },
  };
}

/** What binding a receipt decided. */
export type QaRunBinding =
  | {
      ok: false;
      codeName: 'E_EVIDENCE_STALE' | 'E_EVIDENCE_INSUFFICIENT';
      reason: string;
    }
  | { ok: true };

/** Up to five items, then a count. */
function some(items: readonly string[]): string {
  return `${items.slice(0, 5).join(', ')}${items.length > 5 ? `, … (${items.length})` : ''}`;
}

/**
 * Bind a receipt to the change it claims to check, or refuse it when it is
 * older than the change or does not cover it (see the module doc).
 *
 * @param receipt - From {@link parseQaRunReceipt}.
 * @param receiptPath - Absolute path of the receipt file.
 * @param root - The task's checkout.
 * @returns The refusal, or ok.
 * @task T13427
 */
export function bindQaRunReceipt(
  receipt: QaRunReceipt,
  receiptPath: string,
  root: string,
): QaRunBinding {
  const fresh = reportFreshness(receipt.startTime, receiptPath, root, 'qa-run');
  if (!fresh.ok) return fresh;
  const refuse = (reason: string): QaRunBinding => ({
    ok: false,
    codeName: 'E_EVIDENCE_INSUFFICIENT',
    reason,
  });
  const changes = fresh.changes;
  // A change whose every path is set aside as out of scope must not pass
  // vacuously (as for test-run, T13135).
  if (changes !== null && changes.paths.length === 0 && changes.excluded.length > 0) {
    return refuse(
      `Every path this change touches is excluded from evidence scope (${some(changes.excluded)}), ` +
        `so a qa-run ${receipt.kind} receipt cannot speak for it. Record tool:${receipt.kind}, or ci:<pr> once the PR merges.`,
    );
  }
  const changed = changes?.paths ?? [];
  if (!fresh.judged || changed.length === 0) return { ok: true };
  const scope = deriveAffectedPackages(root, changed);
  if (scope.scope === 'full') {
    return refuse(
      `The change is workspace-wide (${scope.reason}), so only a whole-project ${receipt.kind} ` +
        `speaks for it. Record tool:${receipt.kind}, or ci:<pr> once the PR merges.`,
    );
  }
  const covered = (path: string): boolean =>
    receipt.roots.some((r) => r === path || inPackageDir(path, r));
  const uncovered = changed.filter((p) => !isCiDocumentPath(p) && !covered(p));
  if (uncovered.length > 0) {
    return refuse(
      `qa-run ${receipt.kind} receipt (roots ${some(receipt.roots.map((r) => r || '.'))}) does not ` +
        `cover the changed path(s) ${some(uncovered)}. Run ${receipt.kind} over roots that hold ` +
        `every changed file, or record tool:${receipt.kind}.`,
    );
  }
  // A type change breaks importers: a dependent package must be checked too.
  const dependents = scope.packages.filter((name) => !scope.direct.includes(name));
  if (dependents.length > 0) {
    const workspace = listWorkspacePackages(root);
    const unchecked = dependents.filter((name) => {
      const dir = workspace.find((p) => p.name === name)?.dir;
      return dir === undefined || !covered(dir);
    });
    if (unchecked.length > 0) {
      return refuse(
        `qa-run ${receipt.kind} receipt does not cover package(s) ${some(unchecked)}, which depend ` +
          `on a changed package. Add their directories to the run's roots, or record tool:${receipt.kind}.`,
      );
    }
  }
  return { ok: true };
}
