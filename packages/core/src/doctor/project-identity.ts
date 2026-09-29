/**
 * Inspect and resolve the portable project identity (T12353 · ADR-094 · T12716).
 *
 * The tracked identity is `.cleo/project.json` `{schemaVersion, id, name}`
 * (T12716), with the ADR-094 `.cleo/project-id` kept as a legacy mirror.
 * `project-info.json` is untracked and device-local; its `projectId` is a
 * cache of the tracked id. The tracked id always wins at runtime. This module
 * is the ONLY place that migrates or re-keys identity files — nothing does it
 * on open, init or upgrade:
 *
 * - {@link inspectProjectIdentity} is read-only. It classifies the three
 *   sources (project.json / project-id / project-info.json), checks whether
 *   git actually tracks the canonical file, and returns the exact remedy.
 * - {@link inspectProjectNameDrift} is read-only. It compares the registry's
 *   label with the declared display name.
 * - {@link resolveProjectIdentity} applies the remedy. A legacy project gets
 *   `project.json` written from its `project-id` and `project-info.json` name
 *   (no id ever changes). For a conflict it re-keys the LOCAL side to the
 *   tracked id: the registry row's primary key and every alias pointing at the
 *   old id are updated in one registry transaction, and the old id is itself
 *   recorded as an alias. Nothing is deleted: rows elsewhere that still carry
 *   the old id (audit log, session manifest, background jobs) keep resolving
 *   through the alias table, and credentials sealed under it are re-wrapped on
 *   their next open (`previousProjectIds`).
 *
 * The id in a tracked file is never modified here. It is write-once, and a
 * malformed file is restored from version control, never regenerated.
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
 * @task T12716
 * @see ADR-094 — write-once portable project identity (amends ADR-013 §9)
 * @see ADR-096 — one committed `.cleo/project.json` {id, name} (amends ADR-094)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalizePath,
  getCleoHome,
  isValidPortableProjectId,
  isValidProjectDisplayName,
  PORTABLE_PROJECT_ID_FILE,
  PROJECT_MANIFEST_FILE,
  readDeclaredProjectIdentity,
  readPortableProjectId,
  readProjectIdFile,
  readProjectManifest,
  type TrackedIdentityFile,
} from '@cleocode/paths';
import {
  createProjectIdMirror,
  createProjectManifest,
  defaultProjectDisplayName,
  ensurePortableProjectId,
} from '../scaffold/project-identity.js';
import { detectRelocatedRoot } from '../store/relocated-store-guard.js';

/** Command that reports identity state; the prefix of every remedy below. */
const IDENTITY_COMMAND = 'cleo doctor project-identity';

/**
 * Classification of a project's identity sources.
 *
 * - `ok` — the tracked id and the cache agree, `project.json` and its
 *   `project-id` mirror agree, and git tracks `.cleo/project.json`.
 * - `uninitialized` — no identity file exists.
 * - `not-adopted` — only tracked files exist (a fresh clone before `cleo init`).
 * - `missing` — `project-info.json` has an id, but no tracked file exists.
 * - `legacy` — only the ADR-094 `.cleo/project-id` is tracked; `--resolve`
 *   writes `.cleo/project.json` from it (T12716).
 * - `mirror-missing` — `.cleo/project.json` exists, the legacy
 *   `.cleo/project-id` mirror does not; `--resolve` writes it (T12716).
 * - `mirror-conflict` — `.cleo/project.json` and `.cleo/project-id` both
 *   exist and disagree (or the mirror is malformed). The `project.json` id
 *   wins; the files are fixed by hand from version control (T12716).
 * - `conflict` — the tracked id and the `project-info.json` cache disagree.
 * - `invalid` — a tracked file that decides the id cannot be parsed.
 * - `info-invalid` — `project-info.json` exists but has no usable id.
 * - `untracked` — consistent, but git does not track `.cleo/project.json` yet.
 * - `ignored` — consistent, but a gitignore rule excludes `.cleo/project.json`.
 */
