/**
 * `cleo skills doctor diagnose` — read-only health report for the skill store.
 *
 * @remarks
 * Pure read-only inspection of the four skill-related filesystem locations and
 * the per-user `skills.db` registry. Reports drift, orphans, broken symlinks,
 * and bridge status. Performs ZERO writes — never creates, removes, or renames
 * anything on disk.
 *
 * Locations inspected (per `docs/architecture/SG-CLEO-SKILLS-architecture-v3.md` §1):
 *
 * 1. **Canonical SSoT** — `~/.cleo/skills/` (the preferred user-machine root).
 * 2. **Legacy XDG** — `~/.local/share/agents/skills/` (read-only fallback).
 * 3. **Bridge mount** — `~/.agents/skills` (expected to be a symlink to
 *    `~/.claude/skills/agents-shared`; if it is a real directory it must be
 *    migrated and replaced with the symlink).
 * 4. **Claude Code discovery mount** — `~/.claude/skills/agents-shared/`
 *    (per-skill symlinks into `~/.cleo/skills/`).
 * 5. **Claude direct entries** — `~/.claude/skills/<name>/` that are NOT under
 *    `agents-shared/` (these should be reconciled).
 *
 * The diagnose runs in two passes:
 *
 * - **Disk pass** — walks each location, counts entries, classifies each
 *   entry as `dir` / `symlink` / `brokenSymlink`, and resolves symlink
 *   targets via `realpathSync`.
 * - **Db pass** — loads {@link openSkillsDb} and compares the registry rows
 *   against the disk entries under the resolved canonical root to detect drift
 *   (rows whose `installPath` is missing, dirs on disk not present in the db).
 *
 * The output schema is locked by `T9652` acceptance criteria:
 *
 * ```typescript
 * interface DoctorDiagnoseReport {
 *   canonicalRoot: { path: string; exists: boolean; entryCount: number; isPreferredSsot: boolean };
 *   legacyRoot: { path: string; exists: boolean; entryCount: number };
 *   bridgeStatus: { agentsSkillsPath: string; kind: 'missing' | 'symlink' | 'real-dir'; symlinkTarget?: string; bridgeOk: boolean; };
 *   claudeSkillsAgentsShared: { path: string; exists: boolean; entryCount: number };
 *   claudeSkillsDirect: { path: string; exists: boolean; entryCount: number; sample: string[] };
 *   db: { path: string; rowCount: number; missingOnDisk: string[] };
 *   perSkillSymlinks: SkillSymlinkRecord[];
 *   orphans: OrphanRecord[];
 *   driftEntries: DriftRecord[];
 *   brokenSymlinks: BrokenSymlinkRecord[];
 *   healthy: boolean;
 * }
 * ```
 *
 * @task T9652
 * @epic T9571
 * @saga T9560
 * @architecture docs/architecture/SG-CLEO-SKILLS-architecture-v3.md §1, §4
 */

import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SkillRow, SkillSourceType } from '../store/schema/skills-schema.js';
import { skills as skillsTable } from '../store/schema/skills-schema.js';
import { openSkillsDb } from '../store/skills-db.js';
import { resolveSkillsRoot } from './skill-root.js';

// ---------------------------------------------------------------------------
// Report shapes (locked by T9652 AC)
// ---------------------------------------------------------------------------

/** Classification of a single on-disk entry under any inspected root. */
export type EntryKind = 'dir' | 'symlink' | 'broken-symlink';

/**
 * Per-skill symlink record under `~/.claude/skills/agents-shared/`.
 *
 * @public
 */
export interface SkillSymlinkRecord {
  /** The basename of the entry (e.g. `ct-orchestrator`). */
  name: string;
  /** Absolute path to the symlink itself. */
  path: string;
  /** Target after `realpathSync` (or null when the link is broken). */
  target: string | null;
  /** True when the resolved target still exists. */
  resolved: boolean;
  /** True when the resolved target is under the canonical SSoT root. */
  pointsToCanonical: boolean;
}

/**
 * On-disk directory that is NOT registered in `skills.db`.
 *
 * @public
 */
export interface OrphanRecord {
  /** Skill basename (e.g. `my-custom-skill`). */
  name: string;
  /** Absolute path to the orphan directory. */
  path: string;
  /** Which inspected root the orphan was discovered under. */
  rootLabel: 'canonical' | 'legacy' | 'agents' | 'claude-direct';
}

