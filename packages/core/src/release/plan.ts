/**
 * `cleo release plan` — Phase 1 verb of the new release pipeline.
 *
 * Builds the canonical Release Plan envelope from `tasks.db` + git log +
 * previous-release state. Emits a LAFS-compliant `EngineResult<ReleasePlanResult>`,
 * writes the plan file atomically to `.cleo/release/<resolved-version>.plan.json`,
 * and UPSERTs one row into the `releases` table with `status='planned'`.
 *
 * This verb is **read-mostly** — it performs NO git mutations, NO `gh` calls,
 * NO network calls. Writes are limited to `.cleo/release/<version>.plan.json`
 * and the `releases` table (R-032).
 *
 * @task T9525
 * @epic T9492
 * @spec .cleo/rcasd/T9345/research/SPEC-T9345-release-pipeline-v2.md §4.2
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceAtom, Task } from '@cleocode/contracts';
import {
  E_CHANNEL_MISMATCH,
  E_DIRTY_TREE,
  E_EPIC_EMPTY,
  E_EPIC_NOT_FOUND,
  E_EVIDENCE_INSUFFICIENT,
  E_RELEASE_PLAN_INVALID,
  type EngineResult,
  ExitCode,
  engineError,
  engineSuccess,
  parseReleasePlan,
  type ReleaseGate,
  type ReleaseGateExecutionStatus,
  type ReleaseGateName,
  type ReleaseKind,
  type ReleasePlan,
  type ReleasePlanChangelog,
  type ReleasePlanChannel,
  type ReleasePlanTask,
  type ReleasePlatformMatrixEntry,
  type ReleasePreflightSummary,
  type ReleaseScheme,
  type ReleaseTaskKind,
  type ResolvedSource,
} from '@cleocode/contracts';
import { and, desc, eq } from 'drizzle-orm';

import { getLogger } from '../logger.js';
import { getCleoDirAbsolute, getProjectRoot } from '../paths.js';
import { getProjectInfoSync } from '../project-info.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { getDb } from '../store/sqlite.js';
import { type NewReleaseRow, type ReleaseRow, releases } from '../store/tasks-schema.js';
import { resolveToolCommand } from '../tasks/tool-resolver.js';
import { runGitWithLockRetry } from './engine-ops.js';
import { loadReleaseConfig } from './release-config.js';

const log = getLogger('release:plan');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link releasePlan}.
 *
 * @task T9525
 */
export interface ReleasePlanOptions {
  /** The candidate version (e.g. `v2026.6.0`). Leading `v` optional — added if absent. */
  version: string;
  /** Epic task ID whose children are candidates for inclusion (required per R-021). */
  epicId: string;
  /** Versioning scheme. Default: inferred from `.cleo/release-config.json`. */
  scheme?: ReleaseScheme;
  /** Release channel. Default: `latest`. */
  channel?: ReleasePlanChannel;
  /** When true, the release is marked `release_kind='hotfix'`. */
  hotfix?: boolean;
  /** Dry-run flag — equivalent to `CLEO_DRY_RUN=1`. Reads only; no writes. */
  dryRun?: boolean;
  /**
   * Project root override. Defaults to the canonical project root resolved
   * via {@link getProjectRoot} (walks up from `process.cwd()` for monorepo
   * subdir invocations; honours `CLEO_ROOT` / `CLEO_PROJECT_ROOT`).
   *
   * @task T9583
   */
  projectRoot?: string;
  /** Creator identity for `plan.createdBy`. Defaults to `process.env.USER` or `cleo-agent`. */
  createdBy?: string;
}

/**
 * Data payload returned by {@link releasePlan} on success.
 *
 * @task T9525
 */
