/**
 * Sentient SKILLS CURATOR — automatic lifecycle transitions for agent-created skills.
 *
 * @remarks
 * Pure transition state machine that walks the per-user `skills.db` registry
 * (`source_type='agent-created'` / `'user'`) and moves rows between the three
 * lifecycle states defined by {@link SkillLifecycleState}:
 *
 * ```
 *           ┌──────────────┐    anchor <= stale     ┌──────────────┐
 *           │   active     │ ───────────────────────▶│    stale     │
 *           │              │ ◀───────────────────────│              │
 *           └──────────────┘    anchor > stale       └──────────────┘
 *                  │                                          │
 *                  └──── anchor <= archive ───────────────────┤
 *                                                             ▼
 *                                                     ┌──────────────┐
 *                                                     │   archived   │
 *                                                     │  (on-disk    │
 *                                                     │   moved →    │
 *                                                     │   .archive/) │
 *                                                     └──────────────┘
 * ```
 *
 * The cutoffs are configured via `daemon.curator.staleAfterDays` and
 * `daemon.curator.archiveAfterDays` in `~/.cleo/config.json` (defaults: 30 and
 * 90 days respectively).
 *
 * ## Triple guard (MANDATORY before any archive)
 *
 * Before writing to disk OR mutating any row, every candidate is screened by
 * THREE conditions, ALL of which must pass:
 *
 * 1. {@link is_canonical}(`installPath`, `{dbSourceType, manifestNames}`) === `false`
 * 2. `row.pinned === false`
 * 3. `row.sourceType !== 'canonical'`
 *
 * If any guard fails, the row is skipped entirely (no transition, no write).
 *
 * ## Archive-only — NEVER delete
 *
 * Archiving moves the on-disk skill directory from `<skillsRoot>/<name>/` to
 * `<skillsRoot>/.archive/<name>-<unix-ts>/` using `fs.cpSync` followed by
 * `fs.rmSync` of the original. The destination is timestamped so multiple
 * archives of the same name do not collide. The owning row's
 * `lifecycle_state` is then flipped to `'archived'` and `archived_at` +
 * `archived_from_path` are populated so `cleo skill restore` is reproducible.
 *
 * Deletion is NEVER an option — archives are recoverable, deletes are not.
 *
 * ## Opt-in
 *
 * The curator is OFF by default. The daemon integration in `daemon.ts` reads
 * `daemon.curator.enabled` and only schedules ticks when set to `true`.
 * Honors `cleo sentient kill` like every other sentient subsystem.
 *
 * @see {@link /mnt/projects/hermes-agent/agent/curator.py} lines 256-296 — original Hermes transitions
 * @see {@link docs/architecture/SG-CLEO-SKILLS-architecture-v3.md} §6 — is_canonical resolution
 * @task T9562, T9677
 * @epic T9562
 * @saga T9560
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { is_canonical, resolveSkillsRoot } from '../skills/skill-root.js';
import type {
  SkillLifecycleState,
  SkillRow,
  SkillSourceType,
} from '../store/schema/skills-schema.js';
import {
  closeSkillsDb,
  listSkillsBySource,
  openSkillsDb,
  upsertSkillRow,
} from '../store/skills-db.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default — agent-created skills go stale after 30 days of no activity. */
export const DEFAULT_STALE_AFTER_DAYS = 30;

/** Default — agent-created skills are archived after 90 days of no activity. */
export const DEFAULT_ARCHIVE_AFTER_DAYS = 90;

/** Default — curator review interval (7 days). */
export const DEFAULT_RUN_EVERY_HOURS = 24 * 7;

/**
 * Source types the curator is allowed to inspect.
 *
 * @remarks
 * `'canonical'` is explicitly EXCLUDED — Sphere A canonical skills are
 * read-only on user machines per architecture v3 §6.
 */
