/**
 * `cleo docs modernize` entry point (T14113): one call for the dry run, the
 * apply and the rollback, so the dispatch handler stays a pass-through.
 *
 * @task T14113
 * @epic T14106
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type {
  DocsModernizeOverrides,
  DocsModernizePlan,
  DocsModernizeReceipt,
} from '@cleocode/contracts';
import { writeFileAtomic } from '../../tools/fs.js';
import { applyDocsModernize, DocsModernizeReceiptError, rollbackDocsModernize } from './apply.js';
import { parseModernizePlan } from './guard.js';
import { type PlanDocsModernizeOptions, planDocsModernize } from './plan.js';

export {
  applyDocsModernize,
  DocsModernizeBlobError,
  DocsModernizeDirtyError,
  DocsModernizeReceiptError,
  DocsModernizeStaleError,
  modernizeReceiptPath,
  readDocsModernizeReceipt,
  rollbackDocsModernize,
} from './apply.js';
export { DocsModernizeOverrideError, planDocsModernize } from './plan.js';

/** Parameters of `docs.modernize`. */
export interface RunDocsModernizeParams {
  /** Folder to modernize (relative to the project root, or absolute). Required unless `rollback`. */
  readonly path?: string;
  /** Execute the plan; otherwise the run is a dry run. */
  readonly apply?: boolean;
  /** Apply this saved plan JSON verbatim instead of re-planning. */
  readonly planFile?: string;
  /** Write the dry-run plan JSON here. */
  readonly out?: string;
  /** Roll back the run with this id. */
  readonly rollback?: string;
  /** Extra folder names to skip. */
  readonly exclude?: readonly string[];
  /** Override JSON (`DocsModernizeOverrides`), keyed by root-relative path. */
  readonly overrides?: string;
  /** Use this kind for every file instead of classifying. */
  readonly kind?: string;
  /** Ingest every file into the store and leave the folder untouched. */
  readonly storeOnly?: boolean;
  /** Apply even when the root is not a clean git checkout. */
  readonly allowDirty?: boolean;
  /** Modernize the docs already in the store (re-kind, re-slug, ADR numbers) instead of a folder. */
  readonly store?: boolean;
}

/** Result of {@link runDocsModernize}. */
export interface RunDocsModernizeResult {
  /** What ran. */
  readonly mode: 'dry-run' | 'apply' | 'rollback';
  /** The plan (dry run and apply). */
  readonly plan: DocsModernizePlan | null;
  /** Where the plan was saved, when `out` was given. */
  readonly planPath: string | null;
  /** The receipt (apply and rollback). */
  readonly receipt: DocsModernizeReceipt | null;
}

/**
 * Run `cleo docs modernize`.
 *
 * @param projectRoot - Project root.
 * @param params - Path and mode flags.
 * @param overrides - System One and clock overrides (tests).
 * @returns What ran, with its plan and/or receipt.
 */
export async function runDocsModernize(
  projectRoot: string,
  params: RunDocsModernizeParams,
  overrides: Pick<PlanDocsModernizeOptions, 'mode' | 'decide' | 'now'> & {
    readonly allowDirty?: boolean;
  } = {},
): Promise<RunDocsModernizeResult> {
  if (params.rollback) {
    const receipt = await rollbackDocsModernize(projectRoot, params.rollback, overrides.now);
    return { mode: 'rollback', plan: null, planPath: null, receipt };
  }
  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(projectRoot, p));
  let plan: DocsModernizePlan;
  if (params.planFile) {
    const file = abs(params.planFile);
    if (!existsSync(file)) {
      // @sync-invariant none:input-shape a missing plan file is refused before any write
      throw new DocsModernizeReceiptError(`plan file ${params.planFile} does not exist`);
    }
    plan = parseModernizePlan(readFileSync(file, 'utf-8'), projectRoot);
  } else if (params.store) {
    const { planDocsStoreModernize } = await import('./store.js');
    plan = await planDocsStoreModernize({ projectRoot, ...overrides });
  } else {
    if (!params.path || !existsSync(abs(params.path))) {
      // @sync-invariant none:input-shape a missing modernize root is refused before any write
      throw new DocsModernizeReceiptError(
        `modernize root ${params.path ?? '(none)'} does not exist`,
      );
    }
    let reviewed: DocsModernizeOverrides | undefined;
    if (params.overrides) {
      const file = abs(params.overrides);
      if (!existsSync(file)) {
        // @sync-invariant none:input-shape a missing overrides file is refused before any write
        throw new DocsModernizeReceiptError(`overrides file ${params.overrides} does not exist`);
      }
      reviewed = JSON.parse(readFileSync(file, 'utf-8')) as DocsModernizeOverrides;
    }
    plan = await planDocsModernize({
      root: abs(params.path),
      projectRoot,
      exclude: params.exclude,
      overrides: reviewed,
      kind: params.kind,
      storeOnly: params.storeOnly,
      ...overrides,
    });
  }
  let planPath: string | null = null;
  if (params.out) {
    planPath = abs(params.out);
    await writeFileAtomic({ path: planPath, content: `${JSON.stringify(plan, null, 2)}\n` });
  }
  if (!params.apply) return { mode: 'dry-run', plan, planPath, receipt: null };
  if (plan.mode === 'store') {
    const { applyDocsStoreModernize } = await import('./store.js');
    const receipt = await applyDocsStoreModernize(plan, projectRoot, overrides.now);
    return { mode: 'apply', plan, planPath, receipt };
  }
  const receipt = await applyDocsModernize({
    plan,
    projectRoot,
    now: overrides.now,
    allowDirty: params.allowDirty === true || overrides.allowDirty === true,
  });
  return { mode: 'apply', plan, planPath, receipt };
}