/**
 * A row in `skills.db` whose `installPath` no longer resolves on disk.
 *
 * @public
 */
export interface DriftRecord {
  /** Skill name from the db row. */
  name: string;
  /** `installPath` recorded in the db. */
  recordedPath: string;
  /** Source-type from the db row (preserves provenance for the report). */
  sourceType: SkillSourceType;
  /** Reason the row is considered drifted. */
  reason: 'missing-on-disk' | 'lifecycle-archived-but-present';
}

/**
 * A symlink whose target cannot be `realpathSync`-resolved.
 *
 * @public
 */
export interface BrokenSymlinkRecord {
  /** Absolute path to the broken link. */
  path: string;
  /** Root label the link was discovered under. */
  rootLabel: 'agents' | 'claude-direct' | 'agents-shared' | 'canonical' | 'legacy';
}

/**
 * Bridge status — describes the `~/.agents/skills` entry.
 *
 * @public
 */
export interface BridgeStatus {
  /** Absolute path to `~/.agents/skills`. */
  agentsSkillsPath: string;
  /** Whether the path exists at all, and if so, what kind. */
  kind: 'missing' | 'symlink' | 'real-dir';
  /** Resolved symlink target (only when `kind === 'symlink'`). */
  symlinkTarget?: string;
  /** True when the symlink resolves to `~/.claude/skills/agents-shared`. */
  bridgeOk: boolean;
  /** Count of entries when `kind === 'real-dir'` (else 0). */
  realDirEntryCount: number;
}

/**
 * The full diagnose report.
 *
 * @public
 */
export interface DoctorDiagnoseReport {
  /** Resolved canonical SSoT root (`~/.cleo/skills/`). */
  canonicalRoot: {
    path: string;
    exists: boolean;
    entryCount: number;
    /** True when the path is `~/.cleo/skills/` (i.e. the preferred SSoT). */
    isPreferredSsot: boolean;
  };
  /** Legacy XDG canonical store (`~/.local/share/agents/skills/`). */
  legacyRoot: { path: string; exists: boolean; entryCount: number };
  /** Bridge mount status — see {@link BridgeStatus}. */
  bridgeStatus: BridgeStatus;
  /** Claude Code discovery mount (`~/.claude/skills/agents-shared/`). */
  claudeSkillsAgentsShared: { path: string; exists: boolean; entryCount: number };
  /** Direct entries under `~/.claude/skills/` (NOT under `agents-shared/`). */
  claudeSkillsDirect: { path: string; exists: boolean; entryCount: number; sample: string[] };
  /** `skills.db` summary. */
  db: { path: string; rowCount: number; missingOnDisk: string[] };
  /** Per-skill symlinks under `agents-shared/`. */
  perSkillSymlinks: SkillSymlinkRecord[];
  /** On-disk dirs not present in `skills.db`. */
  orphans: OrphanRecord[];
  /** Db rows whose paths no longer resolve. */
  driftEntries: DriftRecord[];
  /** Symlinks that cannot be `realpathSync`-resolved. */
  brokenSymlinks: BrokenSymlinkRecord[];
  /** True when NO issues were found (used to gate CLI exit code). */
  healthy: boolean;
}

/**
 * Optional dependency-injection hooks for {@link diagnoseSkillStore}.
 *
 * @remarks
 * Tests pass `homeOverride` + `dbPathOverride` to point the diagnose at a
 * `mkdtemp`-prepared fixture. Production callers leave both undefined.
 *
 * @public
 */
