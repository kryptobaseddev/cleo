/**
 * `cleo doctor projects` — machine-wide integrity check of the project
 * registry (T12471 · ADR-094).
 *
 * The registry is keyed by project id, never by path. A path is a per-device
 * hint that goes stale when a project moves, is deleted, or is re-initialized
 * under a new id. This module walks every registry row, probes its path, scans
 * the directories projects live in for `.cleo/` declarations, and classifies
 * each row (see `NexusRegistryFindingKind`):
 *
 * - {@link inspectProjectRegistry} is read-only and returns every non-`ok`
 *   row with its exact remedy.
 * - {@link applyProjectRegistryRepair} applies only the safe classes: a
 *   `moved` row is rebound to the one path that declares its id, and a
 *   `missing` row's location is recorded as `missing`. Nothing is deleted.
 *   The rows the changes touch are imaged before and after, and both images
 *   are written to `nexus_audit_log` in the same transaction as the changes.
 * - {@link rollbackProjectRegistryRepair} restores the before image, guarded
 *   on the current rows still matching the after image.
 *
 * Split identities, ambiguous moves, temp rows and home/root rows are owner
 * decisions: they are reported with a remedy and never changed.
 *
 * Probes are bounded: at most `concurrency` filesystem reads at once, each
 * with a `timeoutMs` budget. Only ENOENT/ENOTDIR prove a path gone; EACCES,
 * EPERM or a timeout leave the row `unreadable` and untouched (#1606).
 *
 * @task T12471
 * @epic T12468
 * @see ADR-094 — write-once portable project identity
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import type {
  NexusRegistryFinding,
  NexusRegistryFindingKind,
  NexusRegistryIntegrityReport,
  NexusRegistryRepairAction,
  NexusRegistryRepairReceipt,
  NexusRegistryRollbackResult,
  NexusRegistrySplitPeer,
} from '@cleocode/contracts';
import { readDeclaredProjectIdentity } from '@cleocode/paths';
import { eq, inArray, or } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { readCheckoutNonce } from '../nexus/checkout-nonce.js';
import { type CheckoutEvidence, collectCheckoutEvidence } from '../nexus/identity.js';
import {
  confirmProjectLocation,
  currentDeviceId,
  demoteProjectLocation,
  holdingKey,
  isSupersededRegistryPath,
  LOCAL_DEVICE_SENTINEL,
  type PathMapWriter,
  type ProjectHolding,
  probeProjectHolding,
} from '../nexus/path-map.js';
import { walkForCleoBounded, withinBudget } from '../nexus/projects-scan.js';
import { isEphemeralPath } from '../nexus/registry-hygiene.js';
import { getCleoHome } from '../paths.js';
import { isStrictlyInsideDir, readValidProjectTombstone } from '../project-tombstone.js';
import type {
  ProjectLocationRow,
  ProjectPathRow,
  ProjectRegistryRow,
} from '../store/schema/nexus-schema.js';
import { runWithConcurrency } from '../lib/concurrency.js';

/** Command that reports registry integrity; the prefix of the remedies below. */
const DOCTOR_COMMAND = 'cleo doctor projects';

/** Audit-log `action` of an applied repair. */
const APPLY_ACTION = 'doctor.projects.apply';

/** Audit-log `action` of a rollback. */
const ROLLBACK_ACTION = 'doctor.projects.rollback';

/** Default filesystem reads in flight at once. */
const DEFAULT_CONCURRENCY = 16;

/** Default budget for one filesystem probe. */
const DEFAULT_TIMEOUT_MS = 2000;

/** Default scan depth below each root. */
const DEFAULT_MAX_DEPTH = 2;

/** SQLite bound-parameter headroom per `IN (...)` list. */
const CHUNK = 400;

/** Every kind, so `counts` always carries all of them. */
const FINDING_KINDS: readonly NexusRegistryFindingKind[] = [
  'ok',
  'moved',
  'ambiguous',
  'split',
  'possible-split',
  'missing',
  'temp',
  'root',
  'unreadable',
  'other-device',
];

/** Options shared by inspect and apply. */
export interface ProjectRegistryScanOptions {
  /** Extra directories to scan for `.cleo/`, beyond the registry-derived parents. */
  roots?: readonly string[];
  /** Scan depth below each root (default 2). */
  maxDepth?: number;
  /** Filesystem reads in flight at once (default 16). */
  concurrency?: number;
  /** Budget per filesystem probe in milliseconds (default 2000). */
  timeoutMs?: number;
  /** Global CLEO home whose registry is checked (defaults to the current one). */
  cleoHome?: string;
}

/** A project directory the scan found, with what it declares. */
interface ScannedProject {
  readonly path: string;
  readonly projectId: string;
  readonly nonce: string | null;
}

/** Registry row fields the check reads. */
interface RegistryRowView {
  readonly projectId: string;
  readonly projectPath: string;
  readonly name: string;
}

/** A classified row plus what `--apply` would do for it. */
interface PlannedFinding {
  readonly finding: NexusRegistryFinding;
  readonly rebindTo?: { path: string; nonce: string | null };
  readonly markMissing?: boolean;
}

/** Location row fields the check reads. */
interface LocationView {
  readonly projectId: string;
  readonly deviceId: string;
  readonly path: string;
  readonly state: string;
  readonly checkoutNonce: string | null;
  readonly gitRemote: string | null;
  readonly gitRootCommit: string | null;
}

/** Everything one inspection gathered; apply works from it. */
interface Inspection {
  readonly report: NexusRegistryIntegrityReport;
  readonly planned: readonly PlannedFinding[];
}

/** Rows of the three registry tables a repair touches. */
interface RowImage {
  registry: ProjectRegistryRow[];
  locations: ProjectLocationRow[];
  paths: ProjectPathRow[];
}

/** Details JSON stored with an applied repair. */
interface StoredRepair {
  readonly receipt: NexusRegistryRepairReceipt;
  readonly scope: { ids: string[]; paths: string[] };
  readonly before: RowImage;
  readonly after: RowImage;
}

/** Error with a stable code, raised when a rollback is refused. */
export class RegistryRepairError extends Error {
  /** @override */
  override readonly name = 'RegistryRepairError';

