/**
 * Skills migration helpers — legacy XDG store → `~/.cleo/skills/` (SSoT).
 *
 * @remarks
 * Implements the filesystem half of `cleo skills doctor migrate` (T9653).
 * Pure functions only — every side effect is parameterised so the CLI handler
 * and tests can drive identical code paths against tmpdirs.
 *
 * Migration shape (per architecture-v3.md §1):
 *
 * 1. **Detect** legacy install at `~/.local/share/agents/skills/`.
 * 2. **Plan** the set of skill directories to copy into `~/.cleo/skills/`
 *    (skipping any name already present at the new root — first-wins).
 * 3. **Backup** the entire legacy tree to a timestamped tgz under
 *    `~/.cleo/backups/skills/skills-pre-migrate-<ts>.tgz` BEFORE any write.
 * 4. **Copy** (recursively) each planned entry from legacy → canonical.
 * 5. **Marker** writes a `.MIGRATED-TO-CLEO` sentinel into the legacy root so
 *    re-runs detect the already-migrated state and become a no-op. The legacy
 *    tree itself is left intact for one release cycle as a safety net.
 *
 * Rollback (`--rollback`) restores from the most recent backup tarball by
 * extracting it back over `~/.local/share/agents/skills/` and removing the
 * sentinel.
 *
 * Side-effect injection: `now` (timestamp) and `tarExec` (child-process
 * wrapper) are parameters so tests can deterministically drive the planner +
 * runner. The default `tarExec` shells out to the system `tar` binary; tests
 * supply an in-memory fake.
 *
 * @task T9653
 * @epic T9571
 * @saga T9560
 * @architecture docs/architecture/SG-CLEO-SKILLS-architecture-v3.md §1
 */

import { execFile } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Filename of the legacy-root sentinel written after a successful migration.
 *
 * @remarks
 * The presence of this file in the legacy skills directory short-circuits
 * subsequent migrate runs to a no-op. It is also removed by `--rollback`.
 *
 * @public
 */
export const LEGACY_MIGRATED_MARKER = '.MIGRATED-TO-CLEO';

/**
 * Provenance row that the migrator emits per migrated skill directory.
 *
 * @remarks
 * The CLI handler funnels these into a callback (`recordRow`) so that the
 * skills.db upsert lives in the dispatch layer (`packages/cleo/`), keeping
 * caamp free of a circular `@cleocode/core` import. See architecture-v3.md
 * §4 for the matching `skills` table schema.
 *
 * @public
 */
export interface MigratedSkillRecord {
  /** Skill folder basename (matches `skills.name` column). */
  name: string;
  /** Resolved destination path under `~/.cleo/skills/`. */
  installPath: string;
  /** Resolved source path under the legacy XDG store. */
  legacyPath: string;
  /** `canonical` when the basename matches the bundled manifest, else `user`. */
  sourceType: 'canonical' | 'user' | 'community';
}

/**
 * Provenance row for skills that were SKIPPED during planning.
 *
 * @remarks
 * The most common skip reason is `'already-present'` — the same directory
 * name already exists under `~/.cleo/skills/`. We never overwrite a
 * pre-existing target because the canonical store may have been touched by
 * a newer install path. Returned to callers so they can present the user
 * with an actionable summary (and optionally remove dupes by hand).
 *
 * @public
 */
export interface SkippedSkillRecord {
  /** Skill folder basename. */
  name: string;
  /** Reason for skipping. */
  reason: 'already-present' | 'not-a-directory';
  /** Resolved legacy path that triggered the skip. */
  legacyPath: string;
}

/**
 * Aggregated outcome of a planning or migration pass.
 *
 * @remarks
 * `backupPath` is `null` when running in dry-run mode (no archive is
 * produced) or when there are no entries to migrate. `durationMs` is wall
 * clock from the start of {@link runMigration} until the marker write.
 *
 * @public
 */