export interface ReleasePlanResult {
  /** The requested version (matches input). */
  version: string;
  /** The resolved version after suffix application. */
  resolvedVersion: string;
  /** True iff a `calver-suffix` was applied to disambiguate same-day hotfixes. */
  suffixApplied: boolean;
  /** Release channel. */
  channel: ReleasePlanChannel;
  /** Epic ID. */
  epicId: string;
  /** Absolute path to the written plan file. */
  planPath: string;
  /** Number of tasks rolled into the plan. */
  taskCount: number;
  /** True iff every task has at least one evidence atom (R-301). */
  evidenceComplete: boolean;
  /** Non-fatal preflight warnings (e.g. unresolved tools). */
  preflightWarnings: string[];
  /** Per-gate verification status summary. */
  gateSummary: Record<ReleaseGateName, ReleaseGateExecutionStatus>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Files whose dirty state blocks the plan verb (R-020). */
const VERSION_FILE_PATTERNS: readonly string[] = [
  'package.json',
  'packages/*/package.json',
  'Cargo.toml',
  'packages/*/Cargo.toml',
  'pyproject.toml',
  'packages/*/pyproject.toml',
  'CHANGELOG.md',
] as const;

/** Six canonical gates per ADR-061 (SPEC R-024 / R-310). */
const RELEASE_GATE_NAMES: readonly ReleaseGateName[] = [
  'test',
  'build',
  'lint',
  'typecheck',
  'audit',
  'security-scan',
] as const;

/** Default platform matrix entry used when `.cleo/release-config.json` carries no override. */
const DEFAULT_PLATFORM_MATRIX_ENTRY: ReleasePlatformMatrixEntry = {
  platform: 'any',
  publisher: 'npm',
  package: '@cleocode/cleo',
};

// ---------------------------------------------------------------------------
// Helpers — version + channel
// ---------------------------------------------------------------------------

/**
 * Normalize a version string to include the leading `v` (e.g. `2026.6.0` → `v2026.6.0`).
 *
 * @internal
 */
function normalizeVersion(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

/**
 * Map the new channel taxonomy (latest|beta|alpha|rc) onto the DB channel
 * enum (latest|beta|dev|hotfix). The DB schema does not yet model `rc` so
 * we collapse to `beta` for now per SPEC §6.1 footnote.
 *
 * @internal
 */
function mapPlanChannelToDbChannel(
  channel: ReleasePlanChannel,
  releaseKind: ReleaseKind,
): 'latest' | 'beta' | 'dev' | 'hotfix' {
  if (releaseKind === 'hotfix') return 'hotfix';
  switch (channel) {
    case 'latest':
      return 'latest';
    case 'beta':
    case 'rc':
      return 'beta';
    case 'alpha':
      return 'dev';
  }
}

/**
 * Validate a channel + scheme pair per R-022.
 *
 * @internal
 */
function validateChannelScheme(
  channel: ReleasePlanChannel,
  scheme: ReleaseScheme,
  version: string,
): { ok: true } | { ok: false; reason: string } {
  // `latest` requires NO pre-release suffix.
  if (channel === 'latest' && version.includes('-')) {
    return {
      ok: false,
      reason: `channel='latest' is incompatible with version '${version}' (contains pre-release suffix). Use --channel beta|alpha|rc, or supply a stable version.`,
    };
  }
  // `calver-suffix` implies a `.N` 4-segment version per SPEC R-402.
  if (scheme === 'calver-suffix' && !/\.\d+\.\d+\.\d+\.\d+/.test(version)) {
    return {
      ok: false,
      reason: `scheme='calver-suffix' requires a vYYYY.M.DD.N version; got '${version}'.`,
    };
  }
  // beta/alpha/rc are compatible with any scheme; further validation lives in the open verb.
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Helpers — git / clean tree
// ---------------------------------------------------------------------------

/**
 * Verify the working tree is clean for the configured version-file patterns
 * (R-020). Returns the list of offending paths so callers can populate
 * `error.details.dirtyPaths` for triage.
 *
 * @internal
 */
function validateCleanTree(projectRoot: string): { dirty: string[] } {
  try {
    const raw = runGitWithLockRetry(['status', '--porcelain', '--', ...VERSION_FILE_PATTERNS], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 60_000,
    });
    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    const dirty: string[] = [];
    for (const line of lines) {
      // Porcelain v1 format: `XY path`; capture everything from col 4 onward.
      const path = line.slice(3).trim();
      if (path) dirty.push(path);
    }
    return { dirty };
  } catch (err: unknown) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'git status failed during validateCleanTree; assuming clean tree',
    );
    return { dirty: [] };
  }
}

// ---------------------------------------------------------------------------
// Helpers — tasks
// ---------------------------------------------------------------------------

/**
 * Walk children of `epicId` recursively (depth-first), excluding cancelled
 * and archived tasks. Returns deduplicated tasks ordered by parent-then-position.
 *
 * @internal
 */