  /**
   * @param code - Stable error code (`E_NOT_FOUND`, `E_ROLLBACK_CONFLICT`).
   * @param message - Explanation with the remedy.
   */
  constructor(
    readonly code: 'E_NOT_FOUND' | 'E_ROLLBACK_CONFLICT',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Whether a registry path is a temp row: under a temp directory while the
 * registry itself is persistent. A sandboxed registry (temp `CLEO_HOME`) keeps
 * its temp fixtures legitimately, as encounter registration does.
 *
 * @param projectPath - Registered path.
 * @param cleoHome - Home of the registry being checked.
 * @returns `true` for a temp row.
 *
 * @example
 * ```ts
 * isTempRegistryPath('/tmp/fixture', '/home/me/.local/share/cleo'); // true
 * ```
 */
export function isTempRegistryPath(projectPath: string, cleoHome: string): boolean {
  return isEphemeralPath(projectPath) && !isEphemeralPath(cleoHome);
}

/**
 * Whether a registry path is the home directory or a filesystem root: a
 * project registered there claims every directory below it.
 *
 * @param projectPath - Registered path.
 * @param home - Home directory (defaults to the current user's).
 * @returns `true` for a home or root row.
 *
 * @example
 * ```ts
 * isHomeOrRootPath('/'); // true
 * ```
 */
export function isHomeOrRootPath(projectPath: string, home: string = homedir()): boolean {
  const resolved = resolve(projectPath);
  return resolved === parse(resolved).root || resolved === resolve(home);
}

/** Split `items` into slices of at most {@link CHUNK}. */
function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/** Open the global registry store and its schema. */
async function openRegistry(cleoHome: string) {
  const { getNexusRegistryDb, getNexusRegistryDbPath } = await import('../store/nexus-sqlite.js');
  const schema = await import('../store/schema/nexus-schema.js');
  return {
    db: await getNexusRegistryDb(cleoHome),
    storePath: getNexusRegistryDbPath(cleoHome),
    ...schema,
  };
}

/**
 * Scan `roots` and read the id each found project declares. Every `.cleo/`
 * is first read asynchronously within the budget; only a directory that
 * answered in time is read synchronously, so one hung mount cannot stall the
 * scan. Projects in a trash directory are never candidates.
 */
async function scanRoots(
  roots: readonly string[],
  opts: Required<Pick<ProjectRegistryScanOptions, 'maxDepth' | 'concurrency' | 'timeoutMs'>>,
): Promise<{ projects: ScannedProject[]; timedOut: string[]; unreadable: string[] }> {
  const walked = await walkForCleoBounded(
    roots.filter((root) => !isTrashPath(root)),
    opts,
  );
  const timedOut = [...walked.timedOut];
  const unreadable = [...walked.unreadable];
  const found = walked.found.filter((path) => !isTrashPath(path));
  const answered = await runWithConcurrency(found, opts.concurrency, async (path) => {
    const read = await withinBudget(
      readdir(join(path, '.cleo')).then(
        () => 'ok' as const,
        () => 'unreadable' as const,
      ),
      opts.timeoutMs,
    );
    if (read === 'timeout') timedOut.push(path);
    else if (read === 'unreadable') unreadable.push(path);
    return read === 'ok';
  });
  const projects: ScannedProject[] = [];
  found.forEach((path, index) => {
    if (!answered[index]) return;
    const declared = readDeclaredProjectIdentity(path);
    if (!declared) return;
    projects.push({ path, projectId: declared.projectId, nonce: readCheckoutNonce(path) });
  });
  return { projects, timedOut: timedOut.sort(), unreadable: unreadable.sort() };
}

/** Path segments that mark a trash directory (macOS, Windows, freedesktop). */
const TRASH_SEGMENTS: ReadonlySet<string> = new Set(['.trash', '.trashes', '$recycle.bin']);

/**
 * Whether `path` lies in a trash directory. A project the owner trashed is
 * never a move target, and its registry row may be cleaned.
 *
 * @param path - Absolute path.
 * @returns `true` inside `.Trash`, `.Trashes`, `$RECYCLE.BIN` or `.local/share/Trash`.
 *
 * @example
 * ```ts
 * isTrashPath('/Users/me/.Trash/app'); // true
 * ```
 */
export function isTrashPath(path: string): boolean {
  const segments = resolve(path)
    .split(sep)
    .map((segment) => segment.toLowerCase());
  return segments.some(
    (segment, i) =>
      TRASH_SEGMENTS.has(segment) ||
      (segment === 'trash' && segments[i - 1] === 'share' && segments[i - 2] === '.local'),
  );
}

/** `true` when `inner` is strictly inside `outer`, compared lexically. */
function isLexicallyInside(outer: string, inner: string): boolean {
  const o = resolve(outer);
  return resolve(inner).startsWith(o.endsWith(sep) ? o : o + sep);
}

/**
 * Directories to scan: the parent of every registered path, existing or not
 * (a project is most often moved or renamed next to where it was), plus the
 * operator's `--roots`. A filesystem root is never scanned by default; a
 * parent that no longer exists is skipped by the walker.
 */
function scanRootsFor(paths: readonly string[], extra: readonly string[]): string[] {
  const roots = new Set(extra.map((root) => resolve(root)));
  for (const projectPath of paths) {
    if (isSupersededRegistryPath(projectPath)) continue;
    const parent = dirname(resolve(projectPath));
    if (parent !== parse(parent).root) roots.add(parent);
  }
  return [...roots].sort();
}

/** The remedy for a split proven by shared repository evidence. */
function splitRemedy(row: RegistryRowView, peer: NexusRegistrySplitPeer): string {
  const keepPeer = `to keep ${peer.projectId}: review \`cleo nexus show ${row.projectId}\`, then \`cleo nexus unregister ${row.projectId}\``;
  const keepRow =
    `to keep ${row.projectId}: in "${peer.projectPath}" restore .cleo/project-id to ${row.projectId} ` +
    `(\`git log -p -- .cleo/project-id\`)${peer.registered ? `, run \`cleo nexus unregister ${peer.projectId}\`` : ''}, ` +
    'then run `cleo doctor project-identity --resolve` there';
  return `Owner decision — CLEO never merges ids. ${keepPeer}; or ${keepRow}; or keep both: a fork is a distinct project.`;
}

/** Why a scanned path that declares a row's id is not a rebind target, or `null`. */
function ineligibleTarget(
  target: ScannedProject,
  mine: readonly LocationView[],
  cleoHome: string,
): string | null {
  if (isTrashPath(target.path)) return 'it is in the trash';
  if (isLexicallyInside(cleoHome, target.path)) return 'it is inside the CLEO home (a worktree)';
  if (readValidProjectTombstone(target.path))
    return 'it holds a valid reroot tombstone (the project was rerooted away from it)';
  // #1606 reroot geometry: the location was demoted to missing while a
  // location strictly inside it became the project's home.
  const here = mine.find((l) => l.path === target.path);
  if (
    here?.state === 'missing' &&
    mine.some((l) => l.path !== target.path && isStrictlyInsideDir(target.path, l.path))
  )
    return 'the project was rerooted away from it (its location is recorded missing)';
  return null;
}

/** Per-row facts {@link classifyGone} reads. */
interface GoneContext {
  readonly byId: Map<string, ScannedProject[]>;
  readonly scanned: readonly ScannedProject[];
  readonly registered: Map<string, RegistryRowView>;
  readonly linked: (a: string, b: string) => boolean;
  /** This device's locations of the row's id. */
  readonly mine: readonly LocationView[];
  /** What the registered path holds now (L4 wording). */
  readonly gone: 'path' | 'cleo' | { declares: string } | 'sentinel';
  readonly cleoHome: string;
  /** Repository evidence of a checkout, bounded by the probe budget. */
  readonly evidenceOf: (path: string) => Promise<CheckoutEvidence | null>;
}

/**
 * Classify one row whose registered path provably no longer holds it.
 *
 * A row is rebound only to a path whose untracked checkout NONCE equals one
 * recorded for the id (T12470 · #1606): the committed id alone is forgeable
 * (a clone, a copied `.cleo/project-id`), so an id-only match is reported
 * with the explicit `project-identity --resolve` remedy and never applied.
 */
async function classifyGone(row: RegistryRowView, ctx: GoneContext): Promise<PlannedFinding> {
  const base = { projectId: row.projectId, name: row.name, projectPath: row.projectPath };
  const recordedNonces = new Set(
    ctx.mine.map((l) => l.checkoutNonce).filter((n): n is string => n !== null),
  );
  const elsewhere = (ctx.byId.get(row.projectId) ?? []).filter((p) => p.path !== row.projectPath);
  const excluded = elsewhere
    .map((p) => ({ p, reason: ineligibleTarget(p, ctx.mine, ctx.cleoHome) }))
    .filter((x): x is { p: ScannedProject; reason: string } => x.reason !== null);
  const eligible = elsewhere.filter((p) => !excluded.some((x) => x.p === p));
  const proven = eligible.filter((p) => p.nonce !== null && recordedNonces.has(p.nonce));
  const foundAt = elsewhere.map((p) => p.path);
  const target = proven.length === 1 ? proven[0] : undefined;
  if (target) {
    return {
      finding: {
        ...base,
        kind: 'moved',
        message: `${row.projectId} is no longer at ${row.projectPath}; ${target.path} declares it and its checkout nonce matches (a real move).`,
        remedy: `${DOCTOR_COMMAND} --apply   (rebinds the row to ${target.path}; permissions stay with the row)`,
        applicable: true,
        foundAt,
        proof: 'nonce',
      },
      rebindTo: { path: target.path, nonce: target.nonce },
    };
  }
  if (proven.length > 1) {
    return {
      finding: {
        ...base,
        kind: 'ambiguous',
        message: `${row.projectId} is no longer at ${row.projectPath}; ${proven.length} paths carry its checkout nonce (copies of one checkout).`,
        remedy: `cd into the checkout to keep and run \`cleo doctor project-identity --resolve\` (candidates: ${proven.map((p) => `"${p.path}"`).join(', ')})`,
        applicable: false,
        foundAt,
        proof: 'nonce',
      },
    };
  }
  if (elsewhere.length > 0) {
    const why = excluded.map((x) => `${x.p.path}: ${x.reason}`).join('; ');
    const candidates = eligible.map((p) => `"${p.path}"`).join(', ');
    return {
      finding: {
        ...base,
        kind: 'moved',
        message:
          `${row.projectId} is no longer at ${row.projectPath}. ` +
          (eligible.length > 0
            ? `${candidates} declare${eligible.length === 1 ? 's' : ''} the id, but no checkout nonce proves a move (a clone or a copied .cleo/project-id declares it too).`
            : 'Every path that declares the id is excluded.') +
          (why ? ` Not a target — ${why}.` : ''),
        remedy:
          eligible.length > 0
            ? `If it IS the project, confirm explicitly: cd into it and run \`cleo doctor project-identity --resolve\` (${candidates}). Never applied automatically.`
            : `Inspect the paths listed; if the project left this device, the row can stay (\`cleo nexus unregister ${row.projectId}\` only when it is gone for good).`,
        applicable: false,
        foundAt,
        proof: 'id-only',
      },
    };
  }

  const split = await splitPeers(row, ctx);
  const localState = ctx.mine.find((l) => l.path === row.projectPath)?.state ?? null;
  const markMissing = ctx.gone !== 'sentinel' && localState !== 'missing';
  const byEvidence = split.filter((peer) => peer.matchedBy !== 'name');
  const peer = byEvidence[0];
  if (peer) {
    return {
      finding: {
        ...base,
        kind: 'split',
        message: `Split identity: ${row.projectId} is gone from ${row.projectPath}, and ${peer.projectPath} holds the same repository (${peer.matchedBy === 'remote' ? 'git remote' : 'root commit'}) under ${peer.projectId} (a re-minted id).`,
        remedy: splitRemedy(row, peer),
        applicable: false,
        splitWith: byEvidence,
      },
    };
  }
  const named = split[0];
  if (named) {
    return {
      finding: {
        ...base,
        kind: 'possible-split',
        message: `${row.projectId} is gone from ${row.projectPath}; ${named.projectPath} has the same name under ${named.projectId}, but no repository evidence ties them — it may be an unrelated project.`,
        remedy:
          `Inspect only — compare \`cleo nexus show ${row.projectId}\` with "${named.projectPath}" (its git log and .cleo/project-id). ` +
          "Never change the other project's id or registry row on a name match alone; " +
          'keep both if they differ: a fork is a distinct project.' +
          (markMissing
            ? ` \`${DOCTOR_COMMAND} --apply\` records ${row.projectId}'s location as missing and keeps its row.`
            : ''),
        applicable: markMissing,
        splitWith: split,
      },
      markMissing,
    };
  }
  if (ctx.gone === 'path' && isTempRegistryPath(row.projectPath, ctx.cleoHome)) {
    return {
      finding: {
        ...base,
        kind: 'temp',
        message: `${row.projectPath} is a temp directory that no longer exists (a test fixture or scratch project).`,
        remedy: 'cleo nexus projects clean --include-temp --dry-run   then without --dry-run',
        applicable: false,
      },
    };
  }
  const where =
    ctx.gone === 'sentinel'
      ? `${row.projectId} has no live location on this device`
      : ctx.gone === 'path'
        ? `${row.projectPath} no longer exists`
        : ctx.gone === 'cleo'
          ? `${row.projectPath} exists but has no .cleo/ (the project was moved out of it)`
          : `${row.projectPath}/.cleo now declares ${ctx.gone.declares}, not ${row.projectId}`;
  return {
    finding: {
      ...base,
      kind: 'missing',
      message: `${where}, and no scanned path declares ${row.projectId}.`,
      remedy:
        `If it moved, scan its new parent: \`${DOCTOR_COMMAND} --roots <dir>\`. ` +
        `If it is gone for good: \`cleo nexus unregister ${row.projectId}\`.` +
        (markMissing
          ? ` \`${DOCTOR_COMMAND} --apply\` records the location as missing and keeps the row.`
          : ''),
      applicable: markMissing,
    },
    markMissing,
  };
}