export interface MigrationOutcome {
  /** Action that was performed — `'migrate'`, `'dry-run'`, `'rollback'`, `'no-op'`. */
  action: 'migrate' | 'dry-run' | 'rollback' | 'no-op';
  /** Entries that were (or would be) copied across. */
  migrated: MigratedSkillRecord[];
  /** Entries that were SKIPPED with reasons. */
  skipped: SkippedSkillRecord[];
  /** Path to the produced backup archive, or `null` on dry-run / no-op. */
  backupPath: string | null;
  /** Resolved legacy root the migrator was driven against. */
  legacyRoot: string;
  /** Resolved destination root the migrator was driven against. */
  canonicalRoot: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

/**
 * Inputs every migration helper accepts.
 *
 * @remarks
 * All filesystem roots and side effects are parameterised so tests can wire
 * tmpdirs + fakes without monkey-patching `os.homedir()`. Production callers
 * use {@link defaultMigrationOptions} to fill the defaults.
 *
 * @public
 */
export interface MigrationOptions {
  /** Legacy skills directory (default: `~/.local/share/agents/skills`). */
  legacyRoot: string;
  /** Destination canonical skills directory (default: `~/.cleo/skills`). */
  canonicalRoot: string;
  /** Backup directory (default: `~/.cleo/backups/skills`). */
  backupDir: string;
  /** Names of canonical skills from the bundled manifest (sphere-A discriminator). */
  manifestNames: string[];
  /** Wall-clock injection for testability. Defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * `tar` wrapper for testability. Default implementation shells out to the
   * system `tar` binary; tests pass an in-memory fake.
   */
  tarExec?: TarExec;
  /**
   * Per-row sink invoked after each successful copy. The CLI handler in
   * `packages/cleo/` plugs `upsertSkillRow` here without caamp needing a
   * `@cleocode/core` dep. Defaults to a no-op.
   */
  recordRow?: (row: MigratedSkillRecord) => Promise<void> | void;
}

/**
 * Shape of the optional tar wrapper used by {@link MigrationOptions}.
 *
 * @remarks
 * Tests can swap the default `execFile`-backed implementation for a pure
 * in-memory fake. The functions return on success and throw on failure
 * (mirroring `execFileAsync` semantics).
 *
 * @public
 */
export interface TarExec {
  /** Create a tgz at `archivePath` containing the contents of `sourceRoot`. */
  create(args: { archivePath: string; sourceRoot: string }): Promise<void>;
  /** Extract a tgz from `archivePath` back into `destinationRoot`. */
  extract(args: { archivePath: string; destinationRoot: string }): Promise<void>;
}

/**
 * Build a {@link MigrationOptions} bag populated with production defaults.
 *
 * @remarks
 * Reads `$HOME` via {@link homedir} and wires the canonical paths described
 * in architecture-v3.md §1. Callers that want to override only some fields
 * spread the result, e.g. `{ ...defaultMigrationOptions(names), recordRow }`.
 *
 * @param manifestNames - Canonical-skill names parsed from the bundled
 *   manifest (`packages/skills/manifest.json`). Used to discriminate
 *   `source_type` for the {@link MigratedSkillRecord} payload.
 * @returns A complete options bag for the migration helpers.
 *
 * @public
 */
export function defaultMigrationOptions(manifestNames: string[]): MigrationOptions {
  const home = homedir();
  return {
    legacyRoot: join(home, '.local', 'share', 'agents', 'skills'),
    canonicalRoot: join(home, '.cleo', 'skills'),
    backupDir: join(home, '.cleo', 'backups', 'skills'),
    manifestNames,
    now: () => new Date(),
    tarExec: systemTarExec,
    recordRow: () => undefined,
  };
}

/**
 * Default {@link TarExec} that shells out to the system `tar` binary.
 *
 * @remarks
 * Uses `-czf` for create and `-xzf` for extract — the same flags the rest of
 * the CLEO backup pipeline (e.g. `cleo backup add`) relies on. Surfaces
 * stderr in thrown errors so callers can debug missing dependencies.
 *
 * @public
 */
export const systemTarExec: TarExec = {
  async create({ archivePath, sourceRoot }) {
    // -C parent + basename keeps the archive root scoped (no absolute paths).
    const parent = join(sourceRoot, '..');
    const base = sourceRoot.slice(parent.length + 1);
    await execFileAsync('tar', ['-czf', archivePath, '-C', parent, base]);
  },
  async extract({ archivePath, destinationRoot }) {
    mkdirSync(destinationRoot, { recursive: true });
    // -C destination/.. so the archive's top-level dir lands at destination.
    const parent = join(destinationRoot, '..');
    await execFileAsync('tar', ['-xzf', archivePath, '-C', parent]);
  },
};

/**
 * Detect whether the legacy XDG store has already been migrated.
 *
 * @remarks
 * Returns `true` when the legacy root either does not exist OR contains the
 * {@link LEGACY_MIGRATED_MARKER} sentinel. The CLI handler uses this to
 * short-circuit to a `'no-op'` outcome on idempotent re-runs.
 *
 * @param legacyRoot - Absolute path to the legacy skills directory.
 * @returns `true` when no migration work is needed.
 *
 * @public
 */
export function isAlreadyMigrated(legacyRoot: string): boolean {
  if (!existsSync(legacyRoot)) return true;
  return existsSync(join(legacyRoot, LEGACY_MIGRATED_MARKER));
}

/**
 * Enumerate the top-level skill directories under a given root.
 *
 * @remarks
 * Filters out the migration sentinel and any non-directory entries (the
 * legacy tree historically also contained stray lock files). Returned in
 * stable lexicographic order so plans are reproducible across runs.
 *
 * @param root - Directory to scan; if missing, returns an empty array.
 * @returns Skill folder basenames in lexicographic order.
 *
 * @public
 */
export function listSkillDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true });
  return entries
    .filter((d) => d.isDirectory() && d.name !== LEGACY_MIGRATED_MARKER)
    .map((d) => d.name)
    .sort();
}

