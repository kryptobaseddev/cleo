/**
 * Inspect and resolve the portable project identity (T12353 · ADR-094).
 *
 * `.cleo/project-id` is tracked and write-once. `project-info.json` holds the
 * id that local state is keyed by, and it is not tracked. T12325 made
 * `cleo init` report a disagreement between the two and keep the local id,
 * but left the operator without a way to see or fix it. This module is that
 * way:
 *
 * - {@link inspectProjectIdentity} is read-only. It classifies the pair, checks
 *   whether git actually tracks the file, and returns the exact remedy command.
 * - {@link resolveProjectIdentity} applies the remedy. For a conflict it
 *   re-keys the LOCAL side to the tracked id. The registry row's primary key
 *   and every alias pointing at the old id are updated in one registry
 *   transaction, and the old id is itself recorded as an alias. Nothing is
 *   deleted: rows elsewhere that still carry the old id (audit log, session
 *   manifest, background jobs) keep resolving through the alias table.
 *
 * The tracked file is never modified here. It is write-once, and a malformed
 * one is restored from version control, never regenerated.
 *
 * @task T12353
 * @see ADR-094 — write-once portable project identity (amends ADR-013 §9)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getCleoHome,
  isValidPortableProjectId,
  PORTABLE_PROJECT_ID_FILE,
  readPortableProjectId,
} from '@cleocode/paths';
import { ensurePortableProjectId } from '../scaffold/project-identity.js';

/** Command that reports identity state; the prefix of every remedy below. */
const IDENTITY_COMMAND = 'cleo doctor project-identity';

/**
 * Classification of a project's identity pair.
 *
 * - `ok` — both files agree, and git tracks `.cleo/project-id`.
 * - `uninitialized` — neither file exists.
 * - `not-adopted` — only the tracked file exists (a fresh clone before `cleo init`).
 * - `missing` — `project-info.json` has an id, but `.cleo/project-id` is absent.
 * - `conflict` — both exist and disagree.
 * - `invalid` — `.cleo/project-id` exists but cannot be parsed.
 * - `info-invalid` — `project-info.json` exists but has no usable id.
 * - `untracked` — the pair agrees, but git does not track the file yet.
 * - `ignored` — the pair agrees, but a gitignore rule excludes the file.
 */
export type ProjectIdentityState =
  | 'ok'
  | 'uninitialized'
  | 'not-adopted'
  | 'missing'
  | 'conflict'
  | 'invalid'
  | 'info-invalid'
  | 'untracked'
  | 'ignored';

/** Read-only report produced by {@link inspectProjectIdentity}. */
export interface ProjectIdentityInspection {
  /** Absolute project root that was inspected. */
  readonly projectRoot: string;
  /** Classification of the pair. */
  readonly state: ProjectIdentityState;
  /** Id in `.cleo/project-id`, when valid. */
  readonly trackedId: string | null;
  /** Id in `project-info.json`, when present. */
  readonly localId: string | null;
  /** One-line explanation. */
  readonly message: string;
  /** Exact command(s) that fix it, or `null` when nothing needs fixing. */
  readonly remedy: string | null;
}

/** One step {@link resolveProjectIdentity} took or would take. */
export interface IdentityResolutionStep {
  /** What the step does. */
  readonly action:
    | 'write-tracked-id'
    | 'rekey-registry-row'
    | 'repoint-aliases'
    | 'alias-old-id'
    | 'drop-inverted-alias'
    | 'rewrite-project-info';
  /** Human-readable detail with the ids and counts involved. */
  readonly detail: string;
}

/** Result of {@link resolveProjectIdentity}. */
export interface IdentityResolution {
  /** `true` when nothing was written. */
  readonly dryRun: boolean;
  /** State before resolving. */
  readonly before: ProjectIdentityInspection;
  /** Steps, in order. When `dryRun` is `true`, none of them were applied. */
  readonly steps: readonly IdentityResolutionStep[];
  /** Registry row count before and after; equal counts show no row was lost. */
  readonly registryRows: { readonly before: number; readonly after: number };
  /**
   * Why no steps were planned. Set when the state needs no resolution, or
   * when resolving is refused (the message then carries the remedy).
   */
  readonly refused: string | null;
}

