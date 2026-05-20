/**
 * Doctor — `cleo skills doctor bridge` business logic.
 *
 * @remarks
 * Implements the canonical discovery topology described in
 * `docs/architecture/SG-CLEO-SKILLS-architecture-v3.md` §1:
 *
 * - `~/.cleo/skills/<name>/` is the per-user install root (Sphere A + B).
 * - `~/.claude/skills/agents-shared/<name>` is a symlink INTO `~/.cleo/skills/`
 *   for each installed skill — Claude Code's hardcoded discovery mount.
 * - `~/.agents/skills` is the SINGLE bridge symlink → `~/.claude/skills/agents-shared`
 *   used by every non-Claude harness (Cursor, Aider, Codeium, etc.).
 *
 * The bridge command takes a host machine from any pre-v3 state and:
 *
 * 1. Ensures `~/.claude/skills/agents-shared/` exists (mkdir -p).
 * 2. Creates a symlink under `agents-shared/` for every skill currently in
 *    `~/.cleo/skills/` whose target is missing or wrong.
 * 3. Atomically replaces `~/.agents/skills` with a symlink to
 *    `~/.claude/skills/agents-shared`. If the existing `~/.agents/skills` is a
 *    REAL directory with contents, the function refuses without `--force` and
 *    backs up to `~/.cleo/backups/agents-skills-pre-bridge-YYYYMMDD-HHmmss/`
 *    when `--force` is supplied.
 * 4. Rips per-skill symlinks under `~/.claude/skills/*` that point OUTSIDE
 *    `agents-shared/` (orphans from the old per-skill fan-out model).
 *
 * The function is pure-functional with a dependency-injected `homeDir` so it
 * can be exercised against tmpfs fixtures in unit tests without touching the
 * real user environment.
 *
 * ## Locality (T9740 Wave B — T9744)
 *
 * Moved from `packages/caamp/src/commands/skills/doctor-bridge.ts` to CORE so
 * the cleo CLI (and any other CORE consumer) can import it without crossing
 * the `core → caamp` dep boundary. The legacy Commander registrar in caamp
 * was deleted at the same time — cleo dispatches via citty and never wired
 * the registrar in.
 *
 * @see {@link docs/architecture/SG-CLEO-SKILLS-architecture-v3.md} §1
 * @task T9744
 * @epic T9740
 */

