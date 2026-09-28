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
 * T12557: `projectRoot` is a path fact, derived from the real root at runtime.
 * A persisted copy in `project-info.json` or `project-context.json` goes stale
 * on every move, so the inspection lists it under `derivedFields` and
 * `--resolve` strips it. Each removed value is kept in `project-info.json`
 * under `strippedFields`, the same in-file receipt pattern as
 * `previousProjectIds`. `projectHash` is NOT a path fact: it is a write-once
 * identity key, and nothing here ever touches it.
 *
 * @task T12353
 * @task T12557
 * @see ADR-094 — write-once portable project identity (amends ADR-013 §9)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalizePath,
  getCleoHome,
  isValidPortableProjectId,
  PORTABLE_PROJECT_ID_FILE,
  readDeclaredProjectIdentity,
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

/** A persisted path fact in a metadata file (T12557). */
export interface DerivedFieldFinding {
  /** File under `.cleo/` that carries the field. */
  readonly file: 'project-info.json' | 'project-context.json';
  /** The field name. */
  readonly field: 'projectRoot';
  /** The persisted value, kept so a strip receipt can restore it. */
  readonly value: unknown;
}

/** Files that must not persist path-derived fields. */
const DERIVED_FIELD_FILES: readonly DerivedFieldFinding['file'][] = [
  'project-info.json',
  'project-context.json',
];

/**
 * Path facts derived from the real root at runtime, never authoritative on
 * disk. `projectHash` is deliberately absent: it is a write-once identity key.
 */
const DERIVED_FIELDS: readonly DerivedFieldFinding['field'][] = ['projectRoot'];

/** Schema `maxItems` for the `previousProjectIds` / `strippedFields` receipts; oldest drop first. */
const RECEIPT_MAX_ITEMS = 50;

/** Bound every git probe: briefing runs this inspection on each call. */
const GIT_PROBE_TIMEOUT_MS = 5000;

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
  /**
   * Legacy path-derived fields persisted on disk (T12557). They are ignored at
   * runtime and do not change `state`; `--resolve` strips them.
   */
  readonly derivedFields: readonly DerivedFieldFinding[];
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
    | 'rewrite-project-info'
    | 'confirm-candidate-location'
    | 'strip-derived-fields';
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

