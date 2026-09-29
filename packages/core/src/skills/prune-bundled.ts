/**
 * Prune bundled skills that CLEO no longer installs — quarantining only what
 * CLEO provably wrote (T12678).
 *
 * `initCoreSkills` installs every `@cleocode/skills` manifest entry declared
 * `metadata.install: harness` but never removed anything, so a skill later
 * declared `internal` (ct-grade) or retired (ct-docs-lookup, …) stayed in
 * every harness.
 *
 * ## Ownership — never inferred
 *
 * The canonical skills root (`resolveSkillsRoot()`) is shared: CAAMP
 * installs every user skill there too, so "it is in the root" or "a harness
 * link points into the root" proves only that CAAMP put it there. The ONLY
 * proof CLEO accepts is its own **bundled-install ledger**
 * (`<skillsRoot>/.cleo-bundled.json`), written by `initCoreSkills` at install
 * time with a SHA-256 for every file it wrote. A skill is quarantined only
 * when:
 *
 * - it is a prune candidate (a non-harness manifest entry, or listed in the
 *   manifest's `retiredSkills`);
 * - the ledger records it;
 * - its CAAMP lock entry, if any, has source `library:<name>`, and its
 *   skills.db row, if any, is `canonical` — anything else means a user
 *   installed it;
 * - the files on disk still hash exactly to what the ledger recorded (a
 *   user-edited copy is kept).
 *
 * A harness symlink is taken only when it points exactly at that skill's
 * canonical path; a harness copy only when it hashes to the ledger. Skills
 * installed before the ledger existed have no record and are reported, not
 * pruned.
 *
 * ## Reversible
 *
 * Nothing is deleted. Owned paths are moved into
 * `<cleoHome>/skills-quarantine/<id>/` with a `quarantine.json` describing
 * every move, the lock entry removed and the skills.db state changed;
 * {@link restoreQuarantine} puts all of it back.
 *
 * @task T12678
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { appendFile, cp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** File under the canonical skills root recording what CLEO installed. */
export const BUNDLED_LEDGER_FILE = '.cleo-bundled.json';

/** Directory name, beside the skills root, holding quarantined skills. */
export const QUARANTINE_DIR = 'skills-quarantine';

/** One ledger record: the files CLEO wrote for a skill, by SHA-256. */
export interface BundledLedgerEntry {
  /** ISO timestamp of the install that wrote these files. */
  installedAt: string;
  /** Relative file path → hex SHA-256. */
  files: Record<string, string>;
}

/** The bundled-install ledger. */
export interface BundledLedger {
  /** Format version. */
  version: 2;
  /** Skill name → record. */
  skills: Record<string, BundledLedgerEntry>;
  /**
   * Names the user restored from quarantine. The user chose to keep them, so
   * prune never takes them again.
   */
  kept?: string[];
}

/** What happened to one path. */
export interface BundledSkillPruneAction {
  /** Skill name. */
  name: string;
  /** Absolute path considered. */
  path: string;
  /** `quarantined`, `would-quarantine` (dry run) or `kept`. */
  action: 'quarantined' | 'would-quarantine' | 'kept';
  /** Why. */
  reason: string;
}

/** A CAAMP lock entry, as far as pruning needs it. */
export interface PruneLockEntry {
  /** Original source string (`library:<name>` for bundled installs). */
  source: string;
  /** Every other lock field, preserved for restore. */
  [key: string]: unknown;
}

/** skills.db lifecycle states. */
export type PruneLifecycleState = 'active' | 'stale' | 'archived';

/** Registry access the prune needs (injectable for tests). */
export interface PruneRegistry {
  /** CAAMP lock entry for a skill, or null. */
  lockEntry(name: string): Promise<PruneLockEntry | null>;
  /** Remove a skill's CAAMP lock entry. */
  removeLockEntry(name: string): Promise<void>;
  /** Put a removed lock entry back. */
  restoreLockEntry(name: string, entry: PruneLockEntry): Promise<void>;
  /** skills.db source type and lifecycle state, or null when no row. */
  skillRow(name: string): Promise<{ sourceType: string; lifecycleState: string } | null>;
  /** Set a skills.db row's lifecycle state. */
  setLifecycleState(name: string, state: PruneLifecycleState, from?: string): Promise<void>;
}