/**
 * Scanned projects with the row's name under another id. A peer whose
 * repository evidence (git remote or root commit, recorded for the row and
 * read from the peer) matches is tagged by that evidence; otherwise `name`.
 */
async function splitPeers(
  row: RegistryRowView,
  ctx: GoneContext,
): Promise<NexusRegistrySplitPeer[]> {
  const name = isSupersededRegistryPath(row.projectPath) ? row.name : basename(row.projectPath);
  const remotes = new Set(ctx.mine.map((l) => l.gitRemote).filter((v): v is string => !!v));
  const commits = new Set(ctx.mine.map((l) => l.gitRootCommit).filter((v): v is string => !!v));
  const peers: NexusRegistrySplitPeer[] = [];
  for (const p of ctx.scanned) {
    if (p.projectId === row.projectId || ctx.linked(p.projectId, row.projectId)) continue;
    if (basename(p.path) !== name && basename(p.path) !== row.name) continue;
    const evidence = remotes.size > 0 || commits.size > 0 ? await ctx.evidenceOf(p.path) : null;
    // A shared root commit with a DIFFERENT remote is a fork or a second
    // clone of one template — a distinct project, never proof of a split.
    const remotesDiffer =
      !!evidence?.gitRemote && remotes.size > 0 && !remotes.has(evidence.gitRemote);
    const matchedBy =
      evidence?.gitRemote && remotes.has(evidence.gitRemote)
        ? 'remote'
        : evidence?.gitRootCommit && commits.has(evidence.gitRootCommit) && !remotesDiffer
          ? 'root-commit'
          : 'name';
    peers.push({
      projectId: p.projectId,
      projectPath: p.path,
      registered: ctx.registered.has(p.projectId),
      matchedBy,
    });
  }
  return peers;
}

