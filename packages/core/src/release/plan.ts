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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangesetEntry, EvidenceAtom, Task } from '@cleocode/contracts';
import {
  ChangesetYamlInvalidError,
  E_CHANGESET_YAML_INVALID,
  E_CHANNEL_MISMATCH,
  E_DIRTY_TREE,
  E_EPIC_EMPTY,
  E_EPIC_EMPTY_LEAF_NO_EVIDENCE,
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
import { desc, eq } from 'drizzle-orm';

import { parseChangesetDir } from '../changesets/index.js';
import { WriterRegistry } from '../docs/writer-registry.js';
import { getLogger } from '../logger.js';
import { getCleoDirAbsolute, getProjectRoot } from '../paths.js';
import { getProjectInfoSync } from '../project-info.js';
import { SAGA_GROUPS_RELATION } from '../sagas/constants.js';
import { isSagaShape } from '../sagas/enforcement.js';
import { atomicWrite } from '../store/atomic.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { getDb } from '../store/sqlite.js';
import {
  type NewReleaseChangesetRow,
  type NewReleaseRow,
  type ReleaseRow,
  releaseChangesets,
  releases,
} from '../store/tasks-schema.js';
import { resolveToolCommand } from '../tasks/tool-resolver.js';
import { aggregateChangesetsForRelease } from './changesets-aggregator.js';
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
  /**
   * Epic task ID whose children are candidates for inclusion (required per
   * R-021 UNLESS `sagaId` is set). Mutually exclusive with `sagaId`.
   *
   * Per ADR-073 the leaf-Epic-as-PR pattern is canonical: an Epic with zero
   * non-cancelled child tasks is valid input. In that case the Epic itself
   * is treated as the singleton task for evidence aggregation.
   *
   * @task T9525
   * @task T9838 — leaf-Epic-as-Task fallback
   */
  epicId?: string;
  /**
   * Saga task ID — when supplied, the plan aggregates the member Epics linked
   * to the Saga via `task_relations.relation_type='groups'` (ADR-073 I3).
   * Member Epics are aggregated recursively the same way `--epic` does today:
   * union of children of each member epic, OR for leaf-epics, the epic itself.
   *
   * Mutually exclusive with `epicId`. The resulting plan's `plan.epicId` is
   * set to the Saga ID for traceability.
   *
   * @task T9838
   */
  sagaId?: string;
  /**
   * Explicit task-list release scope. When set, the plan includes exactly these
   * non-cancelled/non-archived task rows in caller order after de-duplication.
   * Mutually exclusive with `epicId` and `sagaId`.
   *
   * @task T10088
   */
  taskIds?: string[];
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
  /**
   * When true (default), `cleo release plan` also writes the aggregated
   * release notes into `CHANGELOG.md` under a `## [<version>] (<date>)` block.
   * Idempotent on re-run via section-replace. Set to `false` to opt out and
   * keep the plan envelope as the sole sink for release notes.
   *
   * @task T9838 — auto-write CHANGELOG.md (gap 3 of v5.93 manual-ship saga)
   */
  writeChangelog?: boolean;
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
  /**
   * Number of CLEO-native changeset entries (`.changeset/*.md`) rolled into
   * this release. Zero when `.changeset/` is absent or empty.
   *
   * @task T9753
   */
  changesetEntryCount: number;
  /**
   * True iff `cleo release plan` wrote (or replaced) the `## [<version>]`
   * section in `CHANGELOG.md`. False when `writeChangelog=false`, when the
   * aggregated notes are empty, or when the file write was skipped under
   * `dryRun`.
   *
   * @task T9838
   */
  changelogWritten: boolean;
  /**
   * Absolute path to the CHANGELOG.md the plan flow targeted. Set even when
   * `changelogWritten=false` so consumers know where the file would have been
   * written.
   *
   * @task T9838
   */
  changelogPath: string;
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

/**
 * Subset of {@link VERSION_FILE_PATTERNS} the plan verb writes itself when
 * `writeChangelog=true` (T9838). When the only dirty path is one of these,
 * the clean-tree gate is bypassed so re-runs remain idempotent. The dirty
 * status is the plan verb's OWN output from a prior invocation — not a stale
 * manual edit.
 */
const PLAN_WRITTEN_FILE_PATTERNS: readonly string[] = ['CHANGELOG.md'] as const;

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
 * Resolution outcome of {@link resolveEpicTasks}.
 *
 * `isLeafEpic=true` is set when the Epic exists but has no non-cancelled
 * child tasks. Per ADR-073 the leaf-Epic-as-PR pattern is canonical — the
 * caller can fall back to the Epic itself as the singleton task list for
 * evidence + changeset aggregation when this flag is true.
 *
 * @internal
 * @task T9838
 */
interface EpicResolution {
  /** Non-cancelled, non-archived descendants of the Epic (excludes the Epic itself). */
  tasks: Task[];
  /** True iff the Epic ID resolves to a row in `tasks`. */
  epicExists: boolean;
  /**
   * The Epic row itself (when `epicExists=true`). Carried out so callers can
   * extract `verification.evidence` for the leaf-Epic-as-Task path without a
   * second DB round-trip.
   */
  epic: Task | null;
  /**
   * True iff `epicExists=true` AND `tasks.length === 0` after status filtering.
   * Signals to the caller that the Epic should be treated as the singleton
   * task list per ADR-073 leaf-Epic semantics.
   */
  isLeafEpic: boolean;
}

/**
 * Walk children of `epicId` recursively (depth-first), excluding cancelled
 * and archived tasks. Returns deduplicated tasks ordered by parent-then-position.
 *
 * Per ADR-073 (T9838): when the Epic exists but has zero non-cancelled
 * children, `isLeafEpic=true` is set and `tasks=[]`. Callers MUST decide
 * whether to treat the leaf Epic as a singleton (release-as-PR pattern) or
 * surface `E_EPIC_EMPTY` (Saga case where zero member Epics is an error).
 *
 * @internal
 */
async function resolveEpicTasks(epicId: string, projectRoot: string): Promise<EpicResolution> {
  const accessor = await getTaskAccessor(projectRoot);
  try {
    const epic = await accessor.loadSingleTask(epicId);
    if (!epic) {
      return { tasks: [], epicExists: false, epic: null, isLeafEpic: false };
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
    return {
      tasks: filtered,
      epicExists: true,
      epic,
      isLeafEpic: filtered.length === 0,
    };
  } finally {
    await accessor.close();
  }
}

/**
 * Resolution outcome of {@link resolveSagaTasks}.
 *
 * @internal
 * @task T9838
 */
interface SagaResolution {
  /** Aggregated tasks across all member Epics (excludes cancelled/archived). */
  tasks: Task[];
  /** True iff the Saga ID resolves to a task. */
  sagaExists: boolean;
  /** True iff the resolved task carries `labels.includes('saga')`. */
  isSaga: boolean;
  /** IDs of member Epics linked to the Saga via `relation_type='groups'`. */
  memberEpicIds: string[];
  /**
   * Per-member resolution outcomes — useful to surface a leaf-Epic member's
   * evidence atoms during aggregation. Indexed by `memberEpicIds`.
   */
  memberResolutions: Map<string, EpicResolution>;
}

/**
 * Resolve a Saga (ADR-073 labeled Epic) and aggregate its member Epics into
 * a single task list for `cleo release plan --saga T####`.
 *
 * Saga membership lives in `task_relations.relation_type='groups'` rows
 * sourced from `from_id = sagaId`. This helper:
 *
 *  1. Loads the saga task and verifies `labels.includes('saga')`.
 *  2. Walks `relates[]` (populated by `loadSingleTask`) for `type='groups'` edges.
 *  3. For each member Epic, runs the same {@link resolveEpicTasks} walk and
 *     unions the result. Leaf-Epic members contribute the Epic itself.
 *
 * Returns `{ sagaExists: false }` when the ID doesn't resolve, `{ isSaga: false }`
 * when the task exists but lacks `labels.includes('saga')`. The caller maps
 * these into `E_NOT_FOUND` / `E_INVALID_INPUT` respectively.
 *
 * @internal
 * @task T9838
 */
async function resolveSagaTasks(sagaId: string, projectRoot: string): Promise<SagaResolution> {
  const accessor = await getTaskAccessor(projectRoot);
  try {
    const saga = await accessor.loadSingleTask(sagaId);
    if (!saga) {
      return {
        tasks: [],
        sagaExists: false,
        isSaga: false,
        memberEpicIds: [],
        memberResolutions: new Map(),
      };
    }
    // T10331 (Saga T10326 W2.B): dual-shape saga detection — accept both the
    // canonical `type='saga'` row and the legacy label-encoded epic until
    // W3.C T10334 drops the old clause.
    if (!isSagaShape(saga)) {
      return {
        tasks: [],
        sagaExists: true,
        isSaga: false,
        memberEpicIds: [],
        memberResolutions: new Map(),
      };
    }
    // Walk groups relations. `loadSingleTask` hydrates `relates[]` from
    // `task_relations` so we don't need a separate query.
    const seen = new Set<string>();
    const memberEpicIds: string[] = [];
    for (const relation of saga.relates ?? []) {
      if (relation.type !== SAGA_GROUPS_RELATION) continue;
      if (seen.has(relation.taskId)) continue;
      seen.add(relation.taskId);
      memberEpicIds.push(relation.taskId);
    }

    // Aggregate each member's task subtree. Leaf-Epic members contribute the
    // Epic itself so evidence atoms remain reachable.
    const aggregated: Task[] = [];
    const memberResolutions = new Map<string, EpicResolution>();
    const seenTaskIds = new Set<string>();
    for (const memberId of memberEpicIds) {
      const resolution = await resolveEpicTasksWithAccessor(memberId, accessor);
      memberResolutions.set(memberId, resolution);
      if (!resolution.epicExists) continue;
      if (resolution.isLeafEpic && resolution.epic) {
        if (!seenTaskIds.has(resolution.epic.id)) {
          seenTaskIds.add(resolution.epic.id);
          aggregated.push(resolution.epic);
        }
        continue;
      }
      for (const t of resolution.tasks) {
        if (seenTaskIds.has(t.id)) continue;
        seenTaskIds.add(t.id);
        aggregated.push(t);
      }
    }
    return {
      tasks: aggregated,
      sagaExists: true,
      isSaga: true,
      memberEpicIds,
      memberResolutions,
    };
  } finally {
    await accessor.close();
  }
}

/**
 * Resolve an explicit `--tasks` scope into task rows, preserving caller order
 * after de-duplication and rejecting cancelled/archived rows.
 *
 * @internal
 * @task T10088
 */
async function resolveExplicitTasks(
  taskIds: string[],
  projectRoot: string,
): Promise<{ tasks: Task[]; missing: string[]; excluded: string[] }> {
  const accessor = await getTaskAccessor(projectRoot);
  try {
    const tasks: Task[] = [];
    const missing: string[] = [];
    const excluded: string[] = [];
    const seen = new Set<string>();
    for (const rawId of taskIds) {
      const taskId = rawId.trim();
      if (!taskId || seen.has(taskId)) continue;
      seen.add(taskId);
      const task = await accessor.loadSingleTask(taskId);
      if (!task) {
        missing.push(taskId);
        continue;
      }
      if (task.status === 'cancelled' || task.status === 'archived') {
        excluded.push(taskId);
        continue;
      }
      tasks.push(task);
    }
    return { tasks, missing, excluded };
  } finally {
    await accessor.close();
  }
}

/**
 * Variant of {@link resolveEpicTasks} that accepts a pre-opened accessor —
 * used by {@link resolveSagaTasks} to avoid opening one accessor per member
 * Epic. Mirrors `resolveEpicTasks` semantics exactly.
 *
 * @internal
 * @task T9838
 */
async function resolveEpicTasksWithAccessor(
  epicId: string,
  accessor: Awaited<ReturnType<typeof getTaskAccessor>>,
): Promise<EpicResolution> {
  const epic = await accessor.loadSingleTask(epicId);
  if (!epic) {
    return { tasks: [], epicExists: false, epic: null, isLeafEpic: false };
  }
  const subtree = await accessor.getSubtree(epicId);
  const filtered = subtree.filter((t) => {
    if (t.id === epicId) return false;
    if (t.status === 'cancelled') return false;
    if (t.status === 'archived') return false;
    return true;
  });
  return {
    tasks: filtered,
    epicExists: true,
    epic,
    isLeafEpic: filtered.length === 0,
  };
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
    case 'pr':
      return `pr:${atom.prNumber}`;
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
    .where(eq(releases.channel, channel))
    .orderBy(desc(releases.publishedAt), desc(releases.reconciledAt), desc(releases.createdAt))
    .all();
  const shippedStatuses = new Set(['reconciled', 'published', 'pushed', 'tagged']);
  const tagSet = listGitTags(projectRoot);
  const shipped = rows.filter((row) => {
    if (!shippedStatuses.has(row.status)) return false;
    return tagSet === null || tagSet.has(row.version);
  });
  shipped.sort(compareReleaseRowsNewestFirst);
  const prior = shipped[0];
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
    previousShippedAt: prior.publishedAt ?? prior.reconciledAt ?? null,
    firstEverRelease: false,
  };
}

/** Best-effort git tag inventory used to avoid treating untagged rows as shipped. */
function listGitTags(projectRoot: string): Set<string> | null {
  try {
    const raw = runGitWithLockRetry(['tag', '--list'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 60_000,
    });
    return new Set(
      raw
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } catch (err: unknown) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'git tag --list failed during previous-version resolution; falling back to DB status only',
    );
    return null;
  }
}