export type ProjectIdentityState =
  | 'ok'
  | 'uninitialized'
  | 'not-adopted'
  | 'missing'
  | 'legacy'
  | 'mirror-missing'
  | 'mirror-conflict'
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
  /** Classification of the identity sources. */
  readonly state: ProjectIdentityState;
  /**
   * The tracked id the runtime uses (`.cleo/project.json`, else the legacy
   * `.cleo/project-id`), when valid.
   */
  readonly trackedId: string | null;
  /** Id in `.cleo/project.json`, when valid (T12716). */
  readonly manifestId: string | null;
  /** Id in the legacy `.cleo/project-id`, when valid (T12716). */
  readonly legacyId: string | null;
  /** Display name declared in `.cleo/project.json`, when valid (T12716). */
  readonly declaredName: string | null;
  /** Id in `project-info.json` (the device-local cache), when present. */
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
    | 'write-project-json'
    | 'write-legacy-mirror'
    | 'rekey-registry-row'
    | 'repoint-aliases'
    | 'alias-old-id'
    | 'drop-inverted-alias'
    | 'rewrite-project-info'
    | 'confirm-candidate-location'
    | 'strip-derived-fields'
    | 'allow-project-json'
    | 'sync-registry-name';
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

/** Git's view of a tracked identity file: `null` when this is not a git work tree. */
function gitFileState(
  projectRoot: string,
  file: TrackedIdentityFile = PROJECT_MANIFEST_FILE,
): 'tracked' | 'untracked' | 'ignored' | null {
  const rel = `.cleo/${file}`;
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

/** The name a migrated `project.json` records: the cached name when valid, else the basename. */
function migrationName(projectRoot: string, info: ReturnType<typeof readInfo>): string {
  const name = info && info !== 'unparseable' ? info.data['name'] : undefined;
  return typeof name === 'string' && isValidProjectDisplayName(name)
    ? name
    : defaultProjectDisplayName(projectRoot);
}

/**
 * Classify the identity sources of a project, read-only.
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
  const manifest = readProjectManifest(projectRoot);
  const legacy = readProjectIdFile(projectRoot);
  const tracked = readPortableProjectId(projectRoot);
  const info = readInfo(projectRoot);
  const trackedId = tracked.status === 'valid' ? tracked.projectId : null;
  const localId = info && info !== 'unparseable' ? info.id : null;
  const manifestId = manifest.status === 'valid' ? manifest.manifest.id : null;
  const legacyId = legacy.status === 'valid' ? legacy.projectId : null;
  const base = {
    projectRoot,
    trackedId,
    manifestId,
    legacyId,
    declaredName: manifest.status === 'valid' ? manifest.manifest.name : null,
    localId,
    derivedFields: findDerivedFields(projectRoot),
  };
  // A CLEO root need not be a git work tree; git remedies apply only inside one.
  const gitStates = new Map<TrackedIdentityFile, ReturnType<typeof gitFileState>>();
  const gitState = (
    file: TrackedIdentityFile = PROJECT_MANIFEST_FILE,
  ): ReturnType<typeof gitFileState> => {
    if (!gitStates.has(file)) gitStates.set(file, gitFileState(projectRoot, file));
    return gitStates.get(file) ?? null;
  };

  if (tracked.status === 'invalid') {
    const rel = `.cleo/${tracked.file ?? PORTABLE_PROJECT_ID_FILE}`;
    return {
      ...base,
      state: 'invalid',
      message: `${rel} is unusable (${tracked.reason}). CLEO never regenerates it.`,
      remedy:
        gitState() === null
          ? `restore ${rel} from a backup of this project (the CLEO root is not a git work tree)`
          : `git checkout -- ${rel}   (restore the committed file; inspect with \`git log -p -- ${rel}\`)`,
    };
  }
  if (manifestId && legacy.status !== 'absent' && legacyId !== manifestId) {
    return {
      ...base,
      state: 'mirror-conflict',
      message:
        legacy.status === 'invalid'
          ? `.cleo/project-id is unusable (${legacy.reason}), while .cleo/project.json declares ${manifestId}. CLEO uses ${manifestId}; builds that read only .cleo/project-id cannot.`
          : `.cleo/project.json declares ${manifestId} but .cleo/project-id declares ${legacyId}. CLEO uses ${manifestId}; builds that read only .cleo/project-id use ${legacyId}.`,
      remedy:
        gitState() === null
          ? 'restore both files from a backup of this project; CLEO never rewrites a tracked id'
          : 'inspect `git log -p -- .cleo/project.json .cleo/project-id`, then restore the edited file with `git checkout <commit> -- <file>` (CLEO never rewrites a tracked id)',
    };
  }
  if (info === undefined) {
    // T12558: a tracked id restored (e.g. by `git checkout -- .`) at a root the
    // project was rerooted away from must not be "adopted" by a plain init —
    // that is exactly the refusal. Point at the live root, or the opt-out.
    const relocated = detectRelocatedRoot(projectRoot, join(getCleoHome(), 'cleo.db'));
    if (relocated) {
      return {
        ...base,
        state: 'not-adopted',
        message: `The tracked identity declares ${relocated.projectId}, which was rerooted from here to ${relocated.movedTo} (${relocated.via}).`,
        remedy: `cd "${relocated.movedTo}"   (the live project). A DIFFERENT project here needs a new id: \`cleo init --here --new-identity\``,
      };
    }
    return trackedId
      ? {
          ...base,
          state: 'not-adopted',
          message: `The tracked identity declares ${trackedId}, but this checkout has not been initialized.`,
          remedy: 'cleo init   (adopts the tracked id; it never mints a new one)',
        }
      : {
          ...base,
          state: 'uninitialized',
          message:
            'No project identity: none of .cleo/project.json, .cleo/project-id or .cleo/project-info.json exists.',
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
      message: `No tracked identity: .cleo/project.json is missing. The local id is ${localId}.`,
      remedy:
        gitState() === null
          ? `${IDENTITY_COMMAND} --resolve   (the CLEO root is not a git work tree; keep .cleo/project.json with the project)`
          : `${IDENTITY_COMMAND} --resolve && git add .cleo/project.json .cleo/project-id && git commit -m "chore: track CLEO project identity"`,
    };
  }
  if (trackedId !== localId) {
    return {
      ...base,
      state: 'conflict',
      message: `Identity conflict: the tracked id is ${trackedId}, but the project-info.json cache is ${localId}. Two lineages; CLEO uses ${trackedId}, while local state (registry row, aliases) is still keyed by ${localId}.`,
      remedy: `${IDENTITY_COMMAND} --resolve --dry-run   then   ${IDENTITY_COMMAND} --resolve   (re-keys local state to ${trackedId}; ${localId} stays resolvable as an alias)`,
    };
  }
  if (!manifestId) {
    return {
      ...base,
      state: 'legacy',
      message: `Only the legacy .cleo/project-id records ${trackedId}; .cleo/project.json (id + name) does not exist yet.`,
      remedy:
        gitState(PORTABLE_PROJECT_ID_FILE) === null
          ? `${IDENTITY_COMMAND} --resolve --dry-run   then   ${IDENTITY_COMMAND} --resolve   (writes .cleo/project.json; no id changes)`
          : `${IDENTITY_COMMAND} --resolve --dry-run   then   ${IDENTITY_COMMAND} --resolve && git add .cleo/project.json .cleo/.gitignore && git commit -m "chore: track CLEO project.json"   (no id changes)`,
    };
  }
  if (!legacyId) {
    return {
      ...base,
      state: 'mirror-missing',
      message: `.cleo/project.json records ${trackedId}, but the legacy .cleo/project-id mirror is missing, so builds that read only that file cannot resolve the id.`,
      remedy:
        gitState() === null
          ? `${IDENTITY_COMMAND} --resolve   (writes the mirror)`
          : `${IDENTITY_COMMAND} --resolve && git add .cleo/project-id && git commit -m "chore: track CLEO project-id mirror"`,
    };
  }
  if (gitState() === 'ignored') {
    return {
      ...base,
      state: 'ignored',
      message:
        '.cleo/project.json is gitignored, so clones cannot inherit it. The .cleo/.gitignore predates T12716.',
      remedy: `${IDENTITY_COMMAND} --resolve   (adds \`!project.json\` to .cleo/.gitignore; \`cleo upgrade\` refreshes the whole file), then git add .cleo/.gitignore .cleo/project.json .cleo/project-id`,
    };
  }
  if (gitState() === 'untracked' || gitState(PORTABLE_PROJECT_ID_FILE) === 'untracked') {
    return {
      ...base,
      state: 'untracked',
      message: 'The tracked identity files are not committed yet, so clones cannot inherit them.',
      remedy:
        'git add .cleo/project.json .cleo/project-id && git commit -m "chore: track CLEO project identity"',
    };
  }
  return {
    ...base,
    state: 'ok',
    message: `Project identity ${trackedId} ("${base.declaredName}") is tracked and consistent.`,
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

/**
 * If `.cleo/.gitignore` (a CLEO-managed file older than T12716) ignores
 * `.cleo/project.json`, the surgical repair: insert `!project.json` beside
 * `!project-id` (or append it). Nothing else in the file changes; a rule from
 * any other ignore file is reported, never edited.
 *
 * @returns The step to report, or `null` when the file is not ignored.
 */
function allowManifestInGitignore(
  projectRoot: string,
  dryRun: boolean,
): IdentityResolutionStep | { refused: string } | null {
  const rel = `.cleo/${PROJECT_MANIFEST_FILE}`;
  let source: string;
  try {
    source = execFileSync('git', ['check-ignore', '-v', '--no-index', rel], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_PROBE_TIMEOUT_MS,
      encoding: 'utf-8',
    });
  } catch {
    return null; // not ignored (exit 1), or not a git work tree
  }
  // `<source>:<line>:<pattern>\t<path>`; a matching `!pattern` means NOT ignored.
  const [ignoreFile = '', , pattern = ''] = (source.split('\t')[0] ?? '').split(':');
  if (pattern.startsWith('!')) return null;
  const cleoIgnore = join(projectRoot, '.cleo', '.gitignore');
  if (ignoreFile !== '.cleo/.gitignore' || !existsSync(cleoIgnore)) {
    return {
      refused: `${rel} is ignored by ${ignoreFile || 'a gitignore rule'} (${source.trim()}). Allow it there (\`!${rel}\`), then git add ${rel}.`,
    };
  }
  const step: IdentityResolutionStep = {
    action: 'allow-project-json',
    detail: `add \`!${PROJECT_MANIFEST_FILE}\` to .cleo/.gitignore (it predates T12716 and ignores ${rel}); commit it with ${rel}`,
  };
  if (!dryRun) {
    const lines = readFileSync(cleoIgnore, 'utf-8').split('\n');
    const at = lines.findIndex((line) => line.trim() === `!${PORTABLE_PROJECT_ID_FILE}`);
    if (at >= 0) lines.splice(at, 0, `!${PROJECT_MANIFEST_FILE}`);
    else
      lines.splice(
        lines.at(-1) === '' ? lines.length - 1 : lines.length,
        0,
        `!${PROJECT_MANIFEST_FILE}`,
      );
    writeFileSync(cleoIgnore, lines.join('\n'));
  }
  return step;
}