/** Classify one row whose registered path still holds it. */
function classifyHeld(
  row: RegistryRowView,
  remotePeers: NexusRegistrySplitPeer[],
  cleoHome: string,
): PlannedFinding {
  const base = { projectId: row.projectId, name: row.name, projectPath: row.projectPath };
  if (isHomeOrRootPath(row.projectPath)) {
    return {
      finding: {
        ...base,
        kind: 'root',
        message: `${row.projectPath} is the home directory or a filesystem root; a project there claims every directory below it.`,
        remedy: `If a real project lives below it, run \`cleo project reroot <dir>\` from ${row.projectPath}; otherwise \`cleo nexus unregister ${row.projectId}\``,
        applicable: false,
      },
    };
  }
  if (isTempRegistryPath(row.projectPath, cleoHome)) {
    return {
      finding: {
        ...base,
        kind: 'temp',
        message: `${row.projectPath} is under a temp directory (a test fixture or scratch project in the persistent registry).`,
        remedy: 'cleo nexus projects clean --include-temp --dry-run   then without --dry-run',
        applicable: false,
      },
    };
  }
  const peer = remotePeers[0];
  if (peer) {
    return {
      finding: {
        ...base,
        kind: 'split',
        message: `Split identity: ${row.projectId} at ${row.projectPath} and ${peer.projectId} at ${peer.projectPath} share a git remote.`,
        remedy: splitRemedy(row, peer),
        applicable: false,
        splitWith: remotePeers,
      },
    };
  }
  return {
    finding: {
      ...base,
      kind: 'ok',
      message: 'The registered path holds the project.',
      remedy: null,
      applicable: false,
    },
  };
}