/** Read a `.cleo/` JSON object; `undefined` when absent or not an object. */
function readCleoJson(projectRoot: string, file: string): Record<string, unknown> | undefined {
  const path = join(projectRoot, '.cleo', file);
  if (!existsSync(path)) return undefined;
  try {
    const data: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return data !== null && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** List persisted path-derived fields across the metadata files (T12557). */
function findDerivedFields(projectRoot: string): DerivedFieldFinding[] {
  const found: DerivedFieldFinding[] = [];
  for (const file of DERIVED_FIELD_FILES) {
    const data = readCleoJson(projectRoot, file);
    if (!data) continue;
    for (const field of DERIVED_FIELDS)
      if (field in data) found.push({ file, field, value: data[field] });
  }
  return found;
}

/** Git's view of the tracked file: `null` when this is not a git work tree. */
function gitFileState(projectRoot: string): 'tracked' | 'untracked' | 'ignored' | null {
  const rel = `.cleo/${PORTABLE_PROJECT_ID_FILE}`;
  const run = (args: string[]): boolean => {
    try {
      execFileSync('git', args, { cwd: projectRoot, stdio: 'pipe', timeout: GIT_PROBE_TIMEOUT_MS });
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
  const base = { projectRoot, trackedId, localId, derivedFields: findDerivedFields(projectRoot) };
  // A CLEO root need not be a git work tree; git remedies apply only inside one.
  let git: ReturnType<typeof gitFileState> | undefined;
  const gitState = (): ReturnType<typeof gitFileState> => {
    if (git === undefined) git = gitFileState(projectRoot);
    return git;
  };

  if (tracked.status === 'invalid') {
    return {
      ...base,
      state: 'invalid',
      message: `.cleo/project-id is unusable (${tracked.reason}). CLEO never regenerates it.`,
      remedy:
        gitState() === null
          ? 'restore .cleo/project-id from a backup of this project (the CLEO root is not a git work tree)'
          : 'git checkout -- .cleo/project-id   (restore the committed id; inspect with `git log -p -- .cleo/project-id`)',
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
      remedy:
        gitState() === null
          ? `${IDENTITY_COMMAND} --resolve   (the CLEO root is not a git work tree; keep .cleo/project-id with the project)`
          : `${IDENTITY_COMMAND} --resolve && git add .cleo/project-id && git commit -m "chore: track CLEO project id"`,
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
  if (gitState() === 'ignored') {
    return {
      ...base,
      state: 'ignored',
      message:
        '.cleo/project-id is gitignored, so clones cannot inherit it. The .cleo/.gitignore predates ADR-094.',
      remedy:
        'cleo upgrade   (refreshes .cleo/.gitignore with `!project-id`), then git add .cleo/project-id',
    };
  }
  if (gitState() === 'untracked') {
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

/** Whether git tracks `.cleo/<file>`, so rewriting it dirties the work tree. */
function isGitTracked(projectRoot: string, file: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', `.cleo/${file}`], {
      cwd: projectRoot,
      stdio: 'pipe',
      timeout: GIT_PROBE_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return `info` with `findings` appended to its `strippedFields` receipt
 * (capped at the schema's `maxItems`) and, when `stripInfo`, its own path
 * facts removed. Pure; the caller writes the result.
 *
 * @param info - Parsed `project-info.json`.
 * @param findings - Path facts being removed, with their values.
 * @param now - ISO timestamp recorded on each receipt entry.
 * @param stripInfo - Remove `DERIVED_FIELDS` from `info` itself.
 * @returns A new object; `info` is not mutated.
 * @example
 * ```ts
 * const next = withStrippedFieldsReceipt(info, findings, new Date().toISOString(), true);
 * ```
 * @task T12557
 */
export function withStrippedFieldsReceipt(
  info: Readonly<Record<string, unknown>>,
  findings: readonly DerivedFieldFinding[],
  now: string,
  stripInfo: boolean,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...info };
  const prior = Array.isArray(info['strippedFields']) ? info['strippedFields'] : [];
  next['strippedFields'] = [
    ...prior,
    ...findings.map((finding) => ({ ...finding, strippedAt: now })),
  ].slice(-RECEIPT_MAX_ITEMS);
  if (stripInfo) for (const field of DERIVED_FIELDS) delete next[field];
  return next;
}

/**
 * Remove persisted path facts. The receipt is written first, into
 * `project-info.json` `strippedFields`, so a value is never removed without a
 * durable record of it; without a readable `project-info.json` nothing is
 * stripped.
 */
function stripDerivedFields(
  projectRoot: string,
  findings: readonly DerivedFieldFinding[],
  now: string,
): boolean {
  const info = readCleoJson(projectRoot, 'project-info.json');
  if (!info) return false;
  const stripInfo = findings.some((finding) => finding.file === 'project-info.json');
  writeJsonAtomic(
    join(projectRoot, '.cleo', 'project-info.json'),
    withStrippedFieldsReceipt(info, findings, now, stripInfo),
  );
  if (findings.some((finding) => finding.file === 'project-context.json')) {
    const context = readCleoJson(projectRoot, 'project-context.json');
    if (context) {
      for (const field of DERIVED_FIELDS) delete context[field];
      writeJsonAtomic(join(projectRoot, '.cleo', 'project-context.json'), context);
    }
  }
  return true;
}

/** An unconfirmed checkout of a registered project (T12470). */
interface CandidateCheckout {
  readonly projectId: string;
  readonly path: string;
  readonly registeredPath: string;
}

/**
 * Find this checkout's `candidate` location: it declares an id whose registry
 * row names another path, and it is not already a live location on this device.
 */
async function findCandidateCheckout(
  projectRoot: string,
  cleoHome: string | undefined,
): Promise<CandidateCheckout | null> {
  const declared = readDeclaredProjectIdentity(projectRoot);
  if (!declared) return null;
  const path = canonicalizePath(projectRoot);
  const { getNexusRegistryDb } = await import('../store/nexus-sqlite.js');
  const { projectRegistry } = await import('../store/schema/nexus-schema.js');
  const { eq } = await import('drizzle-orm');
  const { decideEncounterBinding } = await import('../nexus/path-map.js');
  const db = await getNexusRegistryDb(cleoHome ?? getCleoHome());
  const row = db
    .select({ projectPath: projectRegistry.projectPath })
    .from(projectRegistry)
    .where(eq(projectRegistry.projectId, declared.projectId))
    .get();
  if (!row || row.projectPath === path) return null;
  const binding = decideEncounterBinding(db, {
    projectId: declared.projectId,
    projectPath: path,
    now: new Date().toISOString(),
  });
  if (binding === 'refresh') return null;
  return { projectId: declared.projectId, path, registeredPath: row.projectPath };
}

/** Promote a candidate checkout to the project's live, registered location. */
async function confirmCandidateCheckout(
  candidate: CandidateCheckout,
  cleoHome: string | undefined,
): Promise<void> {
  const { getNexusRegistryDb } = await import('../store/nexus-sqlite.js');
  const { confirmProjectLocation } = await import('../nexus/path-map.js');
  const { collectCheckoutEvidence } = await import('../nexus/identity.js');
  const { ensureCheckoutNonce } = await import('../nexus/checkout-nonce.js');
  const evidence = await collectCheckoutEvidence(candidate.path);
  // The confirmed checkout gets its own nonce, so a later move is provable.
  const checkoutNonce = ensureCheckoutNonce(candidate.path);
  const db = await getNexusRegistryDb(cleoHome ?? getCleoHome());
  db.transaction(
    (tx) => {
      confirmProjectLocation(tx, {
        projectId: candidate.projectId,
        projectPath: candidate.path,
        now: new Date().toISOString(),
        evidence,
        checkoutNonce,
      });
    },
    { behavior: 'immediate' },
  );
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
 * - In every state, persisted `projectRoot` fields are stripped first
 *   (T12557). The removed values are kept in `project-info.json`
 *   `strippedFields`. `projectHash` is never touched.
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

  // T12470: a checkout that declares an already-registered id is only a
  // `candidate` until confirmed. Resolving here IS the explicit confirmation.
  const confirmCandidateStep = async (): Promise<boolean> => {
    const candidate = await findCandidateCheckout(projectRoot, options.cleoHome);
    if (!candidate) return false;
    steps.push({
      action: 'confirm-candidate-location',
      detail: `confirm ${candidate.path} as the live location of ${candidate.projectId} (registry row moves from ${candidate.registeredPath}; its permissions stay with the row)`,
    });
    if (!dryRun) await confirmCandidateCheckout(candidate, options.cleoHome);
    return true;
  };

  if (before.derivedFields.length > 0) {
    const removed = before.derivedFields
      .map((finding) => `${finding.file}:${finding.field}=${JSON.stringify(finding.value)}`)
      .join(', ');
    const trackedNote = before.derivedFields.some(
      (finding) => finding.file === 'project-context.json',
    )
      ? isGitTracked(projectRoot, 'project-context.json')
        ? '; .cleo/project-context.json is git-tracked, so this dirties the work tree (commit the change)'
        : '; .cleo/project-context.json is not git-tracked'
      : '';
    steps.push({
      action: 'strip-derived-fields',
      detail: `remove ${removed} (a path fact derived at runtime; a persisted copy goes stale on a move). Receipt: project-info.json strippedFields${trackedNote}`,
    });
    if (!dryRun && !stripDerivedFields(projectRoot, before.derivedFields, new Date().toISOString()))
      return result(
        'Cannot record a strip receipt: .cleo/project-info.json is missing or unreadable.',
      );
  }

  if (before.state === 'missing' && before.localId) {
    steps.push({
      action: 'write-tracked-id',
      detail: `create .cleo/project-id = ${before.localId}`,
    });
    if (!dryRun) await ensurePortableProjectId(projectRoot, before.localId);
    await confirmCandidateStep();
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
    await confirmCandidateStep();
    return result(null);
  }
  if (before.state !== 'conflict' && (await confirmCandidateStep())) return result(null);
  if (before.state !== 'conflict' || !before.trackedId || !before.localId) {
    if (before.remedy) return result(`${before.message} Remedy: ${before.remedy}`);
    return result(steps.length > 0 ? null : 'Nothing to resolve.');
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
      previousProjectIds: [...new Set([...previous, oldId])].slice(-RECEIPT_MAX_ITEMS),
      lastUpdated: now,
    });
  }
  return result(null, { before: rowsBefore, after: countRows() });
}