/** Everything one quarantine run changed, so it can be restored. */
export interface QuarantineRecord {
  /** Quarantine id (directory name). */
  id: string;
  /** ISO timestamp. */
  at: string;
  /** Moves performed, in order. */
  moves: Array<{ name: string; from: string; to: string }>;
  /** Lock entries removed. */
  lockEntries: Array<{ name: string; entry: PruneLockEntry }>;
  /** skills.db rows archived, with their prior state. */
  rows: Array<{ name: string; priorState: string }>;
}

/** Receipt for one prune run. */
export interface BundledSkillPruneReceipt {
  /** ISO timestamp. */
  at: string;
  /** True when nothing was moved. */
  dryRun: boolean;
  /** Names the bundled manifest says CLEO must not install. */
  candidates: string[];
  /** Per-path outcomes. */
  actions: BundledSkillPruneAction[];
  /** Quarantine id, when anything was moved. */
  quarantineId: string | null;
  /** Failures (`path: message`). */
  errors: string[];
}

/** Inputs for {@link pruneBundledSkills}. */
export interface PruneBundledSkillsOptions {
  /** `<@cleocode/skills>/skills` — holds `manifest.json`. */
  bundledSkillsDir: string;
  /** CLEO's canonical skills root. */
  skillsRoot: string;
  /** Harness skills directories. */
  providerSkillDirs: string[];
  /** Lock and skills.db access. */
  registry: PruneRegistry;
  /** Report only. */
  dryRun?: boolean;
  /** Quarantine root; defaults to `<dirname(skillsRoot)>/skills-quarantine`. */
  quarantineRoot?: string;
  /** JSONL receipt log; appended on a non-dry run that moved anything. */
  receiptPath?: string;
}

/** Shape of the bundled manifest fields this module reads. */
interface BundledManifest {
  skills?: Array<{ name?: string; install?: string }>;
  retiredSkills?: string[];
}

/**
 * Names the bundled manifest says must not be installed to harnesses.
 *
 * @param manifest - Parsed `skills/manifest.json`.
 * @returns Sorted unique candidate names.
 */
export function pruneCandidates(manifest: BundledManifest): string[] {
  const names = new Set<string>();
  for (const s of manifest.skills ?? []) {
    if (typeof s.name === 'string' && s.install !== 'harness') names.add(s.name);
  }
  for (const n of manifest.retiredSkills ?? []) names.add(n);
  return [...names].sort();
}

/**
 * SHA-256 of every file under `dir` (relative POSIX paths), skipping
 * `__pycache__`. Empty when `dir` is missing.
 *
 * @param dir - Directory to hash.
 * @returns Relative path → hex digest.
 */
export function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string, rel: string): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.name === '__pycache__') continue;
      const childAbs = join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(childAbs, childRel);
      else if (e.isFile()) {
        out[childRel] = createHash('sha256').update(readFileSync(childAbs)).digest('hex');
      }
    }
  };
  try {
    walk(dir, '');
  } catch {
    return {};
  }
  return out;
}

/**
 * Whether a directory still holds exactly the files the ledger recorded.
 *
 * @param dir - Directory on disk.
 * @param files - Ledger file hashes.
 * @returns `true` on an exact match (same paths, same bytes).
 */
function matchesLedger(dir: string, files: Record<string, string>): boolean {
  const actual = hashTree(dir);
  const want = Object.keys(files).sort();
  const have = Object.keys(actual).sort();
  if (want.length === 0 || want.join('\n') !== have.join('\n')) return false;
  return want.every((f) => actual[f] === files[f]);
}

/**
 * Read the bundled-install ledger; an absent, unreadable or older-format
 * ledger yields an empty one (nothing is then provably CLEO's).
 *
 * @param skillsRoot - Canonical skills root.
 * @returns The ledger.
 */