/** Gather registry state, probe, scan and classify. Read-only. */
async function inspect(opts: ProjectRegistryScanOptions): Promise<Inspection> {
  const cleoHome = opts.cleoHome ?? getCleoHome();
  const budget = scanBudget(opts);
  const { db, storePath, projectRegistry, projectLocations, projectIdAliases } =
    await openRegistry(cleoHome);
  const rows: RegistryRowView[] = db
    .select({
      projectId: projectRegistry.projectId,
      projectPath: projectRegistry.projectPath,
      name: projectRegistry.name,
    })
    .from(projectRegistry)
    .all();
  const locations: LocationView[] = db
    .select({
      projectId: projectLocations.projectId,
      deviceId: projectLocations.deviceId,
      path: projectLocations.path,
      state: projectLocations.state,
      checkoutNonce: projectLocations.checkoutNonce,
      gitRemote: projectLocations.gitRemote,
      gitRootCommit: projectLocations.gitRootCommit,
    })
    .from(projectLocations)
    .all();
  const aliases = db
    .select({ legacyId: projectIdAliases.legacyId, canonicalId: projectIdAliases.canonicalId })
    .from(projectIdAliases)
    .all();

  const deviceId = currentDeviceId();
  const local = (l: LocationView): boolean =>
    l.deviceId === deviceId || l.deviceId === LOCAL_DEVICE_SENTINEL;
  const aliasPairs = new Set(aliases.map((a) => `${a.legacyId}\u0000${a.canonicalId}`));
  const linked = (a: string, b: string): boolean =>
    aliasPairs.has(`${a}\u0000${b}`) || aliasPairs.has(`${b}\u0000${a}`);
  const registered = new Map(rows.map((row) => [row.projectId, row]));
  const localById = new Map<string, LocationView[]>();
  for (const l of locations) {
    if (!local(l)) continue;
    const list = localById.get(l.projectId) ?? [];
    list.push(l);
    localById.set(l.projectId, list);
  }

  const roots = scanRootsFor(
    rows.map((row) => row.projectPath),
    opts.roots ?? [],
  );
  const scan = await scanRoots(roots, budget);
  const byId = new Map<string, ScannedProject[]>();
  for (const project of scan.projects) {
    const list = byId.get(project.projectId) ?? [];
    list.push(project);
    byId.set(project.projectId, list);
  }

  // Registered rows sharing one git remote on this device are one project
  // under two ids — unless one is nested inside another registered project
  // (a fixture project inside a repo shares the repo's remote).
  const realPaths = rows.filter((r) => !isSupersededRegistryPath(r.projectPath));
  const nested = new Set(
    realPaths
      .filter((r) =>
        realPaths.some(
          (o) => o.projectId !== r.projectId && isLexicallyInside(o.projectPath, r.projectPath),
        ),
      )
      .map((r) => r.projectId),
  );
  const remoteOf = new Map<string, string>();
  for (const l of locations) {
    const row = registered.get(l.projectId);
    if (l.gitRemote && row && l.path === row.projectPath && local(l) && !nested.has(l.projectId))
      remoteOf.set(l.projectId, l.gitRemote);
  }

  const holdings = await runWithConcurrency(rows, budget.concurrency, async (row) => {
    if (isSupersededRegistryPath(row.projectPath)) return 'no' as ProjectHolding;
    const here = locations.filter(
      (l) => l.projectId === row.projectId && l.path === row.projectPath,
    );
    if (here.length > 0 && !here.some(local)) return 'other-device' as const;
    return probeProjectHolding(row.projectPath, row.projectId, budget.timeoutMs);
  });

  const evidence = new Map<string, Promise<CheckoutEvidence | null>>();
  const evidenceOf = (path: string): Promise<CheckoutEvidence | null> => {
    const cached = evidence.get(path);
    if (cached) return cached;
    const pending = withinBudget(
      collectCheckoutEvidence(path).catch(() => null),
      budget.timeoutMs,
    ).then((settled) => (settled === 'timeout' ? null : settled));
    evidence.set(path, pending);
    return pending;
  };

  const planned: PlannedFinding[] = await runWithConcurrency(
    rows,
    budget.concurrency,
    async (row, index): Promise<PlannedFinding> => {
      const holding = holdings[index];
      const base = { projectId: row.projectId, name: row.name, projectPath: row.projectPath };
      if (holding === 'other-device') {
        return {
          finding: {
            ...base,
            kind: 'other-device',
            message: `${row.projectPath} was recorded on another device; it is not probed here.`,
            remedy: null,
            applicable: false,
          },
        };
      }
      if (holding === 'unknown') {
        return {
          finding: {
            ...base,
            kind: 'unreadable',
            message: `${row.projectPath}/.cleo could not be read (permission denied or timed out). Only a missing path proves a project gone, so the row is kept as is.`,
            remedy: `Check access to "${row.projectPath}" (\`ls -ld "${row.projectPath}/.cleo"\`), then re-run \`${DOCTOR_COMMAND}\`; or \`cleo nexus unregister ${row.projectId}\` if you no longer need it`,
            applicable: false,
          },
        };
      }
      if (holding === 'yes') {
        const remote = remoteOf.get(row.projectId);
        const peers: NexusRegistrySplitPeer[] = remote
          ? rows
              .filter(
                (other) =>
                  other.projectId !== row.projectId &&
                  remoteOf.get(other.projectId) === remote &&
                  !linked(other.projectId, row.projectId),
              )
              .map((other) => ({
                projectId: other.projectId,
                projectPath: other.projectPath,
                registered: true,
                matchedBy: 'remote' as const,
              }))
          : [];
        return classifyHeld(row, peers, cleoHome);
      }
      return classifyGone(row, {
        byId,
        scanned: scan.projects,
        registered,
        linked,
        mine: localById.get(row.projectId) ?? [],
        gone: goneShape(row),
        cleoHome,
        evidenceOf,
      });
    },
  );

  const counts = Object.fromEntries(FINDING_KINDS.map((kind) => [kind, 0])) as Record<
    NexusRegistryFindingKind,
    number
  >;
  for (const p of planned) counts[p.finding.kind]++;
  return {
    report: {
      dryRun: true,
      storePath,
      roots,
      scan: {
        projectsFound: scan.projects.length,
        timedOut: scan.timedOut,
        unreadable: scan.unreadable,
      },
      counts,
      findings: planned.filter((p) => p.finding.kind !== 'ok').map((p) => p.finding),
    },
    planned,
  };
}

/**
 * What a registered path that provably no longer holds its project holds
 * now. Read only after the bounded probe answered `no`, so these reads hit a
 * directory that already responded.
 */
function goneShape(row: RegistryRowView): GoneContext['gone'] {
  if (isSupersededRegistryPath(row.projectPath)) return 'sentinel';
  const declared = readDeclaredProjectIdentity(row.projectPath);
  if (declared && declared.projectId !== row.projectId) return { declares: declared.projectId };
  return existsSync(join(row.projectPath, '.cleo')) || existsSync(row.projectPath)
    ? 'cleo'
    : 'path';
}

