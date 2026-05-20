/**
 * `skills doctor adopt-orphans` — interactive orphan audit + adoption.
 *
 * @remarks
 * An "orphan" is a skill directory that exists under any tracked path
 * (`~/.cleo/skills/`, legacy `~/.local/share/agents/skills/`,
 * `~/.agents/skills/` as a real dir) but has NO row in the per-user
 * `skills.db` registry described in
 * `docs/architecture/SG-CLEO-SKILLS-architecture-v3.md` §4.
 *
 * The handler offers four per-orphan dispositions:
 *
 *   - **canonical-adopt** — REFUSED on a user machine. Canonical writes
 *     must flow via PR to `packages/skills/skills/` (architecture-v3 §6
 *     invariant). The handler emits a refusal explaining the PR flow.
 *   - **user-adopt** — inserts a row into `skills.db` with
 *     `source_type='user'`, `lifecycle_state='active'`, `installedAt=now`.
 *   - **delete** — archives the directory to
 *     `~/.cleo/skills/.archive/<name>-<ts>/` before unlinking from the
 *     original location.
 *   - **skip** — no action; the orphan is logged but otherwise ignored.
 *
 * All decisions are recorded to a structured JSON audit log at
 * `~/.cleo/skills/.audit-log/adopt-<ISO-ts>.json` regardless of mode.
 *
 * ## Chokepoint compliance (ADR-068)
 *
 * This module emits PURE DATA. The skills.db reads and writes are deferred
 * to caller-supplied callbacks (`loadRegisteredNames`, `recordRow`). The
 * `cleo` dispatch layer in `packages/cleo/src/cli/commands/skills.ts` plugs
 * the canonical `openCleoDb('skills')`/`upsertSkillRow` helpers from
 * `@cleocode/core/store/skills-db`. caamp cannot depend on `@cleocode/core`
 * directly (would invert the dep direction: core dynamically imports caamp).
 *
 * Three execution modes:
 *
 *   - default (TTY) — interactive prompt per orphan.
 *   - `--non-interactive` — list orphans and exit without action
 *     (read-only audit).
 *   - `--auto-user-adopt` — bulk user-adopt all orphans without prompting
 *     (safe default for `cleo-init`-style scripts).
 *
 * @task T9657
 * @epic T9571
 * @saga T9560
 * @architecture docs/architecture/SG-CLEO-SKILLS-architecture-v3.md §1, §6
 */

import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import pc from 'picocolors';

import {
  ErrorCategories,
  ErrorCodes,
  emitJsonError,
  handleFormatError,
  outputSuccess,
  resolveFormat,
} from '../../core/lafs.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One orphan disposition decision.
 *
 * @public
 */
export type OrphanDecision = 'canonical-adopt' | 'user-adopt' | 'delete' | 'skip';

/**
 * Reason an action was refused (canonical-adopt on user machine, etc.).
 *
 * @public
 */
export interface OrphanRefusal {
  /** Stable code for programmatic handling. */
  code: 'E_CANONICAL_ADOPT_REFUSED';
  /** Human-readable explanation. */
  message: string;
  /** Suggested next step (e.g. PR flow). */
  remediation: string;
}

/**
 * A single orphan skill directory discovered on disk.
 *
 * @public
 */
export interface OrphanRecord {
  /** Skill name (basename of the orphan directory). */
  name: string;
  /** Absolute path to the orphan directory on disk. */
  path: string;
  /** Which tracked root this orphan was discovered under. */
  discoveredVia: 'cleo' | 'legacy-agents' | 'home-agents';
  /** Whether a `SKILL.md` sentinel exists at the root. */
  hasSkillMd: boolean;
  /** Size of the directory in bytes (best-effort; 0 on stat failure). */
  sizeBytes: number;
}

/**
 * Outcome of acting on a single orphan.
 *
 * @public
 */