import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { cp, mkdir, readdir, rm, symlink, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

/**
 * One symlink that was created (or would be created in `--dry-run`).
 *
 * @public
 */
export interface BridgeSymlinkRecord {
  /** Skill basename, e.g. `ct-orchestrator`. */
  name: string;
  /** Absolute path of the symlink under `~/.claude/skills/agents-shared/`. */
  linkPath: string;
  /** Absolute path of the symlink target inside `~/.cleo/skills/`. */
  target: string;
}

/**
 * One per-skill symlink that was removed (or would be removed in `--dry-run`).
 *
 * @public
 */
export interface PerSkillSymlinkRemoval {
  /** Absolute path of the symlink that was removed. */
  linkPath: string;
  /** Resolved target the symlink pointed at, or `null` when unreadable. */
  previousTarget: string | null;
}

/**
 * LAFS-shaped result payload emitted by {@link runDoctorBridge}.
 *
 * @public
 */
export interface DoctorBridgeResult {
  /** Whether this run materially changed disk state. `false` on idempotent re-runs. */
  bridgeCreated: boolean;
  /**
   * Whether `~/.agents/skills` is now a symlink to `~/.claude/skills/agents-shared`.
   *
   * @remarks
   * Always `true` after a successful run. `false` only when `--dry-run` was
   * requested and the bridge had to be created.
   */
  bridgeSymlinkActive: boolean;
  /** Symlinks created under `~/.claude/skills/agents-shared/` (or planned in dry-run). */
  perSkillSymlinksCreated: BridgeSymlinkRecord[];
  /** Per-skill symlinks under `~/.claude/skills/*` that were removed (or planned). */
  perSkillSymlinksRemoved: PerSkillSymlinkRemoval[];
  /**
   * Absolute backup path when the existing `~/.agents/skills` real dir was
   * relocated to make room for the bridge symlink. `null` when no backup was
   * needed.
   */
  backupPath: string | null;
  /** `true` when `--dry-run` was passed and no disk state was mutated. */
  dryRun: boolean;
  /** Resolved skills root, e.g. `~/.cleo/skills`. */
  skillsRoot: string;
  /** Resolved bridge target, e.g. `~/.claude/skills/agents-shared`. */
  bridgeTarget: string;
  /** Resolved bridge symlink path, e.g. `~/.agents/skills`. */
  bridgePath: string;
}

/**
 * Dependency-injected options accepted by {@link runDoctorBridge}.
 *
 * @public
 */
export interface DoctorBridgeOptions {
  /**
   * Override the home directory. Defaults to {@link homedir}.
   *
   * @remarks
   * Tests pass a tmpfs root so the bridge logic can be exercised end-to-end
   * without touching the real user environment.
   */
  homeDir?: string;
  /**
   * Allow the function to clobber an existing real `~/.agents/skills` directory.
   *
   * @remarks
   * When `false` (the default) and `~/.agents/skills` is a non-empty real
   * directory, the function refuses with `E_AGENTS_SKILLS_REAL_DIR` to preserve
   * user data. When `true`, the directory is moved to
   * `~/.cleo/backups/agents-skills-pre-bridge-<ts>/` before the bridge symlink
   * is created.
   *
   * @defaultValue `false`
   */
  force?: boolean;
  /**
   * Plan-only mode. When `true`, no disk state is mutated; the result still
   * lists what WOULD happen.
   *
   * @defaultValue `false`
   */
  dryRun?: boolean;
}

/**
 * Error thrown when {@link runDoctorBridge} refuses to clobber a real
 * `~/.agents/skills` directory and `--force` was not passed.
 *
 * @public
 */
export class AgentsSkillsRealDirError extends Error {
  /** LAFS error code surfaced by the CLI. */
  public readonly code = 'E_AGENTS_SKILLS_REAL_DIR' as const;
  /** Resolved path of the offending real directory. */
  public readonly agentsSkillsPath: string;
  /** Number of immediate entries in the offending directory. */
  public readonly entryCount: number;

  /**
   * Construct an `AgentsSkillsRealDirError`.
   *
   * @param agentsSkillsPath - Path to the real `~/.agents/skills` directory.
   * @param entryCount - Number of entries inside the directory.
   */
  constructor(agentsSkillsPath: string, entryCount: number) {
    super(
      `Refusing to replace real directory at ${agentsSkillsPath} (${entryCount} entries). Pass --force to back up and bridge.`,
    );
    this.name = 'AgentsSkillsRealDirError';
    this.agentsSkillsPath = agentsSkillsPath;
    this.entryCount = entryCount;
  }
}

/**
 * Generate a deterministic backup-suffix timestamp `YYYYMMDD-HHmmss` (UTC).
 *
 * @remarks
 * Pulled out as a helper so callers (and tests) can deterministically compute
 * the expected backup path without re-implementing the format. The string is
 * UTC so backups taken on different machines round-trip identically.
 *
 * @returns Timestamp suffix string for backup directory naming.
 *
 * @public
 */
export function buildBackupTimestamp(): string {
  const d = new Date();
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return (
    `${d.getUTCFullYear()}` +
    `${pad(d.getUTCMonth() + 1)}` +
    `${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}` +
    `${pad(d.getUTCMinutes())}` +
    `${pad(d.getUTCSeconds())}`
  );
}

/**
 * Resolve the canonical bridge-related paths against a home directory.
 *
 * @param homeRoot - Absolute home directory (usually {@link homedir}).
 * @returns The four absolute paths involved in the bridge topology.
 */
function resolveBridgePaths(homeRoot: string): {
  skillsRoot: string;
  bridgeTarget: string;
  bridgePath: string;
  backupsRoot: string;
  claudeSkillsRoot: string;
} {
  return {
    skillsRoot: path.join(homeRoot, '.cleo', 'skills'),
    bridgeTarget: path.join(homeRoot, '.claude', 'skills', 'agents-shared'),
    bridgePath: path.join(homeRoot, '.agents', 'skills'),
    backupsRoot: path.join(homeRoot, '.cleo', 'backups'),
    claudeSkillsRoot: path.join(homeRoot, '.claude', 'skills'),
  };
}

/**
 * Read the immediate subdirectory entries of `~/.cleo/skills/` (skills root).
 *
 * @param skillsRoot - Absolute path to `~/.cleo/skills/`.
 * @returns Array of skill basenames sorted lexicographically; empty when the
 *   root does not exist.
 */
function listSkillDirs(skillsRoot: string): string[] {
  if (!existsSync(skillsRoot)) return [];
  const entries = readdirSync(skillsRoot, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)
    .filter((n) => !n.startsWith('.'))
    .sort();
}

/**
 * Determine whether `linkPath` is a symlink that already points at `target`.
 *
 * @remarks
 * Used to make {@link runDoctorBridge} idempotent — re-running on an
 * already-bridged tree must NOT recreate identical symlinks.
 *
 * @param linkPath - Filesystem path to inspect.
 * @param target - Absolute target the symlink would point at.
 * @returns `true` when `linkPath` is a symlink resolving to `target`.
 */
function symlinkPointsAt(linkPath: string, target: string): boolean {
  try {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink()) return false;
    const current = readlinkSync(linkPath);
    const resolved = path.isAbsolute(current)
      ? current
      : path.resolve(path.dirname(linkPath), current);
    return path.resolve(resolved) === path.resolve(target);
  } catch {
    return false;
  }
}