export function readBundledLedger(skillsRoot: string): BundledLedger {
  try {
    const data = JSON.parse(readFileSync(join(skillsRoot, BUNDLED_LEDGER_FILE), 'utf-8')) as {
      version?: number;
      skills?: Record<string, BundledLedgerEntry>;
      kept?: unknown;
    };
    if (data.version === 2 && data.skills && typeof data.skills === 'object') {
      const kept = Array.isArray(data.kept)
        ? data.kept.filter((n): n is string => typeof n === 'string')
        : [];
      return { version: 2, skills: data.skills, ...(kept.length > 0 ? { kept } : {}) };
    }
  } catch {
    // absent or unreadable
  }
  return { version: 2, skills: {} };
}

/**
 * Write the ledger.
 *
 * @param skillsRoot - Canonical skills root.
 * @param ledger - Ledger to write.
 */
async function writeLedger(skillsRoot: string, ledger: BundledLedger): Promise<void> {
  await mkdir(skillsRoot, { recursive: true });
  await writeFile(join(skillsRoot, BUNDLED_LEDGER_FILE), `${JSON.stringify(ledger, null, 2)}\n`);
}

/**
 * Record the skills CLEO just installed from the bundle, hashing the files
 * it wrote into each canonical copy.
 *
 * @param skillsRoot - Canonical skills root.
 * @param names - Skills installed by this run.
 */
export async function recordBundledInstalls(skillsRoot: string, names: string[]): Promise<void> {
  const ledger = readBundledLedger(skillsRoot);
  const now = new Date().toISOString();
  for (const name of names) {
    const files = hashTree(join(skillsRoot, name));
    if (Object.keys(files).length > 0) ledger.skills[name] = { installedAt: now, files };
  }
  await writeLedger(skillsRoot, ledger);
}

/**
 * Where a symlink points, even when the target is gone.
 *
 * @param linkPath - Symlink path.
 * @returns Absolute target.
 */
function linkTarget(linkPath: string): string {
  const raw = readlinkSync(linkPath);
  return isAbsolute(raw) ? raw : resolve(dirname(linkPath), raw);
}

/**
 * Real path when it exists, otherwise the resolved path.
 *
 * @param p - Path.
 * @returns Canonical path for equality checks.
 */
function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Whether anything (including a dangling symlink) exists at `p`.
 *
 * @param p - Path.
 * @returns `true` when lstat succeeds.
 */
function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move a path, falling back to copy + remove across devices.
 *
 * @param from - Source.
 * @param to - Destination (must not exist).
 */
async function movePath(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await cp(from, to, { recursive: true, verbatimSymlinks: true });
    await rm(from, { recursive: true, force: true });
  }
}

/**
 * Quarantine harness entries and canonical copies of skills CLEO no longer
 * installs, where the ledger proves CLEO wrote them and they are unmodified.
 * See the module doc.
 *
 * @param opts - Paths, registry, dry-run flag.
 * @returns The receipt.
 */