export interface OrphanActionResult {
  /** The orphan that was acted upon. */
  orphan: OrphanRecord;
  /** Decision the user (or flag) made. */
  decision: OrphanDecision;
  /** Whether the action completed successfully. */
  applied: boolean;
  /** Refusal payload when `applied=false` due to a policy block. */
  refusal: OrphanRefusal | null;
  /** Where the directory was archived to (delete only). */
  archivedTo: string | null;
  /** ISO-8601 timestamp when the action was taken. */
  decidedAt: string;
}

/**
 * Top-level result returned in the LAFS envelope.
 *
 * @public
 */
export interface DoctorAdoptResult {
  /** Total orphans discovered. */
  totalOrphans: number;
  /** Per-orphan action results. */
  results: OrphanActionResult[];
  /** Audit log file path (always written). */
  auditLogPath: string;
  /** Execution mode used. */
  mode: 'interactive' | 'non-interactive' | 'auto-user-adopt';
}

/**
 * Pure-data payload emitted when a `user-adopt` decision is applied.
 *
 * @remarks
 * The dispatch layer translates this into an `upsertSkillRow` call via the
 * `openCleoDb('skills')` chokepoint. Keeping it as pure data means caamp
 * never has to touch sqlite directly.
 *
 * @public
 */
export interface AdoptedSkillRowData {
  /** Skill name (PK in skills.db). */
  name: string;
  /** Absolute install path on disk. */
  installPath: string;
  /** Wall-clock timestamp the adoption occurred. */
  installedAt: string;
  /** Always `'user'` for the adopt-orphans flow (canonical is refused). */
  sourceType: 'user';
  /** Always `'active'` post-adoption. */
  lifecycleState: 'active';
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Compute the preferred user-machine skills root at `~/.cleo/skills/`.
 *
 * @remarks
 * Mirrors `resolveSkillsRoot()` from `@cleocode/core/skills/skill-root` but
 * stays self-contained inside CAAMP so doctor-adopt does not introduce a
 * static dependency on `@cleocode/core` (which would create a cycle since
 * core dynamically imports caamp).
 *
 * @returns Absolute path to `~/.cleo/skills/`.
 *
 * @internal
 */
function cleoSkillsRoot(): string {
  return join(homedir(), '.cleo', 'skills'); // path-drift-allowed: ~/.cleo symlink is the canonical bootstrap target — mirrors core/src/skills/skill-root.ts newSkillsPath()
}

/**
 * Compute the legacy XDG canonical skills directory.
 *
 * @returns Absolute path to `~/.local/share/agents/skills/`.
 *
 * @internal
 */
function legacyAgentsSkillsRoot(): string {
  return join(homedir(), '.local', 'share', 'agents', 'skills');
}

/**
 * Compute the user-level `~/.agents/skills/` directory.
 *
 * @remarks
 * In architecture-v3 §1, this path SHOULD be a single symlink that points
 * at `~/.claude/skills/agents-shared/`. Some user machines still have it
 * as a real directory with 88+ entries (per architecture-v3 §1 LEGACY
 * note), in which case its contents are also orphan candidates.
 *
 * @returns Absolute path to `~/.agents/skills/`.
 *
 * @internal
 */
function homeAgentsSkillsRoot(): string {
  return join(homedir(), '.agents', 'skills');
}

/**
 * Compute the archive directory for soft-deleted orphans.
 *
 * @returns Absolute path to `~/.cleo/skills/.archive/`.
 *
 * @internal
 */
function archiveRoot(): string {
  return join(cleoSkillsRoot(), '.archive');
}

/**
 * Compute the audit-log directory.
 *
 * @returns Absolute path to `~/.cleo/skills/.audit-log/`.
 *
 * @internal
 */
function auditLogRoot(): string {
  return join(cleoSkillsRoot(), '.audit-log');
}

// ---------------------------------------------------------------------------
// Orphan detection
// ---------------------------------------------------------------------------

/**
 * List candidate skill directory entries under a given root.
 *
 * @remarks
 * "Candidates" are immediate-children entries that are either real
 * directories OR symlinks resolving to a directory. Hidden entries
 * (leading dot) and known sentinel folders (`.archive`, `.audit-log`,
 * `.git`) are skipped so the doctor does not consider its own bookkeeping
 * as orphans.
 *
 * @param root - Absolute path of the tracked skills root to scan.
 * @returns Array of `{name, path}` pairs; empty when `root` is absent or
 *   unreadable.
 *
 * @internal
 */
function listCandidates(root: string): Array<{ name: string; path: string }> {
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: Array<{ name: string; path: string }> = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue; // .archive, .audit-log, .git, .DS_Store
    const full = join(root, name);
    let isDirLike = false;
    try {
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
        isDirLike = true;
      } else if (stat.isSymbolicLink()) {
        try {
          const real = statSync(full);
          isDirLike = real.isDirectory();
        } catch {
          // dangling symlink — not a skill, skip
          isDirLike = false;
        }
      }
    } catch {
      isDirLike = false;
    }
    if (isDirLike) {
      out.push({ name, path: full });
    }
  }
  return out;
}