/**
 * Create (or re-create) a symlink so it points at `target`.
 *
 * @param linkPath - Path of the symlink to create.
 * @param target - Absolute path the symlink should point at.
 * @param dryRun - When `true`, no disk mutation occurs.
 */
async function ensureSymlink(linkPath: string, target: string, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  await mkdir(path.dirname(linkPath), { recursive: true });
  if (existsSync(linkPath)) {
    try {
      await unlink(linkPath);
    } catch {
      // Fall through — symlink() will surface a clearer error if removal failed.
    }
  }
  await symlink(target, linkPath, 'dir');
}

/**
 * Count immediate entries in a directory, returning `0` for a missing path.
 *
 * @param dir - Directory to inspect.
 * @returns Entry count, or `0` when the path does not exist.
 */
async function countEntries(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir);
    return entries.length;
  } catch {
    return 0;
  }
}

/**
 * Execute the bridge flow described in the module docblock.
 *
 * @remarks
 * Order of operations:
 *
 * 1. Ensure `~/.claude/skills/agents-shared/` exists.
 * 2. For each skill in `~/.cleo/skills/`, ensure
 *    `~/.claude/skills/agents-shared/<name>` → `~/.cleo/skills/<name>` exists.
 * 3. Rip every per-skill entry under `~/.claude/skills/` that is a symlink
 *    pointing OUTSIDE `agents-shared/` — those are orphans from the old
 *    per-skill fan-out model and must be deleted.
 * 4. Replace `~/.agents/skills` with a symlink to `~/.claude/skills/agents-shared`.
 *    If it is currently a real directory, refuse unless `options.force` is
 *    `true`, in which case back up to
 *    `~/.cleo/backups/agents-skills-pre-bridge-<ts>/` first.
 *
 * Idempotency invariant: re-running on a fully-bridged tree returns
 * `{ bridgeCreated: false, bridgeSymlinkActive: true, perSkillSymlinksCreated: [], perSkillSymlinksRemoved: [], backupPath: null }`.
 *
 * @param options - Dependency-injected options (homeDir / force / dry-run).
 * @returns Materialized {@link DoctorBridgeResult} reflecting the run.
 * @throws AgentsSkillsRealDirError when `~/.agents/skills` is a non-empty real
 *   directory and `options.force` is not set.
 *
 * @example
 * ```typescript
 * import { runDoctorBridge } from '@cleocode/core';
 *
 * const result = await runDoctorBridge({ homeDir: '/tmp/test-home' });
 * console.log(result.perSkillSymlinksCreated.length); // # of new bridge symlinks
 * ```
 *
 * @public
 */