/** Read the id and the whole object from `project-info.json`; `undefined` when absent. */
function readInfo(
  projectRoot: string,
): { data: Record<string, unknown>; id: string | null } | 'unparseable' | undefined {
  const path = join(projectRoot, '.cleo', 'project-info.json');
  if (!existsSync(path)) return undefined;
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const id = data['projectId'];
    return { data, id: typeof id === 'string' && isValidPortableProjectId(id) ? id : null };
  } catch {
    return 'unparseable';
  }
}

/** Git's view of the tracked file: `null` when this is not a git work tree. */
function gitFileState(projectRoot: string): 'tracked' | 'untracked' | 'ignored' | null {
  const rel = `.cleo/${PORTABLE_PROJECT_ID_FILE}`;
  const run = (args: string[]): boolean => {
    try {
      execFileSync('git', args, { cwd: projectRoot, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  };
  if (!run(['rev-parse', '--is-inside-work-tree'])) return null;
  if (run(['ls-files', '--error-unmatch', rel])) return 'tracked';
  if (run(['check-ignore', '-q', rel])) return 'ignored';
  return 'untracked';
}

/**
 * Classify the identity pair of a project, read-only.
 *
 * @param projectRoot - Absolute project root.
 * @returns The inspection with the exact remedy command.
 *
 * @example
 * ```ts
 * const report = inspectProjectIdentity('/repo');
 * if (report.remedy) console.log(report.remedy);
 * ```
 */
export function inspectProjectIdentity(projectRoot: string): ProjectIdentityInspection {
  const tracked = readPortableProjectId(projectRoot);
  const info = readInfo(projectRoot);
  const trackedId = tracked.status === 'valid' ? tracked.projectId : null;
  const localId = info && info !== 'unparseable' ? info.id : null;
  const base = { projectRoot, trackedId, localId };

  if (tracked.status === 'invalid') {
    return {
      ...base,
      state: 'invalid',
      message: `.cleo/project-id is unusable (${tracked.reason}). CLEO never regenerates it.`,
      remedy:
        'git checkout -- .cleo/project-id   (restore the committed id; inspect with `git log -p -- .cleo/project-id`)',
    };
  }
  if (info === undefined) {
    return trackedId
      ? {
          ...base,
          state: 'not-adopted',
          message: `.cleo/project-id declares ${trackedId}, but this checkout has not been initialized.`,
          remedy: 'cleo init   (adopts the tracked id; it never mints a new one)',
        }
      : {
          ...base,
          state: 'uninitialized',
          message:
            'No project identity: neither .cleo/project-info.json nor .cleo/project-id exists.',
          remedy: 'cleo init',
        };
  }
  if (!localId) {
    return {
      ...base,
      state: 'info-invalid',
      message: '.cleo/project-info.json has no usable projectId.',
      remedy: `${IDENTITY_COMMAND} --resolve   (takes the tracked id, or re-links from the registry)`,
    };
  }
  if (!trackedId) {
    return {
      ...base,
      state: 'missing',
      message: `.cleo/project-id is missing. The local id is ${localId}.`,
      remedy: `${IDENTITY_COMMAND} --resolve && git add .cleo/project-id && git commit -m "chore: track CLEO project id"`,
    };
  }
  if (trackedId !== localId) {
    return {
      ...base,
      state: 'conflict',
      message: `Identity conflict: .cleo/project-id is ${trackedId}, but project-info.json is ${localId}. Two lineages; local state is still keyed by ${localId}.`,
      remedy: `${IDENTITY_COMMAND} --resolve --dry-run   then   ${IDENTITY_COMMAND} --resolve   (re-keys local state to ${trackedId}; ${localId} stays resolvable as an alias)`,
    };
  }
  const git = gitFileState(projectRoot);
  if (git === 'ignored') {
    return {
      ...base,
      state: 'ignored',
      message:
        '.cleo/project-id is gitignored, so clones cannot inherit it. The .cleo/.gitignore predates ADR-094.',
      remedy:
        'cleo upgrade   (refreshes .cleo/.gitignore with `!project-id`), then git add .cleo/project-id',
    };
  }
  if (git === 'untracked') {
    return {
      ...base,
      state: 'untracked',
      message: '.cleo/project-id is not committed yet, so clones cannot inherit it.',
      remedy: 'git add .cleo/project-id && git commit -m "chore: track CLEO project id"',
    };
  }
  return {
    ...base,
    state: 'ok',
    message: `Project identity ${trackedId} is tracked and consistent.`,
    remedy: null,
  };
}

/** Write JSON atomically (tmp + rename) so a crash never leaves a half file. */
function writeJsonAtomic(path: string, data: Record<string, unknown>): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Options for {@link resolveProjectIdentity}. */
export interface ResolveProjectIdentityOptions {
  /** Plan only; write nothing. */
  dryRun?: boolean;
  /** Global CLEO home whose registry is re-keyed (defaults to the current one). */
  cleoHome?: string;
}

/**
 * Resolve the identity state that {@link inspectProjectIdentity} reported.
 *
 * - `missing` writes `.cleo/project-id` from the local id (create-only).
 * - `info-invalid` re-runs the scaffold decision (tracked id or registry re-link).
 * - `conflict` re-keys local state to the tracked id. One registry transaction
 *   renames the row's primary key, re-points aliases and records the old id as
 *   an alias. Then `project-info.json` is rewritten, keeping the old id under
 *   `previousProjectIds`.
 *
 * Every other state is refused with its remedy. The operation is idempotent:
 * re-running after a partial apply completes the remaining steps.
 *
 * @param projectRoot - Absolute project root.
 * @param options - `dryRun` and registry home.
 * @returns The plan (dry run) or the applied steps, with registry row counts.
 *
 * @example
 * ```ts
 * const plan = await resolveProjectIdentity(root, { dryRun: true });
 * if (!plan.refused) await resolveProjectIdentity(root);
 * ```
 */
export async function resolveProjectIdentity(
  projectRoot: string,
  options: ResolveProjectIdentityOptions = {},
): Promise<IdentityResolution> {
  const dryRun = options.dryRun === true;
  const before = inspectProjectIdentity(projectRoot);
  const steps: IdentityResolutionStep[] = [];
  const result = (
    refused: string | null,
    rows: { before: number; after: number } = { before: 0, after: 0 },
  ): IdentityResolution => ({ dryRun, before, steps, registryRows: rows, refused });

  if (before.state === 'missing' && before.localId) {
    steps.push({
      action: 'write-tracked-id',
      detail: `create .cleo/project-id = ${before.localId}`,
    });
    if (!dryRun) await ensurePortableProjectId(projectRoot, before.localId);
    return result(null);
  }
  if (before.state === 'info-invalid') {
    steps.push({
      action: 'rewrite-project-info',
      detail: 'regenerate the project-info.json id from .cleo/project-id or the registry',
    });
    if (!dryRun) {
      const { ensureProjectInfo } = await import('../scaffold/ensure-config.js');
      await ensureProjectInfo(projectRoot, { force: true });
    }
    return result(null);
  }
  if (before.state !== 'conflict' || !before.trackedId || !before.localId) {
    return result(
      before.remedy ? `${before.message} Remedy: ${before.remedy}` : 'Nothing to resolve.',
    );
  }

  const oldId = before.localId;
  const newId = before.trackedId;
  const { getNexusRegistryDb } = await import('../store/nexus-sqlite.js');
  const { projectIdAliases, projectRegistry } = await import('../store/schema/nexus-schema.js');
  const { eq } = await import('drizzle-orm');
  const db = await getNexusRegistryDb(options.cleoHome ?? getCleoHome());
  const countRows = (): number => db.select().from(projectRegistry).all().length;
  const rowsBefore = countRows();

  const oldRow = db
    .select()
    .from(projectRegistry)
    .where(eq(projectRegistry.projectId, oldId))
    .get();
  const newRow = db
    .select()
    .from(projectRegistry)
    .where(eq(projectRegistry.projectId, newId))
    .get();
  if (oldRow && newRow) {
    return result(
      `Both ids are registered on this device: ${oldId} at ${oldRow.projectPath} and ${newId} at ${newRow.projectPath}. ` +
        'One registry row cannot hold two paths. ' +
        `Remedy: if ${newRow.projectPath} is gone or is a stale checkout, run \`cleo nexus unregister ${newId}\` and then re-run \`${IDENTITY_COMMAND} --resolve\`.`,
      { before: rowsBefore, after: rowsBefore },
    );
  }
  const newIdAlias = db
    .select()
    .from(projectIdAliases)
    .where(eq(projectIdAliases.legacyId, newId))
    .get();
  if (newIdAlias && newIdAlias.canonicalId !== oldId && newIdAlias.canonicalId !== newId) {
    return result(
      `${newId} is already an alias of a third identity (${newIdAlias.canonicalId}). Refusing to re-key. ` +
        `Remedy: inspect with \`cleo nexus show ${newIdAlias.canonicalId}\` before retrying.`,
      { before: rowsBefore, after: rowsBefore },
    );
  }
  const repointed = db
    .select()
    .from(projectIdAliases)
    .where(eq(projectIdAliases.canonicalId, oldId))
    .all();

  if (oldRow)
    steps.push({
      action: 'rekey-registry-row',
      detail: `registry row ${oldId} -> ${newId} (path ${oldRow.projectPath} kept)`,
    });
  if (newIdAlias?.canonicalId === oldId)
    steps.push({
      action: 'drop-inverted-alias',
      detail: `alias ${newId} -> ${oldId} (it would point the new id at the old one)`,
    });
  steps.push({
    action: 'repoint-aliases',
    detail: `${repointed.length} alias row(s) canonical ${oldId} -> ${newId}`,
  });
  steps.push({ action: 'alias-old-id', detail: `alias ${oldId} -> ${newId}` });
  steps.push({
    action: 'rewrite-project-info',
    detail: `project-info.json projectId ${oldId} -> ${newId} (previousProjectIds keeps ${oldId})`,
  });
  if (dryRun) return result(null, { before: rowsBefore, after: rowsBefore });

  const now = new Date().toISOString();
  db.transaction(
    (tx) => {
      if (oldRow)
        tx.update(projectRegistry)
          .set({ projectId: newId })
          .where(eq(projectRegistry.projectId, oldId))
          .run();
      if (newIdAlias?.canonicalId === oldId)
        tx.delete(projectIdAliases).where(eq(projectIdAliases.legacyId, newId)).run();
      tx.update(projectIdAliases)
        .set({ canonicalId: newId })
        .where(eq(projectIdAliases.canonicalId, oldId))
        .run();
      const oldAlias = tx
        .select()
        .from(projectIdAliases)
        .where(eq(projectIdAliases.legacyId, oldId))
        .get();
      if (!oldAlias)
        tx.insert(projectIdAliases)
          .values({ legacyId: oldId, canonicalId: newId, createdAt: now })
          .run();
    },
    { behavior: 'immediate' },
  );

  const info = readInfo(projectRoot);
  if (info && info !== 'unparseable') {
    const previous = Array.isArray(info.data['previousProjectIds'])
      ? info.data['previousProjectIds'].filter((id): id is string => typeof id === 'string')
      : [];
    writeJsonAtomic(join(projectRoot, '.cleo', 'project-info.json'), {
      ...info.data,
      projectId: newId,
      previousProjectIds: [...new Set([...previous, oldId])],
      lastUpdated: now,
    });
  }
  return result(null, { before: rowsBefore, after: countRows() });
}