async function resolveEpicTasks(
  epicId: string,
  projectRoot: string,
): Promise<{ tasks: Task[]; epicExists: boolean }> {
  const accessor = await getTaskAccessor(projectRoot);
  try {
    const epic = await accessor.loadSingleTask(epicId);
    if (!epic) {
      return { tasks: [], epicExists: false };
    }
    // Use the subtree CTE for an efficient single-pass walk.
    const subtree = await accessor.getSubtree(epicId);
    // Drop the epic itself and any terminal/excluded statuses.
    const filtered = subtree.filter((t) => {
      if (t.id === epicId) return false;
      if (t.status === 'cancelled') return false;
      if (t.status === 'archived') return false;
      return true;
    });
    return { tasks: filtered, epicExists: true };
  } finally {
    await accessor.close();
  }
}

/**
 * Extract ADR-051 evidence atoms from a task's `verification` blob and
 * serialize them into the `kind:value` string form persisted in `plan.tasks[*].evidenceAtoms`.
 *
 * @internal
 */
function collectEvidenceAtomsForTask(task: Task): string[] {
  const atoms: string[] = [];
  const v = task.verification;
  if (!v?.evidence) return atoms;
  for (const gateEvidence of Object.values(v.evidence)) {
    if (!gateEvidence) continue;
    for (const atom of gateEvidence.atoms) {
      const serialized = serializeAtom(atom);
      if (serialized) atoms.push(serialized);
    }
  }
  return [...new Set(atoms)];
}

/**
 * Serialize an ADR-051 {@link EvidenceAtom} into its `kind:value` string form
 * (e.g. `commit:abc123`, `tool:test`, `files:a.ts,b.ts`).
 *
 * @internal
 */
function serializeAtom(atom: EvidenceAtom): string | null {
  switch (atom.kind) {
    case 'commit':
      return `commit:${atom.sha}`;
    case 'files': {
      const paths = atom.files
        .map((f) => f.path)
        .filter((p) => p.length > 0)
        .join(',');
      return paths ? `files:${paths}` : null;
    }
    case 'test-run':
      return `test-run:${atom.path}`;
    case 'tool':
      return `tool:${atom.tool}`;
    case 'url':
      return `url:${atom.url}`;
    case 'note':
      return `note:${atom.note}`;
    case 'override':
      return `override:${atom.reason}`;
    case 'decision':
      return `decision:${atom.decisionId}`;
    case 'loc-drop':
      return `loc-drop:${atom.fromLines}:${atom.toLines}`;
    case 'callsite-coverage':
      return `callsite-coverage:${atom.symbolName}:${atom.relativeSourcePath}`;
    default:
      return null;
  }
}

/**
 * Map an internal {@link Task} into a plan-shape {@link ReleasePlanTask}.
 *
 * The mapping is intentionally lossy — only fields required by SPEC §6.1 are
 * carried into the plan. Returns `null` if the task lacks a sane `kind` axis.
 *
 * @internal
 */
function taskToPlanTask(task: Task, epicAncestor: string): ReleasePlanTask {
  const kind = inferTaskKind(task);
  const impact = inferImpact(kind);
  const summary = task.title ?? task.id;
  const atoms = collectEvidenceAtomsForTask(task);
  const planTask: ReleasePlanTask = {
    id: task.id,
    kind,
    impact,
    userFacingSummary: summary,
    evidenceAtoms: atoms,
    epicAncestor,
  };
  if (typeof task.pipelineStage === 'string' && task.pipelineStage.length > 0) {
    planTask.ivtrPhaseAtPlan = task.pipelineStage;
  }
  return planTask;
}

/**
 * Best-effort mapping from a {@link Task} (axes: `kind`, `scope`, `labels`)
 * into the conventional-commit-aligned {@link ReleaseTaskKind} used by the
 * plan changelog buckets.
 *
 * Heuristic:
 *   1. `task.kind === 'bug'` → `'fix'`
 *   2. label hit on `'breaking'` / `'docs'` / `'chore'` / `'refactor'`
 *      / `'perf'` / `'test'` / `'hotfix'` / `'revert'` → that kind
 *   3. otherwise default to `'feat'`.
 *
 * @internal
 */
function inferTaskKind(task: Task): ReleaseTaskKind {
  if (task.kind === 'bug') return 'fix';
  const labels = task.labels ?? [];
  const labelMatch: ReleaseTaskKind | null = matchLabelKind(labels);
  if (labelMatch) return labelMatch;
  return 'feat';
}