export async function runDoctorBridge(
  options: DoctorBridgeOptions = {},
): Promise<DoctorBridgeResult> {
  const homeRoot = options.homeDir ?? homedir();
  const force = options.force ?? false;
  const dryRun = options.dryRun ?? false;
  const { skillsRoot, bridgeTarget, bridgePath, backupsRoot, claudeSkillsRoot } =
    resolveBridgePaths(homeRoot);

  // 1. Ensure bridge target dir exists.
  if (!dryRun) {
    await mkdir(bridgeTarget, { recursive: true });
  }

  // 2. Populate agents-shared/ with per-skill symlinks into ~/.cleo/skills/.
  const skillNames = listSkillDirs(skillsRoot);
  const created: BridgeSymlinkRecord[] = [];
  for (const name of skillNames) {
    const linkPath = path.join(bridgeTarget, name);
    const target = path.join(skillsRoot, name);
    if (symlinkPointsAt(linkPath, target)) continue;
    await ensureSymlink(linkPath, target, dryRun);
    created.push({ name, linkPath, target });
  }

  // 3. Rip per-skill symlinks under ~/.claude/skills/<name> that point outside agents-shared/.
  const removed: PerSkillSymlinkRemoval[] = [];
  if (existsSync(claudeSkillsRoot)) {
    const entries = readdirSync(claudeSkillsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'agents-shared') continue;
      const entryPath = path.join(claudeSkillsRoot, entry.name);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(entryPath);
      } catch {
        continue;
      }
      if (!stat.isSymbolicLink()) continue;
      let resolvedTarget: string | null = null;
      try {
        const raw = readlinkSync(entryPath);
        resolvedTarget = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(entryPath), raw);
      } catch {
        resolvedTarget = null;
      }
      // Keep symlinks that already point inside agents-shared/.
      if (resolvedTarget !== null) {
        const realResolved = ((): string => {
          try {
            return realpathSync(resolvedTarget);
          } catch {
            return resolvedTarget;
          }
        })();
        if (
          realResolved === bridgeTarget ||
          realResolved.startsWith(`${bridgeTarget}${path.sep}`)
        ) {
          continue;
        }
      }
      if (!dryRun) {
        await unlink(entryPath);
      }
      removed.push({ linkPath: entryPath, previousTarget: resolvedTarget });
    }
  }

  // 4. Establish the single bridge symlink at ~/.agents/skills.
  let backupPath: string | null = null;
  const bridgeAlreadyCorrect = symlinkPointsAt(bridgePath, bridgeTarget);
  let bridgeSymlinkActive = bridgeAlreadyCorrect;

  if (!bridgeAlreadyCorrect) {
    if (existsSync(bridgePath)) {
      const lstat = lstatSync(bridgePath);
      if (lstat.isSymbolicLink()) {
        // Wrong-target symlink — safe to replace.
        if (!dryRun) await unlink(bridgePath);
      } else if (lstat.isDirectory()) {
        const entryCount = await countEntries(bridgePath);
        if (entryCount > 0 && !force) {
          throw new AgentsSkillsRealDirError(bridgePath, entryCount);
        }
        // Backup before replacing (only when force OR empty dir; the empty-dir
        // case also benefits from a copyless rename to keep the audit trail).
        if (entryCount > 0) {
          backupPath = path.join(backupsRoot, `agents-skills-pre-bridge-${buildBackupTimestamp()}`);
          if (!dryRun) {
            await mkdir(backupsRoot, { recursive: true });
            await cp(bridgePath, backupPath, { recursive: true, dereference: false });
            await rm(bridgePath, { recursive: true, force: true });
          }
        } else if (!dryRun) {
          await rm(bridgePath, { recursive: true, force: true });
        }
      } else if (!dryRun) {
        // Regular file at ~/.agents/skills — refuse silently? Better: unlink.
        await unlink(bridgePath);
      }
    }
    if (!dryRun) {
      await mkdir(path.dirname(bridgePath), { recursive: true });
      await symlink(bridgeTarget, bridgePath, 'dir');
      bridgeSymlinkActive = true;
    }
  }

  return {
    bridgeCreated: !bridgeAlreadyCorrect,
    bridgeSymlinkActive,
    perSkillSymlinksCreated: created,
    perSkillSymlinksRemoved: removed,
    backupPath,
    dryRun,
    skillsRoot,
    bridgeTarget,
    bridgePath,
  };
}