/** Resolve the scan budget from options. */
function scanBudget(opts: ProjectRegistryScanOptions) {
  return {
    maxDepth: Math.max(0, Math.min(opts.maxDepth ?? DEFAULT_MAX_DEPTH, 20)),
    concurrency: Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY),
    timeoutMs: Math.max(1, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  };
}

/**
 * Classify every registry row, read-only.
 *
 * @param opts - Extra scan roots, depth, concurrency, per-probe budget, registry home.
 * @returns Counts per kind and every non-`ok` row with its exact remedy.
 *
 * @example
 * ```ts
 * const report = await inspectProjectRegistry({ roots: ['/home/me/src'] });
 * for (const f of report.findings) console.log(f.kind, f.projectPath, f.remedy);
 * ```
 */
export async function inspectProjectRegistry(
  opts: ProjectRegistryScanOptions = {},
): Promise<NexusRegistryIntegrityReport> {
  return (await inspect(opts)).report;
}

/** Stable text of a row, independent of key order. */
function rowKey(row: object): string {
  return JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));
}

/** Sort image rows so two images compare by content. */
function normalizeImage(image: RowImage): RowImage {
  const sort = <T extends object>(rows: readonly T[]): T[] =>
    [...rows].sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
  return {
    registry: sort(image.registry),
    locations: sort(image.locations),
    paths: sort(image.paths),
  };
}

/** Registry schema tables used by the image functions. */
type RegistrySchema = Awaited<ReturnType<typeof openRegistry>>;

/** Read every row of the three tables that names one of `ids` or `paths`. */
function captureImage(
  db: PathMapWriter,
  schema: RegistrySchema,
  ids: readonly string[],
  paths: readonly string[],
): RowImage {
  const { projectRegistry, projectLocations, projectPaths } = schema;
  const registry = new Map<string, ProjectRegistryRow>();
  const locations = new Map<string, ProjectLocationRow>();
  const pathRows = new Map<string, ProjectPathRow>();
  for (const idSlice of chunks(ids.length > 0 ? ids : [''])) {
    for (const pathSlice of chunks(paths.length > 0 ? paths : [''])) {
      for (const row of db
        .select()
        .from(projectRegistry)
        .where(
          or(
            inArray(projectRegistry.projectId, idSlice),
            inArray(projectRegistry.projectPath, pathSlice),
          ),
        )
        .all())
        registry.set(row.projectId, { ...row });
      for (const row of db
        .select()
        .from(projectLocations)
        .where(
          or(
            inArray(projectLocations.projectId, idSlice),
            inArray(projectLocations.path, pathSlice),
          ),
        )
        .all())
        locations.set(`${row.projectId}\u0000${row.deviceId}\u0000${row.path}`, { ...row });
      for (const row of db
        .select()
        .from(projectPaths)
        .where(
          or(
            inArray(projectPaths.projectId, idSlice),
            inArray(projectPaths.projectPath, pathSlice),
          ),
        )
        .all())
        pathRows.set(row.projectPath, { ...row });
    }
  }
  return normalizeImage({
    registry: [...registry.values()],
    locations: [...locations.values()],
    paths: [...pathRows.values()],
  });
}

/** Delete every row of the three tables in scope. */
function deleteScope(
  db: PathMapWriter,
  schema: RegistrySchema,
  ids: readonly string[],
  paths: readonly string[],
): void {
  const { projectRegistry, projectLocations, projectPaths } = schema;
  for (const idSlice of chunks(ids.length > 0 ? ids : [''])) {
    for (const pathSlice of chunks(paths.length > 0 ? paths : [''])) {
      db.delete(projectRegistry)
        .where(
          or(
            inArray(projectRegistry.projectId, idSlice),
            inArray(projectRegistry.projectPath, pathSlice),
          ),
        )
        .run();
      db.delete(projectLocations)
        .where(
          or(
            inArray(projectLocations.projectId, idSlice),
            inArray(projectLocations.path, pathSlice),
          ),
        )
        .run();
      db.delete(projectPaths)
        .where(
          or(
            inArray(projectPaths.projectId, idSlice),
            inArray(projectPaths.projectPath, pathSlice),
          ),
        )
        .run();
    }
  }
}

/**
 * The rows a repair can change, fixed BEFORE it runs so the before and after
 * images cover the same rows: every touched id, every touched path, and the id
 * of any other project registered at a touched path (a rebind re-homes that
 * row). A rollback deletes exactly this scope and re-inserts the before image,
 * so a row outside it is never touched and a row inside it is always restored.
 */
function repairScope(
  db: PathMapWriter,
  schema: RegistrySchema,
  touchedIds: readonly string[],
  touchedPaths: readonly string[],
): { ids: string[]; paths: string[] } {
  const ids = new Set(touchedIds);
  for (const slice of chunks([...new Set(touchedPaths)]))
    for (const row of db
      .select({ projectId: schema.projectRegistry.projectId })
      .from(schema.projectRegistry)
      .where(inArray(schema.projectRegistry.projectPath, slice))
      .all())
      ids.add(row.projectId);
  // Every registry writer re-keys migration-backfilled (`local`) location rows
  // to this device first (adoptLocalDeviceRows). Those rows belong to ANY
  // project, so their ids join the scope: the before image keeps them as they
  // were and a rollback restores them exactly.
  for (const row of db
    .select({ projectId: schema.projectLocations.projectId })
    .from(schema.projectLocations)
    .where(eq(schema.projectLocations.deviceId, LOCAL_DEVICE_SENTINEL))
    .all())
    ids.add(row.projectId);
  return { ids: [...ids].sort(), paths: [...new Set(touchedPaths)].sort() };
}

/**
 * Probe, before the write transaction, every local location the writers
 * would otherwise probe synchronously inside it (T12471): the live locations
 * of each id in scope. Keyed by {@link holdingKey}.
 */