function compareReleaseRowsNewestFirst(a: ReleaseRow, b: ReleaseRow): number {
  const byVersion = compareVersionStrings(b.version, a.version);
  if (byVersion !== 0) return byVersion;
  const aTime = Date.parse(a.publishedAt ?? a.reconciledAt ?? a.createdAt ?? '') || 0;
  const bTime = Date.parse(b.publishedAt ?? b.reconciledAt ?? b.createdAt ?? '') || 0;
  return bTime - aTime;
}

function compareVersionStrings(a: string, b: string): number {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  const max = Math.max(pa.length, pb.length);
  for (let i = 0; i < max; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

function parseVersionParts(version: string): number[] {
  const match = version.match(/v?(\d+(?:\.\d+){1,3})/);
  if (!match) return [];
  return match[1]!.split('.').map((part) => Number.parseInt(part, 10));
}

// ---------------------------------------------------------------------------
// Helpers — plan file IO + DB upsert
// ---------------------------------------------------------------------------

/**
 * Atomic write to `.cleo/release/<resolved-version>.plan.json` (R-030).
 *
 * Registered as a system-managed writer (T10368) — see
 * `WriterRegistry.listSystemManaged()` entry `release.plan-json`. Emits a
 * routing log line when `CLEO_QUIET` is unset so downstream auditors can
 * confirm the bypass was registered (vs an undocumented `writeFileSync`).
 *
 * @internal
 * @task T9525, T10368
 */
function writePlanFile(plan: ReleasePlan, projectRoot: string): string {
  const releaseDir = join(getCleoDirAbsolute(projectRoot), 'release');
  mkdirSync(releaseDir, { recursive: true });
  const finalPath = join(releaseDir, `${plan.resolvedVersion}.plan.json`);
  const tmpPath = `${finalPath}.tmp`;
  const body = `${JSON.stringify(plan, null, 2)}\n`;
  writeFileSync(tmpPath, body, { encoding: 'utf-8' });
  renameSync(tmpPath, finalPath);

  // T10368: surface the system-managed routing — the lint gate verifies this
  // callsite is registered. Quiet mode suppresses the log for CI/scripted
  // runs where it would clutter stdout.
  if (process.env['CLEO_QUIET'] !== '1') {
    const entry = WriterRegistry.findSystemManagedById('release.plan-json');
    if (entry !== null) {
      log.debug(
        { path: finalPath, registryEntry: entry.id, adr: entry.adrRef },
        'system-managed writer (T10368)',
      );
    }
  }

  return finalPath;
}

// ---------------------------------------------------------------------------
// Helpers — CHANGELOG.md auto-write (T9838 gap 3)
// ---------------------------------------------------------------------------

/**
 * Default header for a brand-new CHANGELOG.md created by `cleo release plan`.
 *
 * @internal
 * @task T9838
 */
const DEFAULT_CHANGELOG_HEADER = '# Changelog\n\nAll notable changes to this project.\n';

/**
 * Placeholder body used when `cleo release plan` runs with zero parsed
 * changeset entries. Per T10105 AC3 the section MUST still be written so the
 * `## [<version>] (<date>)` header is never absent. Operators can fill in
 * the body manually (or add a changeset and re-run).
 *
 * @internal
 * @task T10105
 * @epic E-RELEASE-PLAN-CHANGELOG
 */
const EMPTY_CHANGELOG_PLACEHOLDER =
  '_No changeset entries parsed for this release._\n\n' +
  '_Add entries under `.changeset/*.md` and re-run `cleo release plan` to populate this section._\n';

/**
 * Idempotently write (or replace) the `## [<version>] (<date>)` section in
 * `CHANGELOG.md` with the rendered release notes from
 * {@link aggregateChangesetsForRelease}.
 *
 * Semantics:
 *  - If `CHANGELOG.md` already contains a `## [<version>] (...)` header, the
 *    block up to the next `## [` heading (or end of file) is replaced in
 *    place. Re-running `cleo release plan v<ver>` is therefore a no-op when
 *    the aggregated notes haven't changed.
 *  - Otherwise the new section is inserted as the FIRST `## [<version>]`
 *    block — right after the document title `# ...` if present, else at the
 *    very top.
 *  - When the file doesn't exist, a minimal `# Changelog\n\n` header is
 *    seeded before the new section.
 *  - Writes are atomic (`atomicWrite` → tmp-then-rename).
 *
 * Returns the absolute path to the file and a `written` flag that is `false`
 * iff the resulting contents matched what was already on disk (no-op case).
 *
 * @internal
 * @task T9838
 */
async function writeChangelogSection(args: {
  changelogPath: string;
  version: string;
  date: string;
  notesMarkdown: string;
}): Promise<{ changelogPath: string; written: boolean }> {
  const { changelogPath, version, date, notesMarkdown } = args;

  let existing = '';
  if (existsSync(changelogPath)) {
    try {
      existing = readFileSync(changelogPath, 'utf-8');
    } catch (err: unknown) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), changelogPath },
        'failed to read CHANGELOG.md — proceeding with empty existing content',
      );
      existing = '';
    }
  }

  // The aggregator-emitted markdown already opens with its own
  // `## <version> — <date>` heading (see changesets-aggregator.ts). To stay
  // idempotent on re-run AND not double-stack headers, wrap that body with a
  // canonical `## [<version>] (<date>)` heading FIRST and then strip the
  // aggregator's own heading line — preserving its `### Features / ### Fixes`
  // sub-headers and bullet content. The canonical bracketed header is what
  // downstream verbs (open, reconcile) and CI grep for.
  const trimmedNotes = stripAggregatorVersionHeader(notesMarkdown, version).trimEnd();
  // ADR-028 §2.5: canonical CHANGELOG header is `## [VERSION] (YYYY-MM-DD)` with
  // NO `v` prefix on the version. The plan flow passes `v<version>` for git-tag
  // purposes; normalize for the header.
  const versionForHeader = version.startsWith('v') ? version.slice(1) : version;
  const sectionHeader = `## [${versionForHeader}] (${date})`;
  const sectionBody = `${sectionHeader}\n\n${trimmedNotes}\n`;

  // Search/replace uses the same `## [VERSION] (...)` header shape per ADR-028,
  // so the regex must look for the v-less form. Pass the normalized version.
  const updated = replaceOrInsertChangelogSection(existing, versionForHeader, sectionBody);
  if (updated === existing) {
    return { changelogPath, written: false };
  }

  await atomicWrite(changelogPath, updated);

  // T10368: surface the system-managed routing — `CHANGELOG.md` is the
  // canonical release-notes mirror and the writer is registered under
  // `release.changelog`. Quiet mode suppresses the log for scripted runs.
  if (process.env['CLEO_QUIET'] !== '1') {
    const entry = WriterRegistry.findSystemManagedById('release.changelog');
    if (entry !== null) {
      log.debug(
        { path: changelogPath, registryEntry: entry.id, adr: entry.adrRef },
        'system-managed writer (T10368)',
      );
    }
  }

  return { changelogPath, written: true };
}