/**
 * Plan a migration without performing any writes.
 *
 * @remarks
 * Used both as the engine for `--dry-run` and as the first step of a real
 * migration. Resolves which entries will be copied vs skipped based on
 * presence-at-destination. The returned outcome carries `action: 'dry-run'`
 * and `durationMs` reflecting the planning cost only.
 *
 * @param options - Resolved migration options (see {@link MigrationOptions}).
 * @returns Outcome describing the planned migration.
 *
 * @public
 */
export function planMigration(options: MigrationOptions): MigrationOutcome {
  const start = Date.now();
  const migrated: MigratedSkillRecord[] = [];
  const skipped: SkippedSkillRecord[] = [];

  if (isAlreadyMigrated(options.legacyRoot)) {
    return {
      action: 'no-op',
      migrated,
      skipped,
      backupPath: null,
      legacyRoot: options.legacyRoot,
      canonicalRoot: options.canonicalRoot,
      durationMs: Date.now() - start,
    };
  }

  const names = listSkillDirs(options.legacyRoot);
  for (const name of names) {
    const legacyPath = join(options.legacyRoot, name);
    if (!statSync(legacyPath).isDirectory()) {
      skipped.push({ name, reason: 'not-a-directory', legacyPath });
      continue;
    }
    const destPath = join(options.canonicalRoot, name);
    if (existsSync(destPath)) {
      skipped.push({ name, reason: 'already-present', legacyPath });
      continue;
    }
    migrated.push({
      name,
      installPath: destPath,
      legacyPath,
      sourceType: options.manifestNames.includes(name) ? 'canonical' : 'user',
    });
  }

  return {
    action: 'dry-run',
    migrated,
    skipped,
    backupPath: null,
    legacyRoot: options.legacyRoot,
    canonicalRoot: options.canonicalRoot,
    durationMs: Date.now() - start,
  };
}

/**
 * Format a UTC timestamp suitable for backup filenames.
 *
 * @remarks
 * Produces `YYYYMMDD-HHmmss` in UTC so the lexicographic order matches
 * chronological order. Exposed publicly so tests and downstream callers can
 * generate matching filenames without re-implementing the format.
 *
 * @param now - The `Date` to format.
 * @returns A filename-safe timestamp string.
 *
 * @public
 */
export function formatBackupTimestamp(now: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return (
    `${now.getUTCFullYear()}` +
    `${pad(now.getUTCMonth() + 1)}` +
    `${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}` +
    `${pad(now.getUTCMinutes())}` +
    `${pad(now.getUTCSeconds())}`
  );
}

/**
 * List backup tarballs in chronological order (newest first).
 *
 * @remarks
 * Used by `--rollback` to pick the most recent archive. Returns absolute
 * paths so callers do not need to know the backup directory layout.
 *
 * @param backupDir - Directory that holds `skills-pre-migrate-*.tgz`.
 * @returns Absolute paths, newest first; empty when the directory is empty.
 *
 * @public
 */
export function listBackups(backupDir: string): string[] {
  if (!existsSync(backupDir)) return [];
  const files = readdirSync(backupDir).filter(
    (f) => f.startsWith('skills-pre-migrate-') && f.endsWith('.tgz'),
  );
  // Filename embeds an UTC timestamp, so reverse lex sort = newest first.
  files.sort().reverse();
  return files.map((f) => join(backupDir, f));
}