/** Options for {@link resolveProjectIdentity}. */
export interface ResolveProjectIdentityOptions {
  /** Plan only; write nothing. */
  dryRun?: boolean;
  /** Global CLEO home whose registry is re-keyed (defaults to the current one). */
  cleoHome?: string;
}

/**
 * Resolve the identity state that {@link inspectProjectIdentity} reported —
 * the ONLY migration path from the legacy files to `.cleo/project.json`
 * (T12716); nothing migrates on open, init or upgrade.
 *
 * - `legacy` writes `.cleo/project.json` (create-only) from the legacy
 *   `.cleo/project-id` id and the `project-info.json` name (else the
 *   basename). `project-id` stays as the legacy mirror; no id changes.
 * - `missing` writes `.cleo/project.json` and the `project-id` mirror from the
 *   local id (create-only).
 * - `mirror-missing` writes the legacy `.cleo/project-id` mirror (create-only).
 * - Whenever `project.json` is (or is about to be) ignored by a pre-T12716
 *   `.cleo/.gitignore` — including the `ignored` state — `!project.json` is
 *   inserted there, so the file can be committed; nothing else in it changes.
 * - `info-invalid` re-runs the scaffold decision (tracked id or registry re-link).
 * - `conflict` re-keys local state to the tracked id. One registry transaction
 *   renames the row's primary key, re-points aliases and records the old id as
 *   an alias. Then `project-info.json` is rewritten, keeping the old id under
 *   `previousProjectIds`, and `project.json` is written when only the legacy
 *   file existed.
 * - In every state, persisted `projectRoot` fields are stripped first
 *   (T12557). The removed values are kept in `project-info.json`
 *   `strippedFields`. `projectHash` is never touched.
 * - Last, a registry label that drifted from the declared name is synced
 *   (see {@link inspectProjectNameDrift}), unless another project holds it.
 *
 * Every other state (`invalid`, `mirror-conflict`, `untracked`, …) is refused
 * with its remedy. The operation is idempotent: re-running after a partial
 * apply completes the remaining steps.
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
  const resolution = await resolveIdentityFiles(projectRoot, options);
  // A refusal with a remedy (invalid, mirror-conflict, …) stops here.
  if (resolution.refused && resolution.refused !== NOTHING_TO_RESOLVE) return resolution;
  // Compare against the name project.json holds after the file steps, so a
  // dry-run plans exactly what an apply does.
  const writesManifest = resolution.steps.some(
    (step) => step.action === 'write-project-json' || step.action === 'write-tracked-id',
  );
  const drift = await inspectProjectNameDrift(
    projectRoot,
    options.cleoHome,
    writesManifest ? migrationName(projectRoot, readInfo(projectRoot)) : undefined,
  );
  if (drift.state !== 'drift' || drift.projectId === null || drift.declaredName === null)
    return resolution;
  const steps = [
    ...resolution.steps,
    {
      action: 'sync-registry-name' as const,
      detail: `registry label '${drift.registryName}' -> '${drift.declaredName}' (the declared name)`,
    },
  ];
  if (options.dryRun !== true) {
    const { nexusRenameProject } = await import('../nexus/registry.js');
    const { generateProjectHash } = await import('../nexus/hash.js');
    const { worktreeScope } = await import('../project-scope.js');
    const { projectId, declaredName } = drift;
    // Scoped to the explicit root, so no ambient project owns the write.
    await worktreeScope.run(
      { worktreeRoot: projectRoot, projectHash: generateProjectHash(projectRoot) },
      () => nexusRenameProject(projectId, declaredName),
    );
  }
  return { ...resolution, steps, refused: null };
}

/** Refusal text when nothing needs resolving. */
const NOTHING_TO_RESOLVE = 'Nothing to resolve.';