/**
 * Strip the aggregator's leading `## <version> — <date>` heading line so the
 * canonical bracketed header inserted by {@link writeChangelogSection} is the
 * ONLY top-level section heading for this version. Preserves all sub-headers
 * (`### Features`, `### Fixes`, etc.) and bullet content verbatim.
 *
 * @internal
 * @task T9838
 */
function stripAggregatorVersionHeader(notesMarkdown: string, version: string): string {
  const escaped = escapeChangelogRegex(version);
  // Match leading `## <version>` (with optional ` — <anything>` suffix) at
  // the start of the markdown, plus its trailing newline. Whitespace-only
  // leading lines are tolerated.
  const re = new RegExp(`^\\s*## ${escaped}[^\\n]*\\n+`, '');
  return notesMarkdown.replace(re, '');
}

/**
 * Pure-string transform used by {@link writeChangelogSection}. Extracted so
 * it can be exercised in isolation by the test suite.
 *
 * @internal
 * @task T9838
 */
function replaceOrInsertChangelogSection(
  existing: string,
  version: string,
  newSection: string,
): string {
  // Normalize newSection so it ends with a single trailing newline AND a
  // blank line separating it from the next sibling section. This produces
  // identical output regardless of whether we hit the insert or replace
  // branch — required for idempotent re-runs (T9838).
  let normalizedSection = newSection.endsWith('\n') ? newSection : `${newSection}\n`;
  if (!normalizedSection.endsWith('\n\n')) {
    normalizedSection = `${normalizedSection}\n`;
  }

  // Seed a minimal header when the file is empty / missing.
  const baseline = existing.trim().length === 0 ? DEFAULT_CHANGELOG_HEADER : existing;

  const escapedVersion = escapeChangelogRegex(version);
  // Match `## [<ver>]` at the start of a line, with optional `(date)` suffix.
  const sectionStartRe = new RegExp(`^## \\[${escapedVersion}\\][^\\n]*\\n`, 'm');
  const startMatch = sectionStartRe.exec(baseline);

  if (startMatch) {
    // Replace existing section: from header up to next `## ` heading OR EOF.
    // We preserve everything BEFORE the section header and everything AT or
    // AFTER the next `## ` heading. If there is no next `## ` heading, the
    // section continues to EOF and is fully replaced.
    const startIdx = startMatch.index;
    const fromHeader = baseline.slice(startIdx);
    const afterHeader = fromHeader.slice(startMatch[0].length);
    const nextHeaderRe = /^## /m;
    const nextMatch = nextHeaderRe.exec(afterHeader);
    const before = baseline.slice(0, startIdx);
    if (nextMatch) {
      const after = afterHeader.slice(nextMatch.index);
      return `${before}${normalizedSection}${after}`;
    }
    // No next section — section ran to EOF; replace with the normalized form.
    return `${before}${normalizedSection}`;
  }

  // Insert as FIRST `## [` block. Canonical placement: right BEFORE the
  // existing first `## ` heading (if any), so descriptive baseline content
  // between the title and the first version section is preserved. If there
  // is no `## ` heading yet, append at the end of the baseline.
  const firstHeadingRe = /^## /m;
  const firstHeadingMatch = firstHeadingRe.exec(baseline);
  if (firstHeadingMatch) {
    const before = baseline.slice(0, firstHeadingMatch.index);
    const after = baseline.slice(firstHeadingMatch.index);
    // Ensure exactly one blank line separates baseline text from our section.
    const beforeTrimmed = before.replace(/\n+$/, '\n');
    return `${beforeTrimmed}\n${normalizedSection}${after}`;
  }

  // No `## ` heading yet — append our new section at the end. Ensure a
  // blank-line separator between baseline content and the new section.
  const baselineTrimmed = baseline.replace(/\n+$/, '\n');
  return `${baselineTrimmed}\n${normalizedSection}`;
}