export interface DoctorDiagnoseOptions {
  /** Override `homedir()` resolution (test-only). */
  homeOverride?: string;
  /** Override the path used to open `skills.db` (test-only). */
  dbPathOverride?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Wrap `realpathSync` so a broken link returns `null` instead of throwing.
 *
 * @internal
 */
function safeRealpath(input: string): string | null {
  try {
    return realpathSync(input);
  } catch {
    return null;
  }
}

/**
 * Classify a single `readdirSync` entry under one of the inspected roots.
 *
 * @internal
 */
function classifyEntry(absPath: string): EntryKind {
  try {
    const lst = lstatSync(absPath);
    if (lst.isSymbolicLink()) {
      const real = safeRealpath(absPath);
      if (real === null) return 'broken-symlink';
      try {
        // statSync follows the link; if it throws, the target is gone.
        statSync(real);
        return 'symlink';
      } catch {
        return 'broken-symlink';
      }
    }
    if (lst.isDirectory()) return 'dir';
    // Anything else (file, fifo, etc.) shows up as 'dir' for counting purposes
    // because the diagnose only cares about directory-shaped skill mounts. The
    // caller filters via specific helpers below.
    return 'dir';
  } catch {
    return 'broken-symlink';
  }
}

/**
 * List the immediate entries of a directory, returning `[]` on missing dirs.
 *
 * @internal
 */
function listEntries(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * Count only directory-shaped entries (real dirs + valid symlinks).
 *
 * @internal
 */
function countSkillEntries(dir: string): number {
  return listEntries(dir).reduce((acc, name) => {
    const kind = classifyEntry(join(dir, name));
    return kind === 'dir' || kind === 'symlink' ? acc + 1 : acc;
  }, 0);
}

/**
 * Resolve the four inspected paths off a (possibly overridden) home directory.
 *
 * @internal
 */
interface ResolvedPaths {
  home: string;
  canonicalSsot: string;
  legacyXdg: string;
  agentsSkills: string;
  claudeSkills: string;
  claudeAgentsShared: string;
}
function resolvePaths(homeOverride?: string): ResolvedPaths {
  const home = homeOverride ?? homedir();
  return {
    home,
    canonicalSsot: join(home, '.cleo', 'skills'),
    legacyXdg: join(home, '.local', 'share', 'agents', 'skills'),
    agentsSkills: join(home, '.agents', 'skills'),
    claudeSkills: join(home, '.claude', 'skills'),
    claudeAgentsShared: join(home, '.claude', 'skills', 'agents-shared'),
  };
}

// ---------------------------------------------------------------------------
// Public API — diagnoseSkillStore
// ---------------------------------------------------------------------------

/**
 * Run the read-only health diagnose pass on the local user's skill store.
 *
 * @remarks
 * Returns a fully-populated {@link DoctorDiagnoseReport}. Performs ZERO writes
 * to the filesystem and ZERO writes to `skills.db` — opens the db read-only
 * via {@link openSkillsDb}.
 *
 * Healthy criteria (all must hold for `healthy: true`):
 *
 * - Canonical root is the preferred `~/.cleo/skills/` (NOT the legacy fallback).
 * - Bridge symlink is present and resolves to `~/.claude/skills/agents-shared`.
 * - `~/.agents/skills` is a symlink (NOT a real directory).
 * - No broken symlinks anywhere in the inspected paths.
 * - No drift rows (db `installPath`s all resolve).
 * - No orphan directories.
 *
 * @param options - Optional DI overrides for tests; production callers omit.
 * @returns The complete diagnose report.
 *
 * @example
 * ```typescript
 * import { diagnoseSkillStore } from '@cleocode/caamp';
 *
 * const report = await diagnoseSkillStore();
 * if (!report.healthy) {
 *   console.error('Skill store needs attention — run `cleo skills doctor migrate`');
 *   process.exit(1);
 * }
 * ```
 *
 * @public
 */
export async function diagnoseSkillStore(
  options?: DoctorDiagnoseOptions,
): Promise<DoctorDiagnoseReport> {
  const paths = resolvePaths(options?.homeOverride);
  const brokenSymlinks: BrokenSymlinkRecord[] = [];

  // -------------------------------------------------------------------------
  // Canonical SSoT — prefer the override-aware resolver when no homeOverride
  // is in play; otherwise compute directly so tests are deterministic.
  // -------------------------------------------------------------------------
  const canonicalResolved = options?.homeOverride
    ? existsSync(paths.canonicalSsot)
      ? paths.canonicalSsot
      : existsSync(paths.legacyXdg)
        ? paths.legacyXdg
        : paths.canonicalSsot
    : resolveSkillsRoot();

  const canonicalRoot = {
    path: canonicalResolved,
    exists: existsSync(canonicalResolved),
    entryCount: countSkillEntries(canonicalResolved),
    isPreferredSsot: canonicalResolved === paths.canonicalSsot,
  };

  // -------------------------------------------------------------------------
  // Legacy XDG
  // -------------------------------------------------------------------------
  const legacyRoot = {
    path: paths.legacyXdg,
    exists: existsSync(paths.legacyXdg),
    entryCount: countSkillEntries(paths.legacyXdg),
  };

  // -------------------------------------------------------------------------
  // Bridge: ~/.agents/skills MUST be a symlink to ~/.claude/skills/agents-shared
  // -------------------------------------------------------------------------
  const bridgeStatus: BridgeStatus = (() => {
    let kind: BridgeStatus['kind'] = 'missing';
    let symlinkTarget: string | undefined;
    let bridgeOk = false;
    let realDirEntryCount = 0;
    try {
      const lst = lstatSync(paths.agentsSkills);
      if (lst.isSymbolicLink()) {
        kind = 'symlink';
        const target = safeRealpath(paths.agentsSkills);
        if (target === null) {
          brokenSymlinks.push({ path: paths.agentsSkills, rootLabel: 'agents' });
        } else {
          symlinkTarget = target;
          const expected = safeRealpath(paths.claudeAgentsShared) ?? paths.claudeAgentsShared;
          bridgeOk = target === expected;
        }
      } else if (lst.isDirectory()) {
        kind = 'real-dir';
        realDirEntryCount = countSkillEntries(paths.agentsSkills);
      }
    } catch {
      // ENOENT — kind stays 'missing'.
    }
    return {
      agentsSkillsPath: paths.agentsSkills,
      kind,
      symlinkTarget,
      bridgeOk,
      realDirEntryCount,
    };
  })();

  // -------------------------------------------------------------------------
  // Claude Code agents-shared discovery mount
  // -------------------------------------------------------------------------
  const claudeSkillsAgentsShared = {
    path: paths.claudeAgentsShared,
    exists: existsSync(paths.claudeAgentsShared),
    entryCount: countSkillEntries(paths.claudeAgentsShared),
  };

  // -------------------------------------------------------------------------
  // Claude direct entries (NOT under agents-shared)
  // -------------------------------------------------------------------------
  const claudeDirectExists = existsSync(paths.claudeSkills);
  const claudeDirectNames = listEntries(paths.claudeSkills).filter((n) => n !== 'agents-shared');
  const claudeSkillsDirect = {
    path: paths.claudeSkills,
    exists: claudeDirectExists,
    entryCount: claudeDirectNames.reduce((acc, n) => {
      const kind = classifyEntry(join(paths.claudeSkills, n));
      if (kind === 'broken-symlink') {
        brokenSymlinks.push({
          path: join(paths.claudeSkills, n),
          rootLabel: 'claude-direct',
        });
        return acc;
      }
      return kind === 'dir' || kind === 'symlink' ? acc + 1 : acc;
    }, 0),
    sample: claudeDirectNames.slice(0, 10),
  };

  // -------------------------------------------------------------------------
  // Per-skill symlinks under agents-shared (each should target canonical root)
  // -------------------------------------------------------------------------
  // Resolve canonical root through any symlinks so comparisons are stable
  // when the inspected path is itself reached via a symlink chain (e.g. on
  // macOS where `/var` -> `/private/var`).
  const canonicalRealpath = safeRealpath(canonicalResolved) ?? canonicalResolved;
  const perSkillSymlinks: SkillSymlinkRecord[] = listEntries(paths.claudeAgentsShared).map(
    (name) => {
      const abs = join(paths.claudeAgentsShared, name);
      const target = safeRealpath(abs);
      if (target === null) {
        brokenSymlinks.push({ path: abs, rootLabel: 'agents-shared' });
      }
      const pointsToCanonical =
        target !== null &&
        (target === canonicalRealpath || target.startsWith(`${canonicalRealpath}/`));
      return {
        name,
        path: abs,
        target,
        resolved: target !== null,
        pointsToCanonical,
      };
    },
  );

  // -------------------------------------------------------------------------
  // Db pass — open skills.db, compare against canonical root entries
  // -------------------------------------------------------------------------
  const dbPath = options?.dbPathOverride;
  const db = await openSkillsDb(dbPath ? { path: dbPath } : undefined);
  const rows: SkillRow[] = db.select().from(skillsTable).all();

  const dbNames = new Set<string>(rows.map((r) => r.name));
  const driftEntries: DriftRecord[] = [];
  const dbMissingOnDisk: string[] = [];
  for (const row of rows) {
    const onDisk = existsSync(row.installPath);
    if (!onDisk) {
      dbMissingOnDisk.push(row.name);
      driftEntries.push({
        name: row.name,
        recordedPath: row.installPath,
        sourceType: row.sourceType,
        reason: 'missing-on-disk',
      });
    } else if (row.lifecycleState === 'archived') {
      driftEntries.push({
        name: row.name,
        recordedPath: row.installPath,
        sourceType: row.sourceType,
        reason: 'lifecycle-archived-but-present',
      });
    }
  }

  // -------------------------------------------------------------------------
  // Orphans — disk entries under canonical root not present in skills.db
  // -------------------------------------------------------------------------
  const orphans: OrphanRecord[] = [];
  if (canonicalRoot.exists) {
    for (const name of listEntries(canonicalResolved)) {
      const abs = join(canonicalResolved, name);
      const kind = classifyEntry(abs);
      if (kind !== 'dir' && kind !== 'symlink') continue;
      if (!dbNames.has(name)) {
        orphans.push({
          name,
          path: abs,
          rootLabel: canonicalRoot.isPreferredSsot ? 'canonical' : 'legacy',
        });
      }
    }
  }
  // Legacy-only orphans (entries that exist ONLY in the legacy root)
  if (legacyRoot.exists && canonicalResolved !== paths.legacyXdg) {
    for (const name of listEntries(paths.legacyXdg)) {
      const abs = join(paths.legacyXdg, name);
      const kind = classifyEntry(abs);
      if (kind !== 'dir' && kind !== 'symlink') continue;
      if (!dbNames.has(name)) {
        orphans.push({ name, path: abs, rootLabel: 'legacy' });
      }
    }
  }
  // Claude-direct orphans (skill-shaped dirs sitting outside agents-shared)
  if (claudeSkillsDirect.exists) {
    for (const name of claudeDirectNames) {
      const abs = join(paths.claudeSkills, name);
      const kind = classifyEntry(abs);
      if (kind !== 'dir' && kind !== 'symlink') continue;
      if (!dbNames.has(name)) {
        orphans.push({ name, path: abs, rootLabel: 'claude-direct' });
      }
    }
  }
  // Real-dir bridge orphans (each entry needs migration into ~/.cleo/skills/)
  if (bridgeStatus.kind === 'real-dir') {
    for (const name of listEntries(paths.agentsSkills)) {
      const abs = join(paths.agentsSkills, name);
      const kind = classifyEntry(abs);
      if (kind !== 'dir' && kind !== 'symlink') continue;
      if (!dbNames.has(name)) {
        orphans.push({ name, path: abs, rootLabel: 'agents' });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Healthy verdict
  // -------------------------------------------------------------------------
  const healthy =
    canonicalRoot.isPreferredSsot &&
    canonicalRoot.exists &&
    bridgeStatus.bridgeOk &&
    bridgeStatus.kind === 'symlink' &&
    brokenSymlinks.length === 0 &&
    driftEntries.length === 0 &&
    orphans.length === 0;

  return {
    canonicalRoot,
    legacyRoot,
    bridgeStatus,
    claudeSkillsAgentsShared,
    claudeSkillsDirect,
    db: {
      path: dbPath ?? '',
      rowCount: rows.length,
      missingOnDisk: dbMissingOnDisk,
    },
    perSkillSymlinks,
    orphans,
    driftEntries,
    brokenSymlinks,
    healthy,
  };
}

// ---------------------------------------------------------------------------
// Human-readable renderer (used when caller chooses default text output)
// ---------------------------------------------------------------------------

/**
 * Render a {@link DoctorDiagnoseReport} as a plain-text health summary.
 *
 * @remarks
 * Used by the `cleo skills doctor diagnose` CLI surface when neither `--json`
 * nor `--verbose` is requested. Returns a multi-line string; the caller is
 * responsible for writing it to stdout.
 *
 * @param report - The report produced by {@link diagnoseSkillStore}.
 * @param verbose - When true, includes per-skill detail lines.
 * @returns A formatted multi-line string ending in a trailing newline.
 *
 * @public
 */
export function renderDoctorDiagnoseReport(report: DoctorDiagnoseReport, verbose = false): string {
  const lines: string[] = [];
  const ok = (b: boolean): string => (b ? 'OK' : 'WARN');

  lines.push('cleo skills doctor diagnose');
  lines.push('============================');
  lines.push('');
  lines.push(
    `[${ok(report.canonicalRoot.isPreferredSsot && report.canonicalRoot.exists)}] Canonical SSoT  ${report.canonicalRoot.path}`,
  );
  lines.push(
    `       exists=${report.canonicalRoot.exists} entries=${report.canonicalRoot.entryCount} preferred=${report.canonicalRoot.isPreferredSsot}`,
  );
  lines.push(
    `[${ok(!report.legacyRoot.exists || report.legacyRoot.entryCount === 0)}] Legacy XDG       ${report.legacyRoot.path}`,
  );
  lines.push(`       exists=${report.legacyRoot.exists} entries=${report.legacyRoot.entryCount}`);
  lines.push(
    `[${ok(report.bridgeStatus.bridgeOk)}] Bridge link      ${report.bridgeStatus.agentsSkillsPath}`,
  );
  lines.push(
    `       kind=${report.bridgeStatus.kind} target=${report.bridgeStatus.symlinkTarget ?? '<none>'} bridgeOk=${report.bridgeStatus.bridgeOk}`,
  );
  if (report.bridgeStatus.kind === 'real-dir') {
    lines.push(
      `       NOTE: ~/.agents/skills is a real dir with ${report.bridgeStatus.realDirEntryCount} entries — needs migration.`,
    );
  }
  lines.push(
    `[${ok(report.claudeSkillsAgentsShared.exists)}] Claude shared    ${report.claudeSkillsAgentsShared.path}`,
  );
  lines.push(
    `       exists=${report.claudeSkillsAgentsShared.exists} entries=${report.claudeSkillsAgentsShared.entryCount}`,
  );
  lines.push(
    `[${ok(report.claudeSkillsDirect.entryCount === 0)}] Claude direct    ${report.claudeSkillsDirect.path}`,
  );
  lines.push(
    `       entries=${report.claudeSkillsDirect.entryCount} sample=${report.claudeSkillsDirect.sample.slice(0, 5).join(',') || '<none>'}`,
  );
  lines.push('');
  lines.push(`skills.db rows: ${report.db.rowCount}`);
  lines.push(`disk drift:     ${report.driftEntries.length}`);
  lines.push(`orphans:        ${report.orphans.length}`);
  lines.push(`broken links:   ${report.brokenSymlinks.length}`);
  lines.push(`per-skill links under agents-shared: ${report.perSkillSymlinks.length}`);
  lines.push('');

  if (verbose) {
    lines.push('Per-skill symlinks (agents-shared)');
    lines.push('----------------------------------');
    for (const s of report.perSkillSymlinks) {
      lines.push(
        `  ${s.resolved ? '[OK]  ' : '[BAD] '} ${s.name.padEnd(28)} -> ${s.target ?? '<broken>'} canonical=${s.pointsToCanonical}`,
      );
    }
    if (report.driftEntries.length > 0) {
      lines.push('');
      lines.push('Drift rows (skills.db -> disk)');
      lines.push('------------------------------');
      for (const d of report.driftEntries) {
        lines.push(`  [${d.reason}] ${d.name.padEnd(28)} ${d.recordedPath}`);
      }
    }
    if (report.orphans.length > 0) {
      lines.push('');
      lines.push('Orphan directories (on disk, not in skills.db)');
      lines.push('----------------------------------------------');
      for (const o of report.orphans) {
        lines.push(`  [${o.rootLabel}] ${o.name.padEnd(28)} ${o.path}`);
      }
    }
    if (report.brokenSymlinks.length > 0) {
      lines.push('');
      lines.push('Broken symlinks');
      lines.push('---------------');
      for (const b of report.brokenSymlinks) {
        lines.push(`  [${b.rootLabel}] ${b.path}`);
      }
    }
  }

  lines.push('');
  lines.push(`Overall: ${report.healthy ? 'HEALTHY' : 'NEEDS ATTENTION'}`);
  lines.push('');
  return lines.join('\n');
}