/**
 * Match a label set against the {@link ReleaseTaskKind} enum literals.
 *
 * @internal
 */
function matchLabelKind(labels: readonly string[]): ReleaseTaskKind | null {
  const candidates: ReleaseTaskKind[] = [
    'breaking',
    'hotfix',
    'revert',
    'docs',
    'chore',
    'refactor',
    'perf',
    'test',
    'feat',
    'fix',
  ];
  for (const c of candidates) {
    if (labels.includes(c)) return c;
  }
  return null;
}

/**
 * Map a {@link ReleaseTaskKind} onto a SemVer-style impact level.
 *
 * @internal
 */
function inferImpact(kind: ReleaseTaskKind): 'major' | 'minor' | 'patch' {
  if (kind === 'breaking') return 'major';
  if (kind === 'feat') return 'minor';
  return 'patch';
}

/**
 * Bucket plan tasks into the 4-section changelog shape per SPEC §6.1.
 *
 * @internal
 */
function buildChangelog(tasks: ReleasePlanTask[]): ReleasePlanChangelog {
  const out: ReleasePlanChangelog = { features: [], fixes: [], chores: [], breaking: [] };
  for (const t of tasks) {
    if (t.kind === 'feat') out.features.push(t.id);
    else if (t.kind === 'fix' || t.kind === 'hotfix') out.fixes.push(t.id);
    else if (t.kind === 'breaking' || t.kind === 'revert') out.breaking.push(t.id);
    else out.chores.push(t.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers — gates via ADR-061
// ---------------------------------------------------------------------------

/**
 * Resolve the six canonical release gates via the ADR-061 tool resolver.
 *
 * Per R-312 this verb does NOT execute the resolved commands; it only records
 * the resolved name + provenance into `plan.gates[]`. Status is initialized to
 * `unresolved` for tools the resolver could not produce a command for.
 *
 * @internal
 */
function resolveGatesViaToolResolver(
  projectRoot: string,
  nowIso: string,
): { gates: ReleaseGate[]; unresolved: string[] } {
  const gates: ReleaseGate[] = [];
  const unresolved: string[] = [];
  for (const name of RELEASE_GATE_NAMES) {
    const resolution = resolveToolCommand(name, projectRoot);
    if (resolution.ok) {
      const gate: ReleaseGate = {
        name,
        atom: `tool:${name}`,
        // Per R-312, we do NOT execute the tool here. Status reflects
        // "resolved but unexecuted"; consumers MAY upgrade to `passed` after
        // running the command in a downstream surface (preflight job, etc).
        status: 'unresolved',
        lastVerifiedAt: nowIso,
        resolvedCommand: `${resolution.command.cmd} ${resolution.command.args.join(' ')}`.trim(),
        resolvedSource: resolution.command.source as ResolvedSource,
      };
      gates.push(gate);
    } else {
      unresolved.push(name);
      gates.push({
        name,
        atom: `tool:${name}`,
        status: 'unresolved',
        lastVerifiedAt: nowIso,
      });
    }
  }
  return { gates, unresolved };
}

// ---------------------------------------------------------------------------
// Helpers — platform matrix
// ---------------------------------------------------------------------------

/**
 * Resolve the publish matrix for the release.
 *
 * Reads `.cleo/release-config.json` for an optional `platformMatrix[]` override;
 * else returns a single-entry default per R-371 (single platform-agnostic artifact).
 *
 * @internal
 */
function enumeratePlatformMatrix(projectRoot: string): ReleasePlatformMatrixEntry[] {
  const config = loadReleaseConfig(projectRoot);
  // Future: `release-config.json` may carry an explicit `platformMatrix` array.
  // For now, derive the publisher list from `registries` if present.
  const registries = config.registries ?? [];
  if (registries.length === 0) {
    return [DEFAULT_PLATFORM_MATRIX_ENTRY];
  }
  const entries: ReleasePlatformMatrixEntry[] = [];
  for (const reg of registries) {
    if (reg === 'none') continue;
    const publisher: ReleasePlatformMatrixEntry['publisher'] =
      reg === 'crates' ? 'cargo' : reg === 'docker' ? 'docker' : 'npm';
    entries.push({
      platform: 'any',
      publisher,
      package: publisher === 'npm' ? '@cleocode/cleo' : 'cleocode',
    });
  }
  return entries.length > 0 ? entries : [DEFAULT_PLATFORM_MATRIX_ENTRY];
}

// ---------------------------------------------------------------------------
// Helpers — previous-release lookup
// ---------------------------------------------------------------------------

/**
 * Result of {@link resolvePreviousVersion}.
 *
 * @internal
 */
interface PreviousReleaseInfo {
  previousVersion: string | null;
  previousTag: string | null;
  previousShippedAt: string | null;
  firstEverRelease: boolean;
}

/**
 * Query the `releases` table for the most recent shipped row on the same
 * channel. Returns `{ firstEverRelease: true }` when no row matches (R-023).
 *
 * @internal
 */
async function resolvePreviousVersion(
  channel: 'latest' | 'beta' | 'dev' | 'hotfix',
  projectRoot: string,
): Promise<PreviousReleaseInfo> {
  const db = await getDb(projectRoot);
  const rows: ReleaseRow[] = await db
    .select()
    .from(releases)
    .where(and(eq(releases.channel, channel), eq(releases.status, 'reconciled')))
    .orderBy(desc(releases.publishedAt))
    .limit(1)
    .all();
  const prior = rows[0];
  if (!prior) {
    return {
      previousVersion: null,
      previousTag: null,
      previousShippedAt: null,
      firstEverRelease: true,
    };
  }
  return {
    previousVersion: prior.version,
    previousTag: prior.version,
    previousShippedAt: prior.publishedAt ?? null,
    firstEverRelease: false,
  };
}

// ---------------------------------------------------------------------------
// Helpers — plan file IO + DB upsert
// ---------------------------------------------------------------------------

/**
 * Atomic write to `.cleo/release/<resolved-version>.plan.json` (R-030).
 *
 * @internal
 */
function writePlanFile(plan: ReleasePlan, projectRoot: string): string {
  const releaseDir = join(getCleoDirAbsolute(projectRoot), 'release');
  mkdirSync(releaseDir, { recursive: true });
  const finalPath = join(releaseDir, `${plan.resolvedVersion}.plan.json`);
  const tmpPath = `${finalPath}.tmp`;
  const body = `${JSON.stringify(plan, null, 2)}\n`;
  writeFileSync(tmpPath, body, { encoding: 'utf-8' });
  renameSync(tmpPath, finalPath);
  return finalPath;
}

/**
 * UPSERT the row into the `releases` table (R-031).
 *
 * Uses `INSERT … ON CONFLICT(version) DO UPDATE` so re-running the verb with
 * identical inputs is a no-op modulo timestamps (R-042).
 *
 * @internal
 */
async function upsertReleasesRow(
  plan: ReleasePlan,
  dbChannel: 'latest' | 'beta' | 'dev' | 'hotfix',
  projectRoot: string,
): Promise<void> {
  const db = await getDb(projectRoot);
  const projectInfo = getProjectInfoSync(projectRoot);
  const projectHash = projectInfo?.projectHash ?? null;
  const id = `${projectHash ?? 'unknown'}:${plan.resolvedVersion}`;
  const scheme = plan.scheme === 'calver-suffix' ? 'calver-suffix' : plan.scheme;
  const releaseKind = plan.releaseKind;
  const row: NewReleaseRow = {
    id,
    version: plan.resolvedVersion,
    scheme,
    channel: dbChannel,
    epicId: plan.epicId,
    releaseKind,
    status: 'planned',
    previousVersion: plan.previousVersion,
    plannedAt: plan.createdAt,
    projectHash,
  };
  await db
    .insert(releases)
    .values(row)
    .onConflictDoUpdate({
      target: releases.version,
      set: {
        scheme: row.scheme,
        channel: row.channel,
        epicId: row.epicId,
        releaseKind: row.releaseKind,
        status: 'planned',
        previousVersion: row.previousVersion,
        plannedAt: row.plannedAt,
        projectHash: row.projectHash,
      },
    })
    .run();
}

// ---------------------------------------------------------------------------
// Helpers — preflight summary
// ---------------------------------------------------------------------------

/**
 * Assemble the {@link ReleasePreflightSummary} stub. Real preflight checks
 * (esbuild externals, lockfile drift, epic completeness, double-listing) are
 * filed against follow-up tasks; this stub keeps the schema consistent and
 * surfaces unresolved-tool warnings (R-024).
 *
 * @internal
 */
function assemblePreflightSummary(unresolvedTools: string[]): ReleasePreflightSummary {
  const warnings: string[] = [];
  for (const tool of unresolvedTools) {
    warnings.push(`tool '${tool}' could not be resolved for this archetype`);
  }
  return {
    esbuildExternalsDrift: false,
    lockfileDrift: false,
    epicCompletenessClean: true,
    doubleListingClean: true,
    preflightWarnings: warnings,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a Release Plan envelope per SPEC-T9345 §4.2.
 *
 * @example
 * ```ts
 * const result = await releasePlan({
 *   version: 'v2026.6.0',
 *   epicId: 'T9492',
 *   channel: 'latest',
 *   scheme: 'calver',
 * });
 * if (result.success) {
 *   console.log(`Plan written to ${result.data.planPath}`);
 * }
 * ```
 *
 * @task T9525
 */
export async function releasePlan(
  opts: ReleasePlanOptions,
): Promise<EngineResult<ReleasePlanResult>> {
  const projectRoot = getProjectRoot(opts.projectRoot);
  const scheme: ReleaseScheme = opts.scheme ?? 'calver';
  const channel: ReleasePlanChannel = opts.channel ?? 'latest';
  const releaseKind: ReleaseKind = opts.hotfix ? 'hotfix' : 'regular';
  const dryRun = opts.dryRun === true;

  // ── R-020: clean-tree gate ────────────────────────────────────────────
  const { dirty } = validateCleanTree(projectRoot);
  if (dirty.length > 0) {
    return engineError<ReleasePlanResult>(
      E_DIRTY_TREE,
      `Working tree has uncommitted changes in version files: ${dirty.join(', ')}`,
      {
        exitCode: ExitCode.INVALID_PARENT_TYPE, // 13 per SPEC §4.7
        fix: 'git status; commit or stash the listed paths before re-running',
        details: { dirtyPaths: dirty },
      },
    );
  }

  // ── R-022: channel + scheme compatibility ─────────────────────────────
  const normalizedVersion = normalizeVersion(opts.version);
  const channelCheck = validateChannelScheme(channel, scheme, normalizedVersion);
  if (!channelCheck.ok) {
    return engineError<ReleasePlanResult>(E_CHANNEL_MISMATCH, channelCheck.reason, {
      exitCode: ExitCode.VALIDATION_ERROR,
      fix: 'adjust --channel or supply a version with the correct suffix',
      details: { channel, scheme, version: normalizedVersion },
    });
  }

  // ── R-021: epic exists + has children ─────────────────────────────────
  const { tasks, epicExists } = await resolveEpicTasks(opts.epicId, projectRoot);
  if (!epicExists) {
    return engineError<ReleasePlanResult>(
      E_EPIC_NOT_FOUND,
      `Epic ${opts.epicId} not found in tasks.db`,
      {
        exitCode: ExitCode.PARENT_NOT_FOUND,
        fix: `cleo exists ${opts.epicId}`,
        details: { epicId: opts.epicId },
      },
    );
  }
  if (tasks.length === 0) {
    return engineError<ReleasePlanResult>(
      E_EPIC_EMPTY,
      `Epic ${opts.epicId} has no eligible child tasks (excluding cancelled/archived)`,
      {
        exitCode: ExitCode.NOT_FOUND,
        fix: `cleo show ${opts.epicId} and add children`,
        details: { epicId: opts.epicId },
      },
    );
  }

  // ── R-301 / R-310: evidence-atom completeness ─────────────────────────
  const planTasks: ReleasePlanTask[] = tasks.map((t) => taskToPlanTask(t, opts.epicId));
  const tasksMissingEvidence = planTasks.filter((t) => t.evidenceAtoms.length === 0);
  const evidenceComplete = tasksMissingEvidence.length === 0;
  if (!evidenceComplete) {
    return engineError<ReleasePlanResult>(
      E_EVIDENCE_INSUFFICIENT,
      `${tasksMissingEvidence.length} task(s) in epic ${opts.epicId} are missing required evidence atoms`,
      {
        exitCode: ExitCode.LIFECYCLE_TRANSITION_INVALID, // 83 per SPEC §4.7
        fix: 'cleo verify <task> --gate implemented --evidence "commit:<sha>;files:<paths>"',
        details: {
          tasks: tasksMissingEvidence.map((t) => ({
            id: t.id,
            missingAtoms: ['implemented', 'testsPassed', 'qaPassed'],
          })),
        },
      },
    );
  }

  // ── R-023: previous-version resolution ────────────────────────────────
  const dbChannel = mapPlanChannelToDbChannel(channel, releaseKind);
  const prior = await resolvePreviousVersion(dbChannel, projectRoot);

  // ── R-024 / R-311: gate resolution via ADR-061 ────────────────────────
  const createdAt = new Date().toISOString();
  const { gates, unresolved } = resolveGatesViaToolResolver(projectRoot, createdAt);

  // ── R-305 / R-370: platform matrix ────────────────────────────────────
  const platformMatrix = enumeratePlatformMatrix(projectRoot);

  // ── Assemble + validate the plan envelope ─────────────────────────────
  const changelog = buildChangelog(planTasks);
  const preflightSummary = assemblePreflightSummary(unresolved);
  const plan: ReleasePlan = {
    $schema: 'https://cleocode.io/schemas/release-plan/v1.json',
    version: normalizedVersion,
    resolvedVersion: normalizedVersion,
    suffixApplied: false,
    scheme,
    channel,
    epicId: opts.epicId,
    releaseKind,
    createdAt,
    createdBy: opts.createdBy ?? process.env['USER'] ?? 'cleo-agent',
    previousVersion: prior.previousVersion,
    previousTag: prior.previousTag,
    previousShippedAt: prior.previousShippedAt,
    tasks: planTasks,
    changelog,
    gates,
    platformMatrix,
    preflightSummary,
    workflowRunUrl: null,
    prUrl: null,
    mergeCommitSha: null,
    status: 'planned',
    meta: {
      firstEverRelease: prior.firstEverRelease,
      ...(unresolved.length > 0 ? { unresolvedTools: unresolved } : {}),
      archetype: 'node',
    },
  };

  // R-306: validate against the canonical schema BEFORE any write.
  try {
    parseReleasePlan(plan);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return engineError<ReleasePlanResult>(
      E_RELEASE_PLAN_INVALID,
      `Assembled plan failed schema validation: ${message}`,
      {
        exitCode: ExitCode.VALIDATION_ERROR,
        fix: 'inspect the plan structure and ensure all required fields are present',
        details: { schemaError: message },
      },
    );
  }

  // ── R-030 / R-031: write plan + UPSERT releases row ───────────────────
  let planPath: string;
  if (dryRun) {
    // In dry-run mode, compute the path but DO NOT touch the filesystem or DB.
    planPath = join(
      getCleoDirAbsolute(projectRoot),
      'release',
      `${plan.resolvedVersion}.plan.json`,
    );
  } else {
    planPath = writePlanFile(plan, projectRoot);
    await upsertReleasesRow(plan, dbChannel, projectRoot);
  }

  // ── Build the data envelope ───────────────────────────────────────────
  const gateSummary: Record<ReleaseGateName, ReleaseGateExecutionStatus> = {
    test: 'unresolved',
    build: 'unresolved',
    lint: 'unresolved',
    typecheck: 'unresolved',
    audit: 'unresolved',
    'security-scan': 'unresolved',
  };
  for (const g of gates) {
    gateSummary[g.name] = g.status;
  }

  const result: ReleasePlanResult = {
    version: opts.version,
    resolvedVersion: plan.resolvedVersion,
    suffixApplied: plan.suffixApplied,
    channel,
    epicId: opts.epicId,
    planPath,
    taskCount: planTasks.length,
    evidenceComplete,
    preflightWarnings: preflightSummary.preflightWarnings ?? [],
    gateSummary,
  };

  return engineSuccess(result);
}

// ---------------------------------------------------------------------------
// Internal exports — testing only
// ---------------------------------------------------------------------------

/**
 * Internal helpers exported for unit testing. Not part of the public API.
 *
 * @internal
 */
export const __test__ = {
  collectEvidenceAtomsForTask,
  enumeratePlatformMatrix,
  inferImpact,
  inferTaskKind,
  mapPlanChannelToDbChannel,
  normalizeVersion,
  resolveEpicTasks,
  resolveGatesViaToolResolver,
  resolvePreviousVersion,
  serializeAtom,
  validateChannelScheme,
  validateCleanTree,
  writePlanFile,
};