/**
 * Escape a version string for use in a RegExp source. Versions contain `.`
 * which is a regex metacharacter and `[`/`]` which must be escaped inside
 * character class brackets in the surrounding template.
 *
 * @internal
 * @task T9838
 */
function escapeChangelogRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
// Helpers — CLEO-native changesets (T9753)
// ---------------------------------------------------------------------------

/**
 * Read parsed changeset entries from `<projectRoot>/.changeset/`.
 *
 * Returns an empty array when the directory is missing OR when the directory
 * has no `.md` files apart from `README.md`. Parse failures are NO LONGER
 * silently swallowed — {@link ChangesetYamlInvalidError} propagates so that
 * `cleo release plan` aborts with `E_CHANGESET_YAML_INVALID` and the
 * offending `file:line` is surfaced to the operator (T10105).
 *
 * @internal
 * @task T10105
 * @epic E-RELEASE-PLAN-CHANGELOG
 */
function readChangesetEntries(projectRoot: string): ChangesetEntry[] {
  const changesetDir = join(projectRoot, '.changeset');
  if (!existsSync(changesetDir)) {
    return [];
  }
  // T10105: deliberately NO try/catch. ChangesetYamlInvalidError propagates
  // to releasePlan() which converts it into an EngineResult error envelope
  // with code=E_CHANGESET_YAML_INVALID. The pre-T10105 silent-skip caused
  // the v2026.5.100 ship to drop v5.100/v5.101/v5.103 CHANGELOG entries.
  return parseChangesetDir(changesetDir);
}