async function preProbe(
  db: PathMapWriter,
  schema: RegistrySchema,
  ids: readonly string[],
  budget: ReturnType<typeof scanBudget>,
): Promise<Map<string, ProjectHolding>> {
  const deviceId = currentDeviceId();
  const targets: Array<{ projectId: string; path: string }> = [];
  for (const slice of chunks(ids))
    for (const l of db
      .select({
        projectId: schema.projectLocations.projectId,
        path: schema.projectLocations.path,
        deviceId: schema.projectLocations.deviceId,
        state: schema.projectLocations.state,
      })
      .from(schema.projectLocations)
      .where(inArray(schema.projectLocations.projectId, slice))
      .all())
      if (l.state === 'live' && (l.deviceId === deviceId || l.deviceId === LOCAL_DEVICE_SENTINEL))
        targets.push(l);
  const holdings = await runWithConcurrency(targets, budget.concurrency, (t) =>
    probeProjectHolding(t.path, t.projectId, budget.timeoutMs),
  );
  return new Map(
    targets.map((t, i) => [holdingKey(t.projectId, t.path), holdings[i] ?? 'unknown']),
  );
}

/**
 * Inspect, then apply the safe repairs: rebind every `moved` row to the path
 * that declares its id, and record every `missing` row's location as
 * `missing`. One immediate transaction makes the changes and writes the
 * receipt (before and after images of every touched row) to
 * `nexus_audit_log`. No row is deleted, and nothing outside the registry is
 * written. A row that changed since inspection is skipped.
 *
 * @param opts - Same options as {@link inspectProjectRegistry}.
 * @returns The report, with `dryRun: false` and a receipt when anything applied.
 *
 * @example
 * ```ts
 * const result = await applyProjectRegistryRepair();
 * if (result.receipt) console.log(result.receipt.rollback);
 * ```
 */
export async function applyProjectRegistryRepair(
  opts: ProjectRegistryScanOptions = {},
): Promise<NexusRegistryIntegrityReport> {
  const { report, planned } = await inspect(opts);
  // A row registered at another row's rebind target moves first, so the later
  // rebind does not displace it to the `superseded:` sentinel.
  const targets = new Set(planned.flatMap((p) => (p.rebindTo ? [p.rebindTo.path] : [])));
  const work = planned
    .filter((p) => p.rebindTo || p.markMissing)
    .sort(
      (a, b) =>
        Number(targets.has(b.finding.projectPath)) - Number(targets.has(a.finding.projectPath)),
    );
  if (work.length === 0) return { ...report, dryRun: false };

  const cleoHome = opts.cleoHome ?? getCleoHome();
  const schema = await openRegistry(cleoHome);
  const { db, storePath, projectRegistry, nexusAuditLog } = schema;
  const receiptId = randomUUID();
  const now = new Date().toISOString();
  const touchedIds = work.map((p) => p.finding.projectId);
  const touchedPaths = work.flatMap((p) =>
    p.rebindTo ? [p.finding.projectPath, p.rebindTo.path] : [p.finding.projectPath],
  );
  // Probe first, write after: no filesystem access inside the IMMEDIATE tx.
  const probed = await preProbe(
    db,
    schema,
    repairScope(db, schema, touchedIds, touchedPaths).ids,
    scanBudget(opts),
  );

  const receipt = db.transaction(
    (tx) => {
      const rowsBefore = tx
        .select({ id: projectRegistry.projectId })
        .from(projectRegistry)
        .all().length;
      const scope = repairScope(tx, schema, touchedIds, touchedPaths);
      const before = captureImage(tx, schema, scope.ids, scope.paths);
      const actions: NexusRegistryRepairAction[] = [];
      for (const p of work) {
        const { projectId, projectPath } = p.finding;
        const current = tx
          .select({ projectPath: projectRegistry.projectPath })
          .from(projectRegistry)
          .where(eq(projectRegistry.projectId, projectId))
          .get();
        const unchanged = current?.projectPath === projectPath;
        if (p.rebindTo) {
          if (unchanged)
            confirmProjectLocation(tx, {
              projectId,
              projectPath: p.rebindTo.path,
              now,
              checkoutNonce: p.rebindTo.nonce,
              probed,
            });
          actions.push({
            action: 'rebind',
            projectId,
            from: projectPath,
            to: p.rebindTo.path,
            outcome: unchanged ? 'applied' : 'skipped',
          });
        } else {
          if (unchanged) demoteProjectLocation(tx, { projectId, projectPath, now }, 'missing');
          actions.push({
            action: 'mark-missing',
            projectId,
            from: projectPath,
            outcome: unchanged ? 'applied' : 'skipped',
          });
        }
      }
      const after = captureImage(tx, schema, scope.ids, scope.paths);
      const result: NexusRegistryRepairReceipt = {
        receiptId,
        storePath,
        appliedAt: now,
        actions,
        registryRows: {
          before: rowsBefore,
          after: tx.select({ id: projectRegistry.projectId }).from(projectRegistry).all().length,
        },
        rollback: `${DOCTOR_COMMAND} --rollback ${receiptId}`,
      };
      const stored: StoredRepair = {
        receipt: result,
        scope,
        before,
        after,
      };
      tx.insert(nexusAuditLog)
        .values({
          id: receiptId,
          action: APPLY_ACTION,
          domain: 'doctor',
          operation: APPLY_ACTION,
          success: 1,
          detailsJson: JSON.stringify(stored),
        })
        .run();
      return result;
    },
    { behavior: 'immediate' },
  );
  return { ...report, dryRun: false, receipt };
}

/** Read and parse a stored repair; `null` when the id is not an applied repair. */
function readStoredRepair(
  db: NodeSQLiteDatabase,
  schema: RegistrySchema,
  receiptId: string,
): StoredRepair | null {
  const row = db
    .select({ action: schema.nexusAuditLog.action, detailsJson: schema.nexusAuditLog.detailsJson })
    .from(schema.nexusAuditLog)
    .where(eq(schema.nexusAuditLog.id, receiptId))
    .get();
  if (!row || row.action !== APPLY_ACTION || !row.detailsJson) return null;
  return JSON.parse(row.detailsJson) as StoredRepair;
}