export async function pruneBundledSkills(
  opts: PruneBundledSkillsOptions,
): Promise<BundledSkillPruneReceipt> {
  const dryRun = opts.dryRun === true;
  const manifest: BundledManifest = JSON.parse(
    readFileSync(join(opts.bundledSkillsDir, 'manifest.json'), 'utf-8'),
  );
  const candidates = pruneCandidates(manifest);
  const ledger = readBundledLedger(opts.skillsRoot);
  const providerDirs = [...new Set(opts.providerSkillDirs)];
  const actions: BundledSkillPruneAction[] = [];
  const errors: string[] = [];
  const at = new Date().toISOString();
  const id = `${at.replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const qroot = join(opts.quarantineRoot ?? join(dirname(opts.skillsRoot), QUARANTINE_DIR), id);
  const record: QuarantineRecord = { id, at, moves: [], lockEntries: [], rows: [] };

  const keep = (name: string, path: string, reason: string): void => {
    actions.push({ name, path, action: 'kept', reason });
  };
  /**
   * Write quarantine.json. Called BEFORE each change it describes, so a crash
   * mid-run never leaves a moved path, removed lock entry or archived row
   * without a record; restore skips a recorded move that never happened.
   */
  const persist = async (): Promise<void> => {
    await mkdir(qroot, { recursive: true });
    await writeFile(join(qroot, 'quarantine.json'), `${JSON.stringify(record, null, 2)}\n`);
  };
  const take = async (name: string, path: string, reason: string): Promise<boolean> => {
    if (dryRun) {
      actions.push({ name, path, action: 'would-quarantine', reason });
      return true;
    }
    const to = join(qroot, 'files', String(record.moves.length), name);
    record.moves.push({ name, from: path, to });
    try {
      await persist();
      await movePath(path, to);
      actions.push({ name, path, action: 'quarantined', reason });
      return true;
    } catch (err) {
      record.moves.pop();
      await persist().catch(() => undefined);
      errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };
  const keptByUser = new Set(ledger.kept ?? []);

  for (const name of candidates) {
    const canonical = join(opts.skillsRoot, name);
    const harness = providerDirs.map((d) => join(d, name)).filter(exists);
    const present = [...(existsSync(canonical) ? [canonical] : []), ...harness];
    if (present.length === 0) continue;

    if (keptByUser.has(name)) {
      for (const p of present) keep(name, p, 'restored from quarantine by the user');
      continue;
    }
    const entry = ledger.skills[name];
    if (!entry) {
      for (const p of present) {
        keep(
          name,
          p,
          'no bundled-install ledger record (installed before the ledger, or by the user)',
        );
      }
      continue;
    }
    const lock = await opts.registry.lockEntry(name);
    if (lock && lock.source !== `library:${name}`) {
      for (const p of present)
        keep(name, p, `CAAMP lock says it was installed from ${lock.source}`);
      continue;
    }
    const row = await opts.registry.skillRow(name);
    if (row && row.sourceType !== 'canonical') {
      for (const p of present) keep(name, p, `skills.db records a ${row.sourceType} install`);
      continue;
    }

    const canonicalReal = realOrResolved(canonical);
    const canonicalOwned = existsSync(canonical) && matchesLedger(canonical, entry.files);
    if (existsSync(canonical) && !canonicalOwned) {
      keep(name, canonical, 'modified since CLEO installed it (hashes differ from the ledger)');
    }

    for (const p of harness) {
      if (lstatSync(p).isSymbolicLink()) {
        const target = realOrResolved(linkTarget(p));
        const pointsAtCanonical = target === canonicalReal || target === resolve(canonical);
        if (pointsAtCanonical && (canonicalOwned || !existsSync(canonical))) {
          await take(name, p, 'CLEO link to its unmodified canonical copy');
        } else {
          keep(
            name,
            p,
            pointsAtCanonical
              ? 'links to a modified canonical copy'
              : `links elsewhere (${target})`,
          );
        }
      } else if (realOrResolved(p) === canonicalReal) {
        // The canonical copy reached through a linked harness dir — handled below.
      } else if (matchesLedger(p, entry.files)) {
        await take(name, p, 'copy identical to what CLEO installed');
      } else {
        keep(name, p, 'directory differs from what CLEO installed');
      }
    }

    if (!canonicalOwned) continue;
    const moved = await take(name, canonical, 'unmodified CLEO install (ledger hashes match)');
    if (!moved || dryRun) continue;
    delete ledger.skills[name];
    await writeLedger(opts.skillsRoot, ledger);
    if (lock) {
      record.lockEntries.push({ name, entry: lock });
      await persist();
      await opts.registry.removeLockEntry(name);
    }
    if (row) {
      record.rows.push({ name, priorState: row.lifecycleState });
      await persist();
      await opts.registry.setLifecycleState(name, 'archived', canonical);
    }
  }

  const movedAny = record.moves.length > 0;
  const receipt: BundledSkillPruneReceipt = {
    at,
    dryRun,
    candidates,
    actions,
    quarantineId: movedAny ? id : null,
    errors,
  };
  if (movedAny && opts.receiptPath) {
    await mkdir(dirname(opts.receiptPath), { recursive: true });
    await appendFile(opts.receiptPath, `${JSON.stringify(receipt)}\n`);
  }
  return receipt;
}

/**
 * List quarantine ids, newest first.
 *
 * @param quarantineRoot - Quarantine root.
 * @returns Ids that carry a `quarantine.json`.
 */
export function listQuarantines(quarantineRoot: string): string[] {
  if (!existsSync(quarantineRoot)) return [];
  return readdirSync(quarantineRoot)
    .filter((d) => existsSync(join(quarantineRoot, d, 'quarantine.json')))
    .sort()
    .reverse();
}

/**
 * Put back everything one quarantine run moved: files and links, CAAMP lock
 * entries and skills.db lifecycle states. A skill whose path is occupied again
 * (the user reinstalled it) is reported as a conflict, and its lock entry and
 * row are left alone. Every cleanly restored skill joins the ledger's `kept`
 * list, so later prunes leave it in place.
 *
 * @param opts - Quarantine root and id, skills root, registry.
 * @returns What was restored and what could not be (destination occupied).
 */
export async function restoreQuarantine(opts: {
  quarantineRoot: string;
  id: string;
  skillsRoot: string;
  registry: PruneRegistry;
}): Promise<{ restored: string[]; conflicts: string[] }> {
  const dir = join(opts.quarantineRoot, opts.id);
  const record: QuarantineRecord = JSON.parse(readFileSync(join(dir, 'quarantine.json'), 'utf-8'));
  const restored: string[] = [];
  const conflicts: string[] = [];
  const conflicted = new Set<string>();
  for (const m of [...record.moves].reverse()) {
    // Recorded before the move; a crash in between means it never happened.
    if (!exists(m.to)) continue;
    if (exists(m.from)) {
      conflicts.push(m.from);
      conflicted.add(m.name);
      continue;
    }
    await movePath(m.to, m.from);
    restored.push(m.from);
  }
  // A conflict means the user reinstalled the skill since the prune; its
  // lock entry and skills.db row now describe that install, so leave them.
  for (const l of record.lockEntries) {
    if (!conflicted.has(l.name)) await opts.registry.restoreLockEntry(l.name, l.entry);
  }
  for (const r of record.rows) {
    if (conflicted.has(r.name)) continue;
    const prior: PruneLifecycleState =
      r.priorState === 'stale' || r.priorState === 'archived' ? r.priorState : 'active';
    await opts.registry.setLifecycleState(r.name, prior);
  }
  // Restoring is the user choosing to keep the skill: mark it kept rather
  // than re-recording CLEO ownership, or the next prune would take it again.
  const ledger = readBundledLedger(opts.skillsRoot);
  const kept = new Set(ledger.kept ?? []);
  for (const name of new Set(record.moves.map((m) => m.name))) {
    if (conflicted.has(name)) continue;
    kept.add(name);
    delete ledger.skills[name];
  }
  ledger.kept = [...kept].sort();
  await writeLedger(opts.skillsRoot, ledger);
  if (conflicts.length === 0) await rm(dir, { recursive: true, force: true });
  return { restored, conflicts };
}

/**
 * The real registry: CAAMP's lock file and CLEO's skills.db.
 *
 * @returns A {@link PruneRegistry}.
 */
export async function defaultPruneRegistry(): Promise<PruneRegistry> {
  const caamp = await import('@cleocode/caamp');
  const db = await import('../store/skills-db.js');
  type SourceType = Parameters<typeof caamp.recordSkillInstall>[3];
  return {
    async lockEntry(name) {
      const e = (await caamp.getTrackedSkills())[name];
      return e ? { ...e } : null;
    },
    async removeLockEntry(name) {
      await caamp.removeSkillFromLock(name);
    },
    async restoreLockEntry(name, entry) {
      await caamp.recordSkillInstall(
        name,
        typeof entry['scopedName'] === 'string' ? entry['scopedName'] : name,
        entry.source,
        entry['sourceType'] as SourceType,
        Array.isArray(entry['agents']) ? entry['agents'].filter((a) => typeof a === 'string') : [],
        typeof entry['canonicalPath'] === 'string' ? entry['canonicalPath'] : '',
        entry['isGlobal'] !== false,
        typeof entry['projectDir'] === 'string' ? entry['projectDir'] : undefined,
        typeof entry['version'] === 'string' ? entry['version'] : undefined,
      );
    },
    async skillRow(name) {
      try {
        const row = await db.getSkillRow(name);
        return row ? { sourceType: row.sourceType, lifecycleState: row.lifecycleState } : null;
      } catch {
        return null;
      }
    },
    async setLifecycleState(name, state, from) {
      await db.setSkillLifecycleState(name, state, from);
    },
  };
}

/**
 * Real paths for the installed CLEO: bundle dir, canonical root, harness
 * dirs, quarantine root.
 *
 * @returns Resolved context, or `null` when the bundled skills are missing.
 */
async function realPruneContext(): Promise<{
  bundledSkillsDir: string;
  skillsRoot: string;
  providerSkillDirs: string[];
  quarantineRoot: string;
} | null> {
  const { getInstalledProviders, resolveProviderSkillsDirs } = await import('@cleocode/caamp');
  const { resolveBundledSkillsDir, resolveSkillsRoot } = await import('./skill-root.js');
  const bundledSkillsDir = resolveBundledSkillsDir();
  if (!bundledSkillsDir) return null;
  const skillsRoot = resolveSkillsRoot();
  return {
    bundledSkillsDir,
    skillsRoot,
    providerSkillDirs: getInstalledProviders().flatMap((p) =>
      resolveProviderSkillsDirs(p, 'global'),
    ),
    quarantineRoot: join(dirname(skillsRoot), QUARANTINE_DIR),
  };
}

/**
 * Run the bundled-skill prune against this machine (`cleo skills doctor
 * prune`).
 *
 * @param opts - `dryRun` reports without moving anything.
 * @returns The receipt, or `null` when the bundled skills cannot be found.
 */
export async function runBundledSkillPrune(opts: {
  dryRun?: boolean;
}): Promise<BundledSkillPruneReceipt | null> {
  const ctx = await realPruneContext();
  if (!ctx) return null;
  return pruneBundledSkills({
    ...ctx,
    registry: await defaultPruneRegistry(),
    dryRun: opts.dryRun === true,
    receiptPath: join(ctx.skillsRoot, '.prune-receipts.jsonl'),
  });
}

/**
 * List quarantines, or restore one (`cleo skills doctor restore [id]`).
 *
 * @param id - Quarantine id; omit to list.
 * @returns The ids, or the restore outcome.
 */
export async function restoreBundledSkillQuarantine(
  id?: string,
): Promise<{ quarantines: string[] } | { restored: string[]; conflicts: string[] }> {
  const { resolveSkillsRoot } = await import('./skill-root.js');
  const skillsRoot = resolveSkillsRoot();
  const quarantineRoot = join(dirname(skillsRoot), QUARANTINE_DIR);
  if (!id) return { quarantines: listQuarantines(quarantineRoot) };
  return restoreQuarantine({
    quarantineRoot,
    id,
    skillsRoot,
    registry: await defaultPruneRegistry(),
  });
}

/**
 * Dry-run the prune `initCoreSkills` would perform against the real bundle,
 * canonical root, harnesses and registries.
 *
 * @returns One line per path that would be quarantined or kept.
 */
export async function previewBundledSkillPrune(): Promise<string[]> {
  const receipt = await runBundledSkillPrune({ dryRun: true });
  if (!receipt) return [];
  return receipt.actions.map((a) =>
    a.action === 'would-quarantine'
      ? `skills: would quarantine ${a.path} (${a.reason})`
      : `skills: would keep ${a.path} (${a.reason})`,
  );
}