export const CURATABLE_SOURCE_TYPES: readonly SkillSourceType[] = ['agent-created', 'user'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Reason a transition was skipped (non-mutating outcome).
 *
 * @public
 */
export type SkipReason = 'pinned' | 'canonical' | 'no-transition-needed' | 'install-path-missing';

/**
 * Kind of a curator decision — drives the visit log produced by
 * {@link runCuratorTick}.
 *
 * @public
 */
export type TransitionKind = 'mark-stale' | 'reactivate' | 'archive' | 'skip';

/**
 * A single decision produced by {@link runCuratorTick} for one skill row.
 *
 * @public
 */
export interface Transition {
  /** Skill identifier (matches `skills.name`). */
  readonly name: string;
  /** Lifecycle state of the row before the transition was applied. */
  readonly fromState: SkillLifecycleState;
  /** Lifecycle state the row will be in after a successful apply. */
  readonly toState: SkillLifecycleState;
  /** Decision kind. */
  readonly kind: TransitionKind;
  /** Populated only when `kind === 'skip'` — explains why. */
  readonly skipReason?: SkipReason;
  /**
   * Resolved on-disk path of the skill, captured BEFORE archive moves the
   * directory. Mirrors `skills.install_path`.
   */
  readonly installPath: string;
  /**
   * Activity anchor used to make the decision (the latest of
   * `last_updated_at` and `installed_at`, falling back to "now"). ISO-8601 UTC.
   */
  readonly anchorAt: string;
}

/**
 * Options accepted by {@link runCuratorTick}.
 *
 * @public
 */
export interface RunCuratorTickOptions {
  /**
   * When `true`, transitions are computed but NOT applied — no disk moves and
   * no db writes. The returned visit log still describes what WOULD happen.
   *
   * @defaultValue `false`
   */
  dryRun?: boolean;
  /**
   * Override "now". Tests use this so cutoffs are deterministic.
   *
   * @defaultValue new Date()
   */
  now?: Date;
  /**
   * Override the days threshold for the `active → stale` transition.
   *
   * @defaultValue {@link DEFAULT_STALE_AFTER_DAYS}
   */
  staleAfterDays?: number;
  /**
   * Override the days threshold for the `* → archived` transition.
   *
   * @defaultValue {@link DEFAULT_ARCHIVE_AFTER_DAYS}
   */
  archiveAfterDays?: number;
  /**
   * Override the canonical-name manifest used by the triple guard. Production
   * callers should pass the contents of `packages/skills/skills/manifest.json`
   * so the manifest-membership branch of `is_canonical` is meaningful.
   *
   * @defaultValue `undefined`
   */
  manifestNames?: readonly string[];
  /**
   * Override the skills root directory used to compute the archive
   * destination. Defaults to {@link resolveSkillsRoot}. Tests pass a tmpfs path
   * so disk moves stay sandboxed.
   *
   * @defaultValue {@link resolveSkillsRoot}()
   */
  skillsRoot?: string;
}

/**
 * Summary of a curator tick (for telemetry / status output).
 *
 * @public
 */
export interface CuratorTickSummary {
  /** Total number of rows inspected. */
  readonly checked: number;
  /** Number of `active → stale` flips. */
  readonly markedStale: number;
  /** Number of `stale → active` reactivations. */
  readonly reactivated: number;
  /** Number of `* → archived` moves applied to disk. */
  readonly archived: number;
  /** Number of rows skipped by the triple guard or "no transition needed". */
  readonly skipped: number;
  /** Whether this run was a dry-run (no disk writes). */
  readonly dryRun: boolean;
  /** ISO-8601 timestamp captured at the start of the tick (UTC). */
  readonly startedAt: string;
  /** ISO-8601 timestamp captured at the end of the tick (UTC). */
  readonly completedAt: string;
}

/**
 * Combined return type of {@link runCuratorTick} — visit log + summary.
 *
 * @public
 */
export interface CuratorTickResult {
  /** One {@link Transition} per row inspected, in `name`-sorted order. */
  readonly transitions: readonly Transition[];
  /** Aggregated counters describing what changed. */
  readonly summary: CuratorTickSummary;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Pick the most recent activity anchor from a row.
 *
 * @remarks
 * Mirrors the Hermes `_parse_iso(row.get("last_activity_at")) or
 * _parse_iso(row.get("created_at"))` rule, but uses our `last_updated_at` +
 * `installed_at` columns. Falls back to `now` when both timestamps are
 * absent so a freshly-installed skill is never immediately archived.
 *
 * @param row - The skills.db row under inspection.
 * @param now - Fallback when both timestamps are absent / unparseable.
 * @returns The selected anchor as a Date object (always UTC).
 */
function resolveAnchor(row: SkillRow, now: Date): Date {
  const candidates = [row.lastUpdatedAt, row.installedAt];
  for (const cand of candidates) {
    if (!cand) continue;
    const parsed = new Date(cand);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return now;
}

/**
 * Test whether a row passes the triple guard required before any mutation.
 *
 * @remarks
 * - `is_canonical(row.installPath, {dbSourceType, manifestNames}) === false`
 * - `row.pinned === false`
 * - `row.sourceType !== 'canonical'`
 *
 * Each `false` short-circuits the others — the caller learns which guard
 * fired via the returned reason so it can surface a clean skip log entry.
 *
 * @param row - The candidate row.
 * @param manifestNames - Optional canonical-name list passed to `is_canonical`.
 * @returns `'ok'` when the row may be mutated, or a {@link SkipReason}.
 */
function tripleGuard(row: SkillRow, manifestNames?: readonly string[]): SkipReason | 'ok' {
  if (row.pinned) return 'pinned';
  if (row.sourceType === 'canonical') return 'canonical';
  const canonicalByPath = is_canonical(row.installPath, {
    dbSourceType: row.sourceType,
    manifestNames: manifestNames ? [...manifestNames] : undefined,
  });
  if (canonicalByPath) return 'canonical';
  return 'ok';
}

/**
 * Compute the lifecycle transition for a single row WITHOUT mutating anything.
 *
 * @param row - The row under inspection (must have passed the triple guard).
 * @param now - "now" used to compare against the cutoff anchors.
 * @param staleCutoff - Activity anchors at or before this Date are stale.
 * @param archiveCutoff - Activity anchors at or before this Date are archive-able.
 * @returns The decided transition (may have `kind: 'skip'` when no flip applies).
 */
function decideTransition(
  row: SkillRow,
  now: Date,
  staleCutoff: Date,
  archiveCutoff: Date,
): Pick<Transition, 'fromState' | 'toState' | 'kind' | 'anchorAt' | 'skipReason'> {
  const anchor = resolveAnchor(row, now);
  const anchorAt = anchor.toISOString();
  const fromState = row.lifecycleState;

  // Archive takes priority over stale — once we've crossed the archive cutoff
  // we always move the row to archived regardless of intermediate state.
  if (anchor.getTime() <= archiveCutoff.getTime() && fromState !== 'archived') {
    return { fromState, toState: 'archived', kind: 'archive', anchorAt };
  }
  if (anchor.getTime() <= staleCutoff.getTime() && fromState === 'active') {
    return { fromState, toState: 'stale', kind: 'mark-stale', anchorAt };
  }
  if (anchor.getTime() > staleCutoff.getTime() && fromState === 'stale') {
    return { fromState, toState: 'active', kind: 'reactivate', anchorAt };
  }
  return {
    fromState,
    toState: fromState,
    kind: 'skip',
    skipReason: 'no-transition-needed',
    anchorAt,
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link applyTransition}.
 *
 * @public
 */
export interface ApplyTransitionOptions {
  /**
   * Override the skills root directory used as the archive destination prefix.
   *
   * @defaultValue {@link resolveSkillsRoot}()
   */
  skillsRoot?: string;
  /**
   * Override "now" used to stamp `archived_at` and the archive folder suffix.
   *
   * @defaultValue new Date()
   */
  now?: Date;
}

/**
 * Result of {@link applyTransition} — captures the new on-disk path and the
 * mutated row.
 *
 * @public
 */
export interface ApplyTransitionResult {
  /** The transition that was applied. */
  readonly transition: Transition;
  /** Resolved row after the upsert. */
  readonly row: SkillRow;
  /** Destination path when `kind === 'archive'`; otherwise `null`. */
  readonly archiveDestination: string | null;
}

/**
 * Apply a single {@link Transition} produced by {@link runCuratorTick}.
 *
 * @remarks
 * For `mark-stale` and `reactivate` this is a plain db row flip. For
 * `archive` the on-disk skill directory is moved into
 * `<skillsRoot>/.archive/<name>-<unix-ms>/` (cp then rm — never `rename`,
 * because the archive lives under the same root) and the row is updated with
 * `lifecycle_state='archived'`, `archived_at`, and `archived_from_path`.
 *
 * The `skip` kind is a no-op — supplied so callers can iterate the full
 * visit log without branching on kind.
 *
 * Callers MUST have already verified the triple guard for this row. This
 * function does NOT re-check the guard so dry-run / live runs share the
 * decide-once-apply-many contract.
 *
 * @param transition - The decision to apply.
 * @param options - Optional overrides for archive destination + timestamp.
 * @returns The mutated row plus the archive destination (if any).
 *
 * @throws {Error} If the install_path does not resolve to a directory we can
 *   read — the curator never attempts to write to disk without the source
 *   being present.
 *
 * @public
 */
export async function applyTransition(
  transition: Transition,
  options: ApplyTransitionOptions = {},
): Promise<ApplyTransitionResult> {
  const now = options.now ?? new Date();
  const skillsRoot = options.skillsRoot ?? resolveSkillsRoot();

  if (transition.kind === 'skip') {
    const existing = await loadRow(transition.name);
    return { transition, row: existing, archiveDestination: null };
  }

  if (transition.kind === 'mark-stale' || transition.kind === 'reactivate') {
    const existing = await loadRow(transition.name);
    const row = await upsertSkillRow({
      ...existing,
      lifecycleState: transition.toState,
      lastUpdatedAt: now.toISOString(),
    });
    return { transition, row, archiveDestination: null };
  }

  // transition.kind === 'archive'
  const archiveRoot = join(skillsRoot, '.archive');
  if (!existsSync(archiveRoot)) {
    mkdirSync(archiveRoot, { recursive: true });
  }

  const suffix = now.getTime().toString();
  const archiveDestination = join(archiveRoot, `${transition.name}-${suffix}`);

  if (!existsSync(transition.installPath)) {
    // The source already vanished from disk — still record the archive in db
    // so the row is consistent with the on-disk reality. This protects
    // against half-archived states where a prior tick crashed mid-move.
    const existing = await loadRow(transition.name);
    const row = await upsertSkillRow({
      ...existing,
      lifecycleState: 'archived',
      archivedAt: now.toISOString(),
      archivedFromPath: transition.installPath,
      lastUpdatedAt: now.toISOString(),
    });
    return { transition, row, archiveDestination: null };
  }

  cpSync(transition.installPath, archiveDestination, { recursive: true });
  rmSync(transition.installPath, { recursive: true, force: true });

  const existing = await loadRow(transition.name);
  const row = await upsertSkillRow({
    ...existing,
    lifecycleState: 'archived',
    archivedAt: now.toISOString(),
    archivedFromPath: transition.installPath,
    lastUpdatedAt: now.toISOString(),
  });
  return { transition, row, archiveDestination };
}

/**
 * Load a row by name, throwing when it has vanished mid-tick.
 *
 * @param name - The skill identifier.
 * @returns The row.
 * @throws {Error} If no row exists.
 */
async function loadRow(name: string): Promise<SkillRow> {
  const { getSkillRow } = await import('../store/skills-db.js');
  const row = await getSkillRow(name);
  if (!row) {
    throw new Error(`curator: row for skill '${name}' vanished mid-tick`);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

/**
 * Run one curator pass.
 *
 * @remarks
 * Visits every row in `skills` whose `source_type` is one of
 * {@link CURATABLE_SOURCE_TYPES}, applies the {@link tripleGuard}, decides a
 * {@link Transition}, and (unless `dryRun` is set) applies it via
 * {@link applyTransition}.
 *
 * The return shape lets callers (CLI / daemon) decouple "what would change"
 * from "what changed" — a dry-run returns the same visit log a live run
 * does, minus the side-effects.
 *
 * @param opts - Options controlling cutoffs, "now", and dry-run behaviour.
 * @returns A {@link CuratorTickResult} containing the visit log + summary.
 *
 * @example
 * ```typescript
 * // Live run with defaults
 * const result = await runCuratorTick();
 * console.log(`archived ${result.summary.archived} skill(s)`);
 *
 * // Dry-run preview from CLI
 * const preview = await runCuratorTick({ dryRun: true });
 * for (const t of preview.transitions) {
 *   console.log(`${t.kind} ${t.name} ${t.fromState} → ${t.toState}`);
 * }
 * ```
 *
 * @public
 */
export async function runCuratorTick(opts: RunCuratorTickOptions = {}): Promise<CuratorTickResult> {
  const startedAt = new Date();
  const now = opts.now ?? startedAt;
  const dryRun = opts.dryRun ?? false;
  const staleAfterDays = opts.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const archiveAfterDays = opts.archiveAfterDays ?? DEFAULT_ARCHIVE_AFTER_DAYS;
  const manifestNames = opts.manifestNames;
  const skillsRoot = opts.skillsRoot ?? resolveSkillsRoot();

  const staleCutoff = new Date(now.getTime() - staleAfterDays * 24 * 60 * 60 * 1000);
  const archiveCutoff = new Date(now.getTime() - archiveAfterDays * 24 * 60 * 60 * 1000);

  // Ensure the db is open (helpers below open it idempotently — this just
  // surfaces any migration error at the top of the tick instead of mid-loop).
  await openSkillsDb();

  const allRows: SkillRow[] = [];
  for (const sourceType of CURATABLE_SOURCE_TYPES) {
    const rows = await listSkillsBySource(sourceType);
    allRows.push(...rows);
  }
  // Stable, name-sorted iteration so dry-run output is deterministic.
  allRows.sort((a, b) => a.name.localeCompare(b.name));

  const transitions: Transition[] = [];
  let markedStale = 0;
  let reactivated = 0;
  let archived = 0;
  let skipped = 0;

  for (const row of allRows) {
    const guard = tripleGuard(row, manifestNames);
    if (guard !== 'ok') {
      transitions.push({
        name: row.name,
        fromState: row.lifecycleState,
        toState: row.lifecycleState,
        kind: 'skip',
        skipReason: guard,
        installPath: row.installPath,
        anchorAt: resolveAnchor(row, now).toISOString(),
      });
      skipped += 1;
      continue;
    }

    const decision = decideTransition(row, now, staleCutoff, archiveCutoff);
    const transition: Transition = {
      name: row.name,
      installPath: row.installPath,
      ...decision,
    };
    transitions.push(transition);

    if (decision.kind === 'skip') {
      skipped += 1;
      continue;
    }

    if (!dryRun) {
      await applyTransition(transition, { skillsRoot, now });
    }

    if (decision.kind === 'mark-stale') markedStale += 1;
    else if (decision.kind === 'reactivate') reactivated += 1;
    else if (decision.kind === 'archive') archived += 1;
  }

  const completedAt = new Date();

  return {
    transitions,
    summary: {
      checked: allRows.length,
      markedStale,
      reactivated,
      archived,
      skipped,
      dryRun,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Result of {@link restoreSkillFromArchive}.
 *
 * @public
 */
export interface RestoreSkillResult {
  /** Skill name that was restored. */
  readonly name: string;
  /** Absolute path the skill now lives at. */
  readonly restoredTo: string;
  /** Absolute path the archive was read from. */
  readonly restoredFrom: string;
  /** ISO-8601 timestamp of the restore (UTC). */
  readonly restoredAt: string;
}

/**
 * Restore a previously-archived skill back to the live skills root.
 *
 * @remarks
 * Mirror of the archive logic: copy the most recent
 * `<skillsRoot>/.archive/<name>-<ts>/` directory to
 * `<skillsRoot>/<name>/`, then update the row so `lifecycle_state='active'`
 * and `archived_at` / `archived_from_path` are cleared.
 *
 * Selection rule when multiple archives exist for the same name: the most
 * recent one (largest `ts` suffix) wins. Older archives are left in place
 * so the operator can roll forward manually if needed.
 *
 * @param name - Skill identifier to restore.
 * @param options - Optional overrides for skills root + "now".
 * @returns The {@link RestoreSkillResult} describing the restored location.
 *
 * @throws {Error} If no archive exists for the given name.
 * @throws {Error} If the live install path already exists (refuse-to-clobber).
 *
 * @public
 */
export async function restoreSkillFromArchive(
  name: string,
  options: ApplyTransitionOptions = {},
): Promise<RestoreSkillResult> {
  const { readdirSync } = await import('node:fs');

  const now = options.now ?? new Date();
  const skillsRoot = options.skillsRoot ?? resolveSkillsRoot();
  const archiveRoot = join(skillsRoot, '.archive');

  if (!existsSync(archiveRoot)) {
    throw new Error(`no archive root at ${archiveRoot} — nothing to restore`);
  }

  const entries = readdirSync(archiveRoot, { withFileTypes: true });
  const matches = entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)
    .filter((n) => n === name || n.startsWith(`${name}-`));

  if (matches.length === 0) {
    throw new Error(`no archive entry for skill '${name}' under ${archiveRoot}`);
  }

  // Pick the most recent (highest ts suffix) when multiple archives exist.
  matches.sort((a, b) => extractArchiveTs(b, name) - extractArchiveTs(a, name));
  const chosen = matches[0];
  if (!chosen) {
    // Defensive — should be impossible after the length check above.
    throw new Error(`internal: archive match list empty after sort for '${name}'`);
  }
  const restoredFrom = join(archiveRoot, chosen);
  const restoredTo = join(skillsRoot, name);

  if (existsSync(restoredTo)) {
    throw new Error(
      `refuse-to-clobber: ${restoredTo} already exists — move it aside before restoring`,
    );
  }

  cpSync(restoredFrom, restoredTo, { recursive: true });
  rmSync(restoredFrom, { recursive: true, force: true });

  // Update the row to reflect the restore. The row may not exist if the user
  // hand-archived directories without going through the curator — in that
  // case we leave the db alone (the disk move is enough).
  try {
    const { getSkillRow } = await import('../store/skills-db.js');
    const existing = await getSkillRow(name);
    if (existing) {
      await upsertSkillRow({
        ...existing,
        lifecycleState: 'active',
        installPath: restoredTo,
        archivedAt: null,
        archivedFromPath: null,
        lastUpdatedAt: now.toISOString(),
      });
    }
  } catch {
    // Best-effort — the disk move is the load-bearing operation.
  }

  return {
    name,
    restoredTo,
    restoredFrom,
    restoredAt: now.toISOString(),
  };
}

/**
 * Parse the trailing `-<unix-ms>` suffix from an archive directory name.
 *
 * @remarks
 * Returns `0` when the suffix is missing or unparseable — the corresponding
 * entry sorts as oldest. Names without a suffix (legacy archives) all tie at
 * `0` which is fine because in practice there is only one such entry.
 *
 * @param entry - The archive directory basename.
 * @param skillName - The skill identifier (used to strip the prefix).
 * @returns The numeric ts portion, or `0` when none.
 */
function extractArchiveTs(entry: string, skillName: string): number {
  if (entry === skillName) return 0;
  const suffix = entry.slice(skillName.length + 1); // strip "<name>-"
  const parsed = Number.parseInt(suffix, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Reset internal module state — exposed exclusively for tests that need to
 * close the skills.db singleton between cases.
 *
 * @internal
 */
export function __resetCuratorForTest(): void {
  closeSkillsDb();
}