/** Keep only changesets that belong to the release's planned task scope. */
function filterChangesetsForPlanTasks(
  entries: readonly ChangesetEntry[],
  planTasks: readonly ReleasePlanTask[],
): ChangesetEntry[] {
  const taskIds = new Set(planTasks.map((task) => task.id));
  return entries.filter((entry) => entry.tasks.some((taskId) => taskIds.has(taskId)));
}

/**
 * Persist each parsed changeset entry into the `release_changesets` table.
 *
 * Idempotent re-runs of `cleo release plan` clear any prior rows for the same
 * `release_id` before re-inserting so the row set is always in sync with the
 * `.changeset/` directory state at plan time.
 *
 * @internal
 * @task T9753
 */
async function persistReleaseChangesets(
  releaseId: string,
  entries: readonly ChangesetEntry[],
  projectRoot: string,
): Promise<void> {
  const db = await getDb(projectRoot);
  // Clear prior rows so a re-run is a clean overwrite, not an append.
  await db.delete(releaseChangesets).where(eq(releaseChangesets.releaseId, releaseId)).run();
  if (entries.length === 0) return;
  const rows: NewReleaseChangesetRow[] = entries.map((entry) => ({
    releaseId,
    changesetId: entry.id,
    taskIds: JSON.stringify(entry.tasks),
    kind: entry.kind,
    summary: entry.summary,
    prs: entry.prs && entry.prs.length > 0 ? JSON.stringify(entry.prs) : null,
    notes: entry.notes ?? null,
    breaking: entry.breaking ?? null,
  }));
  await db.insert(releaseChangesets).values(rows).run();
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
  // T9838: default ON — `cleo release plan` closes the manual-CHANGELOG loop.
  const writeChangelog = opts.writeChangelog !== false;

  // ── R-020: clean-tree gate ────────────────────────────────────────────
  // T9838: when `writeChangelog=true` the plan verb writes CHANGELOG.md
  // itself. Re-runs therefore SHOULD ignore CHANGELOG.md dirty state — it's
  // the plan's own prior output, not a stale manual edit. Any other dirty
  // version file still blocks the run.
  const { dirty } = validateCleanTree(projectRoot);
  const blockingDirty = writeChangelog
    ? dirty.filter((p) => !PLAN_WRITTEN_FILE_PATTERNS.includes(p))
    : dirty;
  if (blockingDirty.length > 0) {
    return engineError<ReleasePlanResult>(
      E_DIRTY_TREE,
      `Working tree has uncommitted changes in version files: ${blockingDirty.join(', ')}`,
      {
        exitCode: ExitCode.INVALID_PARENT_TYPE, // 13 per SPEC §4.7
        fix: 'git status; commit or stash the listed paths before re-running',
        details: { dirtyPaths: blockingDirty },
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

  // ── T9838/T10088: --saga / --epic / --tasks input validation ─────────
  // The three scope selectors are mutually exclusive. At least one MUST be set.
  const scopeCount = [opts.sagaId, opts.epicId, opts.taskIds?.length ? 'tasks' : undefined].filter(
    Boolean,
  ).length;
  if (scopeCount > 1) {
    return engineError<ReleasePlanResult>(
      'E_INVALID_INPUT',
      '--saga, --epic, and --tasks are mutually exclusive — pass exactly one scope selector',
      {
        exitCode: ExitCode.VALIDATION_ERROR,
        fix: 'pass --epic T####, --saga T####, or --tasks T####,T####',
        details: { sagaId: opts.sagaId, epicId: opts.epicId, taskIds: opts.taskIds },
      },
    );
  }
  if (scopeCount === 0) {
    return engineError<ReleasePlanResult>(
      'E_INVALID_INPUT',
      '--saga, --epic, or --tasks is required',
      {
        exitCode: ExitCode.VALIDATION_ERROR,
        fix: 'pass --epic T#### (single Epic), --saga T#### (Saga walks groups relation), or --tasks T####,T####',
      },
    );
  }

  // ── R-021 / T9838: resolve tasks for the plan ────────────────────────
  // Four code paths:
  //   (a) `--tasks T####,T####` plans exactly those eligible tasks in caller order.
  //   (b) `--saga T####` walks task_relations.relation_type='groups' and
  //       aggregates the member Epics' subtrees (or leaf-Epics themselves).
  //   (c) `--epic T####` with non-cancelled children → existing semantics.
  //   (d) `--epic T####` leaf-Epic (zero children) → singleton task list with
  //       the Epic's own evidence atoms (ADR-073 leaf-Epic-as-PR pattern).
  let tasks: Task[];
  let resolvedEpicId: string; // The ID that goes into `plan.epicId`
  let leafEpicMode = false; // True when path (c) is taken
  if (opts.taskIds?.length) {
    const taskRes = await resolveExplicitTasks(opts.taskIds, projectRoot);
    if (taskRes.missing.length > 0) {
      return engineError<ReleasePlanResult>(
        'E_NOT_FOUND',
        'One or more --tasks IDs were not found',
        {
          exitCode: ExitCode.NOT_FOUND,
          fix: `cleo exists ${taskRes.missing[0]}`,
          details: { missing: taskRes.missing },
        },
      );
    }
    if (taskRes.tasks.length === 0) {
      return engineError<ReleasePlanResult>(
        E_EPIC_EMPTY,
        '--tasks resolved to zero eligible tasks',
        {
          exitCode: ExitCode.NOT_FOUND,
          fix: 'pass at least one non-cancelled, non-archived task ID',
          details: { taskIds: opts.taskIds, excluded: taskRes.excluded },
        },
      );
    }
    tasks = taskRes.tasks;
    resolvedEpicId = taskRes.tasks[0]?.parentId ?? taskRes.tasks[0]?.id ?? 'explicit-tasks';
  } else if (opts.sagaId) {
    const sagaRes = await resolveSagaTasks(opts.sagaId, projectRoot);
    if (!sagaRes.sagaExists) {
      return engineError<ReleasePlanResult>(
        'E_NOT_FOUND',
        `Saga ${opts.sagaId} not found in tasks.db`,
        {
          exitCode: ExitCode.NOT_FOUND,
          fix: `cleo exists ${opts.sagaId} or cleo saga list`,
          details: { sagaId: opts.sagaId },
        },
      );
    }
    if (!sagaRes.isSaga) {
      return engineError<ReleasePlanResult>(
        'E_INVALID_INPUT',
        `Task ${opts.sagaId} exists but is not a Saga (missing label='saga')`,
        {
          exitCode: ExitCode.VALIDATION_ERROR,
          fix: `Pass --epic ${opts.sagaId} if this is an Epic, or label the task with 'saga'`,
          details: { sagaId: opts.sagaId },
        },
      );
    }
    if (sagaRes.memberEpicIds.length === 0 || sagaRes.tasks.length === 0) {
      return engineError<ReleasePlanResult>(
        E_EPIC_EMPTY,
        `Saga ${opts.sagaId} has no eligible member epics (relation_type='groups')`,
        {
          exitCode: ExitCode.NOT_FOUND,
          fix: `cleo saga members ${opts.sagaId}; cleo saga add ${opts.sagaId} <epicId>`,
          details: {
            sagaId: opts.sagaId,
            memberEpicIds: sagaRes.memberEpicIds,
          },
        },
      );
    }
    tasks = sagaRes.tasks;
    resolvedEpicId = opts.sagaId;
  } else {
    // opts.epicId is guaranteed non-null by the input-validation block above.
    const epicId = opts.epicId as string;
    const epicRes = await resolveEpicTasks(epicId, projectRoot);
    if (!epicRes.epicExists) {
      return engineError<ReleasePlanResult>(
        E_EPIC_NOT_FOUND,
        `Epic ${epicId} not found in tasks.db`,
        {
          exitCode: ExitCode.PARENT_NOT_FOUND,
          fix: `cleo exists ${epicId}`,
          details: { epicId },
        },
      );
    }
    if (epicRes.isLeafEpic) {
      // T9838 Fix 2: leaf-Epic-as-Task (ADR-073). Treat the Epic itself as the
      // singleton task list. Evidence atoms come from the Epic's own
      // `verification.evidence` blob. If the Epic has zero atoms, surface
      // E_EPIC_EMPTY_LEAF_NO_EVIDENCE (still need to verify something shipped).
      if (!epicRes.epic) {
        // Defensive — `isLeafEpic` implies `epicExists`, which implies `epic`.
        return engineError<ReleasePlanResult>(
          E_EPIC_NOT_FOUND,
          `Epic ${epicId} not found in tasks.db`,
          {
            exitCode: ExitCode.PARENT_NOT_FOUND,
            fix: `cleo exists ${epicId}`,
            details: { epicId },
          },
        );
      }
      const epicAtoms = collectEvidenceAtomsForTask(epicRes.epic);
      if (epicAtoms.length === 0) {
        return engineError<ReleasePlanResult>(
          E_EPIC_EMPTY_LEAF_NO_EVIDENCE,
          `Leaf Epic ${epicId} has zero child tasks AND zero evidence atoms — ` +
            `nothing to ship.`,
          {
            exitCode: ExitCode.LIFECYCLE_TRANSITION_INVALID,
            fix:
              `cleo verify ${epicId} --gate implemented --evidence ` +
              '"commit:<sha>;files:<paths>" (or pr:<num>;state:MERGED post-merge)',
            details: { epicId, leafEpic: true },
          },
        );
      }
      tasks = [epicRes.epic];
      leafEpicMode = true;
    } else {
      tasks = epicRes.tasks;
    }
    resolvedEpicId = epicId;
  }

  // ── R-301 / R-310: evidence-atom completeness ─────────────────────────
  const planTasks: ReleasePlanTask[] = tasks.map((t) => taskToPlanTask(t, resolvedEpicId));
  const tasksMissingEvidence = planTasks.filter((t) => t.evidenceAtoms.length === 0);
  const evidenceComplete = tasksMissingEvidence.length === 0;
  if (!evidenceComplete) {
    // Leaf-Epic mode already enforced evidence above — only reachable for the
    // multi-task subtree paths.
    return engineError<ReleasePlanResult>(
      E_EVIDENCE_INSUFFICIENT,
      `${tasksMissingEvidence.length} task(s) in ${
        opts.sagaId ? `saga ${opts.sagaId}` : `epic ${resolvedEpicId}`
      } are missing required evidence atoms`,
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

  // ── T10105: CLEO-native changesets — read + aggregate (fail-loud) ─────
  // Reads `.changeset/*.md` and aggregates into a CHANGELOG markdown section
  // embedded under `meta.releaseNotes`. Per T10105 (Saga T10099), a YAML
  // parse failure on ANY entry now aborts the plan with
  // E_CHANGESET_YAML_INVALID — the pre-T10105 silent-skip caused the
  // v2026.5.100 ship to drop v5.100/v5.101/v5.103 CHANGELOG entries.
  let changesetEntries: ChangesetEntry[];
  try {
    changesetEntries = readChangesetEntries(projectRoot);
  } catch (err: unknown) {
    if (err instanceof ChangesetYamlInvalidError) {
      return engineError<ReleasePlanResult>(E_CHANGESET_YAML_INVALID, err.message, {
        exitCode: ExitCode.VALIDATION_ERROR,
        fix: `Fix the YAML in ${err.details.file} (line ${err.details.line ?? '?'}). Common cause: an unquoted colon in 'summary:'. Wrap the value in quotes — e.g. summary: "feat(T1234): thing".`,
        details: {
          file: err.details.file,
          line: err.details.line,
          ...(err.details.snippet !== undefined ? { snippet: err.details.snippet } : {}),
          parserMessage: err.details.parserMessage,
        },
      });
    }
    // T10105: schema-violation errors (missing fields, wrong enum, etc.)
    // surface as the same code. The parser's error message already
    // includes the offending file:line and Zod issue path, so callers
    // get an actionable error envelope rather than an uncaught throw.
    const message = err instanceof Error ? err.message : String(err);
    return engineError<ReleasePlanResult>(E_CHANGESET_YAML_INVALID, message, {
      exitCode: ExitCode.VALIDATION_ERROR,
      fix: 'Run `node scripts/lint-changesets.mjs` to surface every offending entry. Common causes: missing required fields (id, tasks, kind, summary), invalid kind enum, or filename slug ≠ id.',
      details: { parserMessage: message },
    });
  }
  const scopedChangesetEntries = filterChangesetsForPlanTasks(changesetEntries, planTasks);
  const aggregated = aggregateChangesetsForRelease({
    entries: scopedChangesetEntries,
    version: normalizedVersion,
    date: createdAt.slice(0, 10),
  });

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
    epicId: resolvedEpicId,
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
      // T9753: aggregated CHANGELOG markdown from `.changeset/*.md` entries.
      // Empty string when no entries — caller (changelog writer) can branch on
      // length to decide whether to append a section.
      releaseNotes: aggregated.markdown,
      changesetEntryCount: aggregated.entryCount,
      changesetIds: scopedChangesetEntries.map((entry) => entry.id),
      // T9838: track input mode for downstream verbs (open, reconcile).
      ...(opts.sagaId ? { sagaId: opts.sagaId } : {}),
      ...(opts.taskIds?.length
        ? { taskIds: [...new Set(opts.taskIds.map((id) => id.trim()).filter(Boolean))] }
        : {}),
      ...(leafEpicMode ? { leafEpicMode: true } : {}),
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
  const changelogPath = join(projectRoot, 'CHANGELOG.md');
  let changelogWritten = false;
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
    // T9753: persist parsed changeset entries linked to the release row.
    // Runs AFTER the releases UPSERT so the FK is satisfied. Errors here are
    // logged but non-fatal — the plan file itself is the canonical source of
    // truth; release_changesets is the structured side-table.
    const projectInfo = getProjectInfoSync(projectRoot);
    const releaseId = `${projectInfo?.projectHash ?? 'unknown'}:${plan.resolvedVersion}`;
    try {
      await persistReleaseChangesets(releaseId, scopedChangesetEntries, projectRoot);
    } catch (err: unknown) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), releaseId },
        'persistReleaseChangesets failed — plan envelope still written',
      );
    }
    // ── T10105: ALWAYS write the CHANGELOG.md section ───────────────────
    // Per Saga T10099 AC2: `cleo release plan` MUST always write the
    // `## [<version>] (<date>)` section. When the aggregator emits no
    // content (zero parsed entries), insert a placeholder body + emit a
    // WARN-level log. The pre-T10105 conditional skip (only-write-if-non-empty)
    // is what caused the v2026.5.100 ship to silently elide CHANGELOG
    // sections for v5.100/v5.101/v5.103. Failure is logged but NEVER
    // blocks the plan — the plan envelope remains the canonical sink.
    if (writeChangelog) {
      const notesMarkdown =
        aggregated.markdown.trim().length > 0 ? aggregated.markdown : EMPTY_CHANGELOG_PLACEHOLDER;
      if (aggregated.markdown.trim().length === 0) {
        log.warn(
          {
            changelogPath,
            version: normalizedVersion,
            changesetEntryCount: aggregated.entryCount,
          },
          'No changeset entries parsed for this release — writing placeholder CHANGELOG section (T10105)',
        );
      }
      try {
        const result = await writeChangelogSection({
          changelogPath,
          version: normalizedVersion,
          date: createdAt.slice(0, 10),
          notesMarkdown,
        });
        changelogWritten = result.written;
      } catch (err: unknown) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), changelogPath },
          'writeChangelogSection failed — plan envelope still written, CHANGELOG.md skipped',
        );
      }
    }
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
    epicId: resolvedEpicId,
    planPath,
    taskCount: planTasks.length,
    evidenceComplete,
    preflightWarnings: preflightSummary.preflightWarnings ?? [],
    gateSummary,
    changesetEntryCount: aggregated.entryCount,
    changelogWritten,
    changelogPath,
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
  replaceOrInsertChangelogSection,
  resolveEpicTasks,
  resolveGatesViaToolResolver,
  resolvePreviousVersion,
  resolveSagaTasks,
  serializeAtom,
  validateChannelScheme,
  validateCleanTree,
  writeChangelogSection,
  writePlanFile,
};