/**
 * Perform a real migration from legacy → canonical, leaving a sentinel
 * behind in the legacy root so subsequent runs are no-ops.
 *
 * @remarks
 * Steps performed (in order):
 *
 * 1. Short-circuit to `{action:'no-op'}` if the sentinel already exists.
 * 2. Compute the plan via {@link planMigration} (read-only).
 * 3. Create `~/.cleo/skills/` and the backup dir.
 * 4. Tar+gzip the entire legacy tree into the timestamped backup path.
 * 5. `cp -a` each planned entry (recursive, preserves symlinks + mtime).
 * 6. Invoke `recordRow` for each migrated entry (db side-effect hook).
 * 7. Write the sentinel into the legacy root.
 *
 * On error before step 7 the partial state is left in place — re-running
 * after fixing the error will pick up any entries that weren't copied
 * (idempotent at the directory level: existing destinations are skipped).
 *
 * @param options - Resolved migration options.
 * @returns Outcome describing the work performed.
 *
 * @public
 */
export async function runMigration(options: MigrationOptions): Promise<MigrationOutcome> {
  const start = Date.now();
  const now = (options.now ?? (() => new Date()))();
  const tar = options.tarExec ?? systemTarExec;
  const sink = options.recordRow ?? (() => undefined);

  if (isAlreadyMigrated(options.legacyRoot)) {
    return {
      action: 'no-op',
      migrated: [],
      skipped: [],
      backupPath: null,
      legacyRoot: options.legacyRoot,
      canonicalRoot: options.canonicalRoot,
      durationMs: Date.now() - start,
    };
  }

  const plan = planMigration(options);

  // Ensure destination + backup directories exist before any write.
  mkdirSync(options.canonicalRoot, { recursive: true });
  mkdirSync(options.backupDir, { recursive: true });

  // Step 1: backup BEFORE any destructive op.
  const backupName = `skills-pre-migrate-${formatBackupTimestamp(now)}.tgz`;
  const backupPath = join(options.backupDir, backupName);
  await tar.create({ archivePath: backupPath, sourceRoot: options.legacyRoot });

  // Step 2: copy each planned entry.
  for (const entry of plan.migrated) {
    cpSync(entry.legacyPath, entry.installPath, { recursive: true, dereference: false });
    await sink(entry);
  }

  // Step 3: drop the sentinel so subsequent runs become no-ops.
  writeFileSync(
    join(options.legacyRoot, LEGACY_MIGRATED_MARKER),
    JSON.stringify(
      {
        migratedAt: now.toISOString(),
        backupPath,
        canonicalRoot: options.canonicalRoot,
        entries: plan.migrated.length,
      },
      null,
      2,
    ),
    'utf-8',
  );

  return {
    action: 'migrate',
    migrated: plan.migrated,
    skipped: plan.skipped,
    backupPath,
    legacyRoot: options.legacyRoot,
    canonicalRoot: options.canonicalRoot,
    durationMs: Date.now() - start,
  };
}

/**
 * Restore the legacy skills tree from the most recent backup tarball.
 *
 * @remarks
 * Steps performed (in order):
 *
 * 1. Locate the newest tarball via {@link listBackups}; error if none.
 * 2. Delete the existing legacy root (including the sentinel) so the
 *    extract lands in a clean directory.
 * 3. Extract the tarball back over the legacy root.
 *
 * Rollback is intentionally non-destructive toward the new `~/.cleo/skills/`
 * directory: copies that were already made remain in place. The next migrate
 * call will short-circuit any names that already exist at the destination
 * (idempotent overlap handling).
 *
 * @param options - Resolved migration options.
 * @returns Outcome describing the rollback.
 * @throws If no backup tarballs are available under `options.backupDir`.
 *
 * @public
 */
export async function runRollback(options: MigrationOptions): Promise<MigrationOutcome> {
  const start = Date.now();
  const tar = options.tarExec ?? systemTarExec;

  const backups = listBackups(options.backupDir);
  const newest = backups[0];
  if (!newest) {
    throw new Error(
      `No backup tarballs found under ${options.backupDir}. ` +
        `Run "cleo skills migrate" (without --rollback) first.`,
    );
  }

  // Wipe the legacy root (including any sentinel) before extracting.
  if (existsSync(options.legacyRoot)) {
    rmSync(options.legacyRoot, { recursive: true, force: true });
  }
  await tar.extract({ archivePath: newest, destinationRoot: options.legacyRoot });

  return {
    action: 'rollback',
    migrated: [],
    skipped: [],
    backupPath: newest,
    legacyRoot: options.legacyRoot,
    canonicalRoot: options.canonicalRoot,
    durationMs: Date.now() - start,
  };
}