/**
 * Compute a best-effort byte size for a directory.
 *
 * @remarks
 * Sums file sizes via a non-recursive single-pass `readdirSync`. This is
 * intentionally shallow — orphan adoption only needs a rough sense of
 * footprint, not a precise du(1) figure. Returns `0` on any stat failure
 * so the audit log never blocks on permission errors.
 *
 * @param dir - Absolute path of the directory to size.
 * @returns Approximate byte count, always finite.
 *
 * @internal
 */
function approxDirSize(dir: string): number {
  let total = 0;
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      try {
        const stat = statSync(join(dir, entry));
        if (stat.isFile()) total += stat.size;
      } catch {
        // skip unreadable entries
      }
    }
  } catch {
    return 0;
  }
  return total;
}

/**
 * Discover orphan skills across all tracked roots.
 *
 * @remarks
 * Visits the three tracked roots in priority order and de-duplicates by
 * basename — the first occurrence of `<name>` wins (so a `~/.cleo/skills/`
 * entry shadows the same-named legacy entry). Symlinks under
 * `~/.agents/skills/` that resolve back into `~/.cleo/skills/` are dropped
 * because those are the bridge symlinks, not real orphans.
 *
 * Read-side IO (the set of names already known to `skills.db`) is supplied
 * via the `registeredNames` callback so this module never opens sqlite
 * directly — see ADR-068 chokepoint compliance in the file header.
 *
 * @param registeredNames - Pre-computed set of skill names known to the
 *   registry. Callers in production wire this through `openCleoDb('skills')`;
 *   tests wire it through a sandboxed `DatabaseSync` open.
 * @returns Sorted-by-name list of `OrphanRecord`s.
 *
 * @public
 */