/**
 * Restore the rows an applied repair changed. Refused when the receipt is
 * unknown, was already rolled back, or when any row in its scope changed
 * since the repair (the current rows must equal the receipt's after image) —
 * a later edit is never overwritten. The rollback writes its own receipt.
 *
 * @param receiptId - `receiptId` from {@link applyProjectRegistryRepair}.
 * @param opts - Registry home.
 * @returns Rows restored per table and the rollback's own receipt id.
 * @throws RegistryRepairError (`E_NOT_FOUND`, `E_ROLLBACK_CONFLICT`).
 *
 * @example
 * ```ts
 * await rollbackProjectRegistryRepair(receipt.receiptId);
 * ```
 */
export async function rollbackProjectRegistryRepair(
  receiptId: string,
  opts: Pick<ProjectRegistryScanOptions, 'cleoHome'> = {},
): Promise<NexusRegistryRollbackResult> {
  const schema = await openRegistry(opts.cleoHome ?? getCleoHome());
  const { db, projectRegistry, projectLocations, projectPaths, nexusAuditLog } = schema;
  const stored = readStoredRepair(db, schema, receiptId);
  if (!stored)
    throw new RegistryRepairError(
      'E_NOT_FOUND',
      `No applied \`${DOCTOR_COMMAND}\` repair has receipt ${receiptId}. List receipts in nexus_audit_log (action ${APPLY_ACTION}).`,
    );
  const rollbackReceiptId = randomUUID();
  return db.transaction(
    (tx) => {
      const prior = tx
        .select({ detailsJson: nexusAuditLog.detailsJson })
        .from(nexusAuditLog)
        .where(eq(nexusAuditLog.action, ROLLBACK_ACTION))
        .all()
        .some((row) => {
          const details = JSON.parse(row.detailsJson ?? '{}') as { rolledBack?: string };
          return details.rolledBack === receiptId;
        });
      if (prior)
        throw new RegistryRepairError(
          'E_ROLLBACK_CONFLICT',
          `Receipt ${receiptId} was already rolled back.`,
        );
      const current = captureImage(tx, schema, stored.scope.ids, stored.scope.paths);
      if (JSON.stringify(current) !== JSON.stringify(normalizeImage(stored.after)))
        throw new RegistryRepairError(
          'E_ROLLBACK_CONFLICT',
          `Rows in the scope of receipt ${receiptId} changed after the repair; rolling back would overwrite that change. ` +
            `Inspect with \`${DOCTOR_COMMAND}\` and repair forward instead.`,
        );
      deleteScope(tx, schema, stored.scope.ids, stored.scope.paths);
      for (const row of stored.before.registry) tx.insert(projectRegistry).values(row).run();
      for (const row of stored.before.locations) tx.insert(projectLocations).values(row).run();
      for (const row of stored.before.paths) tx.insert(projectPaths).values(row).run();
      const restored = {
        registry: stored.before.registry.length,
        locations: stored.before.locations.length,
        paths: stored.before.paths.length,
      };
      tx.insert(nexusAuditLog)
        .values({
          id: rollbackReceiptId,
          action: ROLLBACK_ACTION,
          domain: 'doctor',
          operation: ROLLBACK_ACTION,
          success: 1,
          detailsJson: JSON.stringify({ rolledBack: receiptId, restored, replaced: current }),
        })
        .run();
      return { receiptId, rollbackReceiptId, restored };
    },
    { behavior: 'immediate' },
  );
}

/**
 * For each id, the paths on this device other than `exclude` that provably
 * hold it now: recorded locations of the id that still declare it, plus
 * directories found by scanning `roots`. Used by `nexus projects clean` to
 * refuse deleting a row whose project merely moved (T12471).
 *
 * @param ids - Project ids to look for, with the registered path to exclude.
 * @param opts - Scan roots and budgets; roots default to the parents of the given paths.
 * @returns Map from id to the paths that declare it (ids found nowhere are absent).
 *
 * @example
 * ```ts
 * const found = await locateProjectsElsewhere([{ projectId, projectPath }]);
 * ```
 */
export async function locateProjectsElsewhere(
  ids: ReadonlyArray<{ projectId: string; projectPath: string }>,
  opts: ProjectRegistryScanOptions = {},
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const budget = scanBudget(opts);
  const { db, projectRegistry, projectLocations } = await openRegistry(
    opts.cleoHome ?? getCleoHome(),
  );
  const wanted = new Map(ids.map((i) => [i.projectId, i.projectPath]));
  const add = (id: string, path: string): void => {
    // A trashed checkout does not keep a row alive.
    if (wanted.get(id) === path || isTrashPath(path)) return;
    const list = out.get(id) ?? [];
    if (!list.includes(path)) list.push(path);
    out.set(id, list);
  };

  const deviceId = currentDeviceId();
  const recorded: Array<{ projectId: string; path: string }> = [];
  for (const slice of chunks([...wanted.keys()]))
    for (const l of db
      .select({
        projectId: projectLocations.projectId,
        path: projectLocations.path,
        deviceId: projectLocations.deviceId,
        state: projectLocations.state,
      })
      .from(projectLocations)
      .where(inArray(projectLocations.projectId, slice))
      .all())
      if (
        (l.deviceId === deviceId || l.deviceId === LOCAL_DEVICE_SENTINEL) &&
        l.state !== 'superseded'
      )
        recorded.push(l);
  const holds = await runWithConcurrency(recorded, budget.concurrency, (l) =>
    wanted.get(l.projectId) === l.path
      ? Promise.resolve<ProjectHolding>('no')
      : probeProjectHolding(l.path, l.projectId, budget.timeoutMs),
  );
  recorded.forEach((l, i) => {
    if (holds[i] === 'yes' && readDeclaredProjectIdentity(l.path)?.projectId === l.projectId)
      add(l.projectId, l.path);
  });

  const allPaths = db
    .select({ projectPath: projectRegistry.projectPath })
    .from(projectRegistry)
    .all();
  const roots = scanRootsFor(
    allPaths.map((r) => r.projectPath),
    opts.roots ?? [],
  );
  const scan = await scanRoots(roots, budget);
  for (const project of scan.projects)
    if (wanted.has(project.projectId)) add(project.projectId, project.path);
  return out;
}