/** The file steps of {@link resolveProjectIdentity}, before the name sync. */
async function resolveIdentityFiles(
  projectRoot: string,
  options: ResolveProjectIdentityOptions,
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

  const name = migrationName(projectRoot, readInfo(projectRoot));
  // A migrated or ignored project.json must be committable (T12716).
  const allowStep = (): string | null => {
    const allowed = allowManifestInGitignore(projectRoot, dryRun);
    if (allowed === null) return null;
    if ('refused' in allowed) return allowed.refused;
    steps.push(allowed);
    return null;
  };
  // T12716: the migration. Create-only; the id is copied, never changed.
  const writeManifestStep = async (projectId: string): Promise<string | null> => {
    steps.push({
      action: 'write-project-json',
      detail: `create .cleo/project.json = {id: ${projectId}, name: ${JSON.stringify(name)}} (.cleo/project-id stays as the legacy mirror; commit .cleo/project.json)`,
    });
    if (dryRun) return null;
    const outcome = await createProjectManifest(projectRoot, projectId, name);
    return outcome === 'written' || outcome === 'present'
      ? null
      : `Cannot write .cleo/project.json (${outcome}).`;
  };

  if (before.state === 'missing' && before.localId) {
    steps.push({
      action: 'write-tracked-id',
      detail: `create .cleo/project.json = {id: ${before.localId}, name: ${JSON.stringify(name)}} and the .cleo/project-id mirror`,
    });
    if (!dryRun) await ensurePortableProjectId(projectRoot, before.localId, name);
    const ignored = allowStep();
    await confirmCandidateStep();
    return result(ignored);
  }
  if (before.state === 'legacy' && before.legacyId) {
    const failed = await writeManifestStep(before.legacyId);
    if (failed) return result(failed);
    const ignored = allowStep();
    await confirmCandidateStep();
    return result(ignored);
  }
  if (before.state === 'ignored') {
    const ignored = allowStep();
    await confirmCandidateStep();
    return result(ignored);
  }
  if (before.state === 'mirror-missing' && before.manifestId) {
    steps.push({
      action: 'write-legacy-mirror',
      detail: `create .cleo/project-id = ${before.manifestId} (for builds that read only that file; commit it)`,
    });
    if (!dryRun) {
      const outcome = await createProjectIdMirror(projectRoot, before.manifestId);
      if (outcome !== 'written' && outcome !== 'present')
        return result(`Cannot write .cleo/project-id (${outcome}).`);
    }
    await confirmCandidateStep();
    return result(null);
  }
  if (before.state === 'info-invalid') {
    steps.push({
      action: 'rewrite-project-info',
      detail: 'regenerate the project-info.json id from the tracked identity or the registry',
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
    return result(steps.length > 0 ? null : NOTHING_TO_RESOLVE);
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
  if (dryRun) {
    if (!before.manifestId) await writeManifestStep(newId);
    return result(before.manifestId ? null : allowStep(), {
      before: rowsBefore,
      after: rowsBefore,
    });
  }

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
  const manifestFailure = before.manifestId
    ? null
    : ((await writeManifestStep(newId)) ?? allowStep());
  return result(manifestFailure, { before: rowsBefore, after: countRows() });
}

/** Registry label vs declared display name (T12716). */
export interface ProjectNameDrift {
  /**
   * - `ok` — the registry label equals the declared name.
   * - `drift` — they differ and `--resolve` can sync the label.
   * - `taken` — they differ, but another project on this device holds the
   *   declared name as its label; rename one of them.
   * - `not-registered` — no registry row for the declared id on this device.
   * - `no-declared-name` — no `.cleo/project.json` yet (a legacy project);
   *   there is no committed name to compare against.
   * - `undeclared` — the project declares no id.
   * - `unavailable` — the registry could not be read (coverage missing).
   */
  readonly state:
    | 'ok'
    | 'drift'
    | 'taken'
    | 'not-registered'
    | 'no-declared-name'
    | 'undeclared'
    | 'unavailable';
  /** The declared id whose row was compared. */
  readonly projectId: string | null;
  /** The committed name in `.cleo/project.json` (or the name a planned migration writes). */
  readonly declaredName: string | null;
  /** The registry row's label. */
  readonly registryName: string | null;
  /** One-line explanation. */
  readonly message: string;
  /** Exact command that fixes it, or `null`. */
  readonly remedy: string | null;
}

/**
 * Compare the global registry's label for this project with the name the
 * project declares in its committed `.cleo/project.json` (T12716), read-only.
 * Only a committed name counts: a legacy project's cached name or basename
 * differs per checkout, so it is never a drift source.
 *
 * @param projectRoot - Absolute project root.
 * @param cleoHome - Global CLEO home whose registry is read.
 * @param plannedName - The name `project.json` will hold once a planned
 *   migration writes it (used by `--resolve` so its dry-run matches the apply).
 * @returns The drift report; an unreadable registry is `unavailable`, never `ok`.
 *
 * @example
 * ```ts
 * const drift = await inspectProjectNameDrift('/repo');
 * if (drift.state === 'drift') console.log(drift.remedy);
 * ```
 * @task T12716
 */
export async function inspectProjectNameDrift(
  projectRoot: string,
  cleoHome?: string,
  plannedName?: string,
): Promise<ProjectNameDrift> {
  const declared = readDeclaredProjectIdentity(projectRoot);
  const declaredName = declared?.name ?? plannedName ?? null;
  if (!declared) {
    return {
      state: 'undeclared',
      projectId: null,
      declaredName,
      registryName: null,
      message: 'The project declares no identity, so no registry row can be compared.',
      remedy: 'cleo init',
    };
  }
  try {
    const { getNexusRegistryDb } = await import('../store/nexus-sqlite.js');
    const { projectRegistry } = await import('../store/schema/nexus-schema.js');
    const { eq } = await import('drizzle-orm');
    if (declaredName === null) {
      return {
        state: 'no-declared-name',
        projectId: declared.projectId,
        declaredName,
        registryName: null,
        message: 'No .cleo/project.json yet, so the project declares no committed name.',
        remedy: null,
      };
    }
    const db = await getNexusRegistryDb(cleoHome ?? getCleoHome());
    const row = db
      .select({ name: projectRegistry.name })
      .from(projectRegistry)
      .where(eq(projectRegistry.projectId, declared.projectId))
      .get();
    const base = { projectId: declared.projectId, declaredName };
    if (!row) {
      return {
        ...base,
        state: 'not-registered',
        registryName: null,
        message: `No registry row for ${declared.projectId} on this device.`,
        remedy: null,
      };
    }
    if (row.name === declaredName) {
      return {
        ...base,
        state: 'ok',
        registryName: row.name,
        message: `The registry label matches the declared name "${declaredName}".`,
        remedy: null,
      };
    }
    const holder = db
      .select({ projectId: projectRegistry.projectId })
      .from(projectRegistry)
      .where(eq(projectRegistry.name, declaredName))
      .all()
      .find((other) => other.projectId !== declared.projectId);
    if (holder) {
      return {
        ...base,
        state: 'taken',
        registryName: row.name,
        message: `The registry labels this project "${row.name}", but it declares "${declaredName}", which project ${holder.projectId} already uses on this device.`,
        remedy: `cleo project rename <a-unique-name>   (here, or in the project ${holder.projectId})`,
      };
    }
    return {
      ...base,
      state: 'drift',
      registryName: row.name,
      message: `The registry labels this project "${row.name}", but it declares "${declaredName}".`,
      remedy: `${IDENTITY_COMMAND} --resolve   (syncs the registry label to the declared name)`,
    };
  } catch (error) {
    return {
      state: 'unavailable',
      projectId: declared.projectId,
      declaredName,
      registryName: null,
      message: `Registry unavailable, name drift not checked: ${error instanceof Error ? error.message : String(error)}`,
      remedy: null,
    };
  }
}