export function discoverOrphans(registeredNames: ReadonlySet<string>): OrphanRecord[] {
  const cleoRoot = cleoSkillsRoot();
  const legacyRoot = legacyAgentsSkillsRoot();
  const homeRoot = homeAgentsSkillsRoot();

  const seen = new Map<string, OrphanRecord>();

  const visit = (
    root: string,
    via: OrphanRecord['discoveredVia'],
    filter?: (path: string) => boolean,
  ): void => {
    for (const candidate of listCandidates(root)) {
      if (seen.has(candidate.name)) continue;
      if (registeredNames.has(candidate.name)) continue;
      if (filter && !filter(candidate.path)) continue;
      seen.set(candidate.name, {
        name: candidate.name,
        path: candidate.path,
        discoveredVia: via,
        hasSkillMd: existsSync(join(candidate.path, 'SKILL.md')),
        sizeBytes: approxDirSize(candidate.path),
      });
    }
  };

  visit(cleoRoot, 'cleo');
  visit(legacyRoot, 'legacy-agents');
  // Skip ~/.agents/skills/ entries whose realpath resolves back into
  // ~/.cleo/skills/ — those are bridge symlinks, not orphans.
  visit(homeRoot, 'home-agents', (path) => {
    try {
      const real = realpathSync(path);
      return !real.startsWith(`${cleoRoot}/`);
    } catch {
      return true;
    }
  });

  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Build the canonical-adopt refusal payload.
 *
 * @returns Static `OrphanRefusal` explaining the PR-flow requirement.
 *
 * @internal
 */
function canonicalAdoptRefusal(): OrphanRefusal {
  return {
    code: 'E_CANONICAL_ADOPT_REFUSED',
    message:
      'Canonical adoption is refused on user machines. Canonical skills are owned by ' +
      'the CLEO core team and ONLY the owner-CI workflow may write them ' +
      '(architecture-v3 §6 invariant).',
    remediation:
      'To contribute this skill to canonical: clone https://github.com/kryptobaseddev/cleo, ' +
      'place the skill under packages/skills/skills/<name>/, and open a PR. ' +
      'Local user-machine canonical writes are blocked by design.',
  };
}

/**
 * Build the per-row payload for a successful user-adopt action.
 *
 * @remarks
 * Pure-data helper — never touches the filesystem or sqlite. Centralised so
 * the shape stays consistent across {@link applyDecision} and any future
 * batch adopter.
 *
 * @param orphan - Orphan record being adopted.
 * @param now - ISO-8601 timestamp to stamp on the row.
 * @returns The {@link AdoptedSkillRowData} payload.
 *
 * @internal
 */
function buildAdoptedRow(orphan: OrphanRecord, now: string): AdoptedSkillRowData {
  return {
    name: orphan.name,
    installPath: orphan.path,
    installedAt: now,
    sourceType: 'user',
    lifecycleState: 'active',
  };
}

/**
 * Archive an orphan directory then unlink it from its original location.
 *
 * @remarks
 * The archive path is `~/.cleo/skills/.archive/<name>-<ts>/` where `<ts>`
 * is an ISO-8601 wall-clock timestamp with `:` replaced by `-` for
 * filesystem-safety. The original directory is removed only AFTER the
 * archive copy completes; on any failure the original is left in place so
 * the operation is recoverable.
 *
 * @param orphan - The orphan to archive + delete.
 * @param now - ISO-8601 timestamp to use in the archive directory name.
 * @returns Absolute path the directory was archived to.
 *
 * @internal
 */
function archiveAndDelete(orphan: OrphanRecord, now: string): string {
  const tsToken = now.replace(/[:.]/g, '-');
  const archiveDir = join(archiveRoot(), `${orphan.name}-${tsToken}`);
  mkdirSync(archiveRoot(), { recursive: true });
  // Recursive copy via node:fs.cpSync (Node 20+) — preserves the directory
  // tree byte-for-byte so the original is reproducible.
  cpSync(orphan.path, archiveDir, { recursive: true, dereference: false });
  rmSync(orphan.path, { recursive: true, force: true });
  return archiveDir;
}

/**
 * Callback signature for persisting a `user-adopt` decision.
 *
 * @remarks
 * Production wiring lives in `packages/cleo/src/cli/commands/skills.ts` and
 * funnels into `upsertSkillRow` from `@cleocode/core/store/skills-db`,
 * which routes through the canonical `openCleoDb('skills')` chokepoint.
 * Test code passes a sandboxed sqlite write. May be synchronous or async.
 *
 * @public
 */
export type RecordRowFn = (data: AdoptedSkillRowData) => void | Promise<void>;

/**
 * Apply a single decision to an orphan, returning a structured outcome.
 *
 * @remarks
 * This is the policy chokepoint — `canonical-adopt` is unconditionally
 * refused, `user-adopt` invokes `recordRow` with the canonical
 * {@link AdoptedSkillRowData} payload, `delete` archives-then-rms, and
 * `skip` records the intent without side effects. Errors during
 * `user-adopt` or `delete` produce an `applied=false` result with a
 * synthesised refusal payload rather than throwing, so the bulk loop can
 * proceed across all orphans.
 *
 * @param orphan - Orphan to act on.
 * @param decision - Decision to apply.
 * @param now - ISO-8601 timestamp to record on the result.
 * @param recordRow - Callback invoked to persist a successful `user-adopt`.
 *   Tests pass a sandbox write; production passes the cleo-dispatch wrapper.
 * @returns A populated `OrphanActionResult`.
 *
 * @public
 */
export async function applyDecision(
  orphan: OrphanRecord,
  decision: OrphanDecision,
  now: string,
  recordRow: RecordRowFn,
): Promise<OrphanActionResult> {
  const base: Omit<OrphanActionResult, 'decision' | 'applied' | 'refusal' | 'archivedTo'> = {
    orphan,
    decidedAt: now,
  };

  if (decision === 'canonical-adopt') {
    return {
      ...base,
      decision,
      applied: false,
      refusal: canonicalAdoptRefusal(),
      archivedTo: null,
    };
  }

  if (decision === 'skip') {
    return { ...base, decision, applied: true, refusal: null, archivedTo: null };
  }

  if (decision === 'user-adopt') {
    try {
      await recordRow(buildAdoptedRow(orphan, now));
      return { ...base, decision, applied: true, refusal: null, archivedTo: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ...base,
        decision,
        applied: false,
        refusal: {
          code: 'E_CANONICAL_ADOPT_REFUSED',
          message: `user-adopt failed: ${message}`,
          remediation: 'Initialise the registry with `cleo skills list` then re-run.',
        },
        archivedTo: null,
      };
    }
  }

  // delete
  try {
    const archived = archiveAndDelete(orphan, now);
    return { ...base, decision, applied: true, refusal: null, archivedTo: archived };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      decision,
      applied: false,
      refusal: {
        code: 'E_CANONICAL_ADOPT_REFUSED',
        message: `delete failed: ${message}`,
        remediation: 'Inspect filesystem permissions and rerun with --non-interactive to verify.',
      },
      archivedTo: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * Write the audit log to `~/.cleo/skills/.audit-log/adopt-<ts>.json`.
 *
 * @remarks
 * The log is written atomically (tmp-then-rename) so a SIGINT mid-write
 * cannot leave a half-written file. The payload is a structured object
 * containing the run timestamp, mode, full per-orphan results, and a
 * stable `runId` UUID for cross-referencing in other CLEO audit streams
 * (e.g. release-ship logs).
 *
 * @param result - The doctor-adopt result to persist.
 * @returns Absolute path the audit log was written to.
 *
 * @public
 */
export function writeAuditLog(result: DoctorAdoptResult): string {
  const dir = auditLogRoot();
  mkdirSync(dir, { recursive: true });
  const tsToken = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `adopt-${tsToken}.json`);
  const tmp = `${path}.tmp`;
  const payload = {
    runId: randomUUID(),
    writtenAt: new Date().toISOString(),
    ...result,
  };
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  // Atomic rename — fs.renameSync is atomic within the same filesystem.
  renameSync(tmp, path);
  return path;
}

// ---------------------------------------------------------------------------
// Interactive prompt
// ---------------------------------------------------------------------------

/**
 * Readline interface shape used by {@link promptDecision}.
 *
 * @internal
 */
type ReadlineInterface = ReturnType<typeof createInterface>;

/**
 * Prompt the user for a decision on a single orphan.
 *
 * @remarks
 * Accepts one-letter shortcuts (`c`/`u`/`d`/`s`) for canonical-adopt,
 * user-adopt, delete, and skip respectively. Unknown inputs re-prompt up
 * to 3 times before defaulting to `skip` (safest no-op disposition).
 *
 * @param rl - Pre-created readline interface (re-used across orphans).
 * @param orphan - Orphan to describe in the prompt header.
 * @returns Promise resolving to the chosen `OrphanDecision`.
 *
 * @internal
 */
async function promptDecision(
  rl: ReadlineInterface,
  orphan: OrphanRecord,
): Promise<OrphanDecision> {
  const kb = Math.round(orphan.sizeBytes / 1024);
  process.stderr.write(
    `\n${pc.bold(orphan.name)}\n` +
      `  path: ${orphan.path}\n` +
      `  via:  ${orphan.discoveredVia}\n` +
      `  size: ~${kb} KiB\n` +
      `  SKILL.md: ${orphan.hasSkillMd ? 'yes' : 'no'}\n`,
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = (await rl.question('  [c]anonical-adopt | [u]ser-adopt | [d]elete | [s]kip: '))
      .trim()
      .toLowerCase();
    if (answer === 'c' || answer === 'canonical' || answer === 'canonical-adopt') {
      return 'canonical-adopt';
    }
    if (answer === 'u' || answer === 'user' || answer === 'user-adopt') {
      return 'user-adopt';
    }
    if (answer === 'd' || answer === 'delete') return 'delete';
    if (answer === 's' || answer === 'skip' || answer === '') return 'skip';
    process.stderr.write(`  ${pc.yellow('unrecognised input — try one of c/u/d/s')}\n`);
  }
  return 'skip';
}

// ---------------------------------------------------------------------------
// Top-level orchestrator (callable directly for tests)
// ---------------------------------------------------------------------------

/**
 * Options controlling a `runDoctorAdopt` invocation.
 *
 * @public
 */
export interface DoctorAdoptOptions {
  /** Skip prompting and write nothing — list-only audit mode. */
  nonInteractive?: boolean;
  /** Skip prompting and bulk-adopt every orphan as `source_type='user'`. */
  autoUserAdopt?: boolean;
  /**
   * Loads the set of skill names already known to the registry.
   *
   * Production wiring opens `skills.db` via `openCleoDb('skills')`; tests
   * inject a sandbox-scoped reader.
   */
  loadRegisteredNames: () => ReadonlySet<string> | Promise<ReadonlySet<string>>;
  /**
   * Persists a single `user-adopt` decision to `skills.db`.
   *
   * Production wiring calls `upsertSkillRow` from `@cleocode/core/store`;
   * tests inject a sandbox writer.
   */
  recordRow: RecordRowFn;
  /** Test-only injection of a readline-compatible prompt. */
  prompt?: (orphan: OrphanRecord) => Promise<OrphanDecision>;
  /** Test-only opt-out of writing the audit log to disk. */
  skipAuditLog?: boolean;
  /** Test-only override for the discovery step. */
  discoverFn?: (registeredNames: ReadonlySet<string>) => OrphanRecord[];
}

/**
 * Execute the doctor-adopt workflow and return a structured result.
 *
 * @remarks
 * Designed for both CLI invocation (from {@link registerSkillsDoctorAdopt})
 * and direct testing — every side effect is overridable via
 * {@link DoctorAdoptOptions}. The function never throws on per-orphan
 * failures; instead each failure produces an `applied=false` entry with a
 * refusal payload, so the caller gets a complete report even on partial
 * failure.
 *
 * @param options - Mode flags + dependency-injected callbacks. The
 *   `loadRegisteredNames` and `recordRow` callbacks are MANDATORY so the
 *   caller (cleo dispatch or test harness) owns the sqlite open via the
 *   chokepoint.
 * @returns The populated `DoctorAdoptResult`.
 *
 * @public
 */
export async function runDoctorAdopt(options: DoctorAdoptOptions): Promise<DoctorAdoptResult> {
  const discover = options.discoverFn ?? discoverOrphans;
  const registeredNames = await options.loadRegisteredNames();
  const orphans = discover(registeredNames);
  const results: OrphanActionResult[] = [];

  const mode: DoctorAdoptResult['mode'] = options.nonInteractive
    ? 'non-interactive'
    : options.autoUserAdopt
      ? 'auto-user-adopt'
      : 'interactive';

  if (orphans.length === 0) {
    const empty: DoctorAdoptResult = {
      totalOrphans: 0,
      results: [],
      auditLogPath: '',
      mode,
    };
    if (!options.skipAuditLog) empty.auditLogPath = writeAuditLog(empty);
    return empty;
  }

  if (mode === 'non-interactive') {
    // Read-only: record a `skip` for every orphan without touching disk
    // beyond the audit log.
    const now = new Date().toISOString();
    for (const orphan of orphans) {
      results.push({
        orphan,
        decision: 'skip',
        applied: true,
        refusal: null,
        archivedTo: null,
        decidedAt: now,
      });
    }
  } else if (mode === 'auto-user-adopt') {
    for (const orphan of orphans) {
      results.push(
        await applyDecision(orphan, 'user-adopt', new Date().toISOString(), options.recordRow),
      );
    }
  } else {
    // interactive
    const promptFn =
      options.prompt ??
      (async (orphan: OrphanRecord): Promise<OrphanDecision> => {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try {
          return await promptDecision(rl, orphan);
        } finally {
          rl.close();
        }
      });
    for (const orphan of orphans) {
      const decision = await promptFn(orphan);
      results.push(
        await applyDecision(orphan, decision, new Date().toISOString(), options.recordRow),
      );
    }
  }

  const result: DoctorAdoptResult = {
    totalOrphans: orphans.length,
    results,
    auditLogPath: '',
    mode,
  };
  if (!options.skipAuditLog) result.auditLogPath = writeAuditLog(result);
  return result;
}

// ---------------------------------------------------------------------------
// CLI registration
// ---------------------------------------------------------------------------

/**
 * Default skill-name loader bound at CLI dispatch time.
 *
 * @remarks
 * Re-exported so the cleo dispatch layer can construct it once and inject
 * the same instance into {@link runDoctorAdopt}.
 *
 * @public
 */
export type RegisteredNamesLoader = () => ReadonlySet<string> | Promise<ReadonlySet<string>>;

/**
 * Adapter callbacks the CLI registrar needs to satisfy
 * {@link DoctorAdoptOptions}'s mandatory deps.
 *
 * @remarks
 * The caamp CLI (`caamp skills doctor adopt-orphans`) supplies a no-op pair
 * — caamp is the registry-author-tool and never touches a live skills.db.
 * The cleo CLI overrides both with chokepoint-routed implementations.
 *
 * @public
 */
export interface DoctorAdoptCliAdapters {
  loadRegisteredNames: RegisteredNamesLoader;
  recordRow: RecordRowFn;
}

/**
 * Standalone-`caamp` defaults — no DB access, every directory is an orphan.
 *
 * @remarks
 * In the standalone caamp CLI, there's no skills.db (caamp is the
 * registry-author tool, not the user-runtime). We treat every directory as
 * an orphan and refuse all user-adopt writes by surfacing an explanatory
 * error through `recordRow`. The cleo CLI overrides this with the real
 * chokepoint-routed adapters.
 *
 * @public
 */
export const caampStandaloneAdapters: DoctorAdoptCliAdapters = {
  loadRegisteredNames: () => new Set<string>(),
  recordRow: () => {
    throw new Error(
      'caamp standalone CLI cannot write to skills.db. Use `cleo skills doctor adopt-orphans` instead.',
    );
  },
};

/**
 * Register the `skills doctor adopt-orphans` subcommand on the parent
 * `skills` Commander group.
 *
 * @remarks
 * The handler creates the `doctor` subgroup if it doesn't already exist on
 * the parent, so registration order is tolerant of any future co-registration
 * with sibling `doctor` subcommands. Adapters default to
 * {@link caampStandaloneAdapters} which surface a clear error — pass the
 * cleo-chokepoint adapters when wiring under `packages/cleo/`.
 *
 * Default output is LAFS JSON. Pass `--human` for the colorised summary.
 *
 * @param parent - The parent `skills` Command from
 *   {@link registerSkillsCommands}.
 * @param adapters - DB read/write hooks. Defaults to
 *   {@link caampStandaloneAdapters} so the standalone caamp CLI surfaces a
 *   helpful error rather than silently no-op'ing.
 *
 * @example
 * ```bash
 * cleo skills doctor adopt-orphans                 # interactive
 * cleo skills doctor adopt-orphans --non-interactive
 * cleo skills doctor adopt-orphans --auto-user-adopt --json
 * ```
 *
 * @public
 */
export function registerSkillsDoctorAdopt(
  parent: Command,
  adapters: DoctorAdoptCliAdapters = caampStandaloneAdapters,
): void {
  // Reuse an existing `doctor` subgroup if one is already attached on the
  // parent; otherwise create one. Commander tolerates `.command()` being
  // called twice with the same name but only one will surface in `--help`,
  // so we prefer reuse.
  const existing = parent.commands.find((c) => c.name() === 'doctor');
  const doctor =
    existing ?? parent.command('doctor').description('Diagnostics + repair for the skill system');

  doctor
    .command('adopt-orphans')
    .description(
      'Interactive audit of on-disk skill dirs not tracked in skills.db (canonical/user/delete/skip)',
    )
    .option('--json', 'Output as LAFS JSON envelope (default)')
    .option('--human', 'Output a colorised human-readable summary')
    .option('--non-interactive', 'List orphans + exit without action')
    .option('--auto-user-adopt', 'Bulk-mark all orphans as source_type=user without prompting')
    .action(
      async (opts: {
        json?: boolean;
        human?: boolean;
        nonInteractive?: boolean;
        autoUserAdopt?: boolean;
      }) => {
        const operation = 'skills.doctor.adopt-orphans';
        const mvi: import('../../core/lafs.js').MVILevel = 'standard';

        let format: 'json' | 'human';
        try {
          format = resolveFormat({
            jsonFlag: opts.json ?? false,
            humanFlag: opts.human ?? false,
            projectDefault: 'json',
          });
        } catch (error) {
          handleFormatError(error, operation, mvi, opts.json);
        }

        try {
          const result = await runDoctorAdopt({
            nonInteractive: opts.nonInteractive ?? false,
            autoUserAdopt: opts.autoUserAdopt ?? false,
            loadRegisteredNames: adapters.loadRegisteredNames,
            recordRow: adapters.recordRow,
          });

          if (format === 'json') {
            outputSuccess(operation, mvi, result);
            return;
          }

          // Human-readable
          const ok = result.results.filter((r) => r.applied);
          const blocked = result.results.filter((r) => !r.applied);

          console.log(pc.bold(`\nskills doctor adopt-orphans (${result.mode})\n`));
          console.log(
            `  ${pc.bold('Discovered')}: ${result.totalOrphans} orphan${
              result.totalOrphans === 1 ? '' : 's'
            }`,
          );
          for (const r of result.results) {
            const icon =
              r.decision === 'skip' ? pc.dim('·') : r.applied ? pc.green('✓') : pc.red('✗');
            const verb = r.applied ? r.decision : `${r.decision} (refused)`;
            console.log(`  ${icon} ${r.orphan.name.padEnd(32)} ${pc.dim(verb)}`);
            if (r.refusal) {
              console.log(`      ${pc.yellow(r.refusal.message)}`);
              console.log(`      ${pc.dim(r.refusal.remediation)}`);
            }
            if (r.archivedTo) {
              console.log(`      ${pc.dim(`archived → ${r.archivedTo}`)}`);
            }
          }
          console.log(
            `\n  ${pc.bold('Summary')}: ${pc.green(`${ok.length} applied`)}, ` +
              `${pc.red(`${blocked.length} blocked`)}`,
          );
          if (result.auditLogPath) {
            console.log(`  ${pc.dim(`audit log → ${result.auditLogPath}`)}`);
          }
          console.log();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (format === 'json') {
            emitJsonError(
              operation,
              mvi,
              ErrorCodes.INTERNAL_ERROR,
              message,
              ErrorCategories.INTERNAL,
            );
          } else {
            console.error(pc.red(`Error: ${message}`));
          }
          process.exit(1);
        }
      },
    );
}
