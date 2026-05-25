/**
 * Lead-tier wave roll-up — aggregates Worker status across a single wave of
 * an epic, producing a unified contract for the top-level Orchestrator.
 *
 * Reads from two sources:
 *   1. `pipeline_manifest` table — worker self-reports (manifest entries
 *      linked to tasks in the wave).
 *   2. Task verification rows — gate state and evidence atoms.
 *
 * Conduit topic subscription (epic-<TID>.wave-<n>) is supported via the
 * optional `conduitMessages` parameter — callers (e.g. `cleo orchestrate
 * roll-up`, the ct-lead skill) can drain the topic and pass collected
 * messages so the rollup is conduit-aware. The function does NOT subscribe
 * to topics directly: that is the Lead's responsibility, not core's.
 *
 * # Mode resolution (T10513 — council action #9)
 *
 * The Lead↔Worker Max-N loop scaffolded by E-VALIDATOR-ROLE (T10383) is
 * gated behind the `leadRollup.mode` config key, NOT a function parameter.
 * Public function signatures stay identical so existing callers never need
 * to change. Internally each rollup invocation calls
 * {@link resolveLeadRollupMode} to look up the operative mode from the
 * `.cleo/config.json` cascade (default: `'passive'`).
 *
 * - `'passive'` — Legacy behaviour. The roll-up contract is unchanged.
 * - `'active'`  — Reserved for the Lead↔Worker Max-N runtime shipping under
 *   T10512. Until that runtime lands, the active branch logs a debug marker
 *   and falls through to passive — so flipping the flag NEVER breaks an
 *   existing project.
 * - `'auto'`    — Treated as `'passive'` until the heuristic ships.
 *
 * @task T9082
 * @task T10513
 * @saga T10377
 * @adr ADR-070
 */

import type {
  EpicRollup,
  LeadRollupMode,
  RollupBlocker,
  RollupEvidenceAtom,
  RollupWorker,
  VerificationGate,
  WaveRollup,
} from '@cleocode/contracts';
import { getConfigValue } from '../config/registry.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { computeWaves } from './waves.js';

/**
 * Optional conduit message used to enrich the rollup with live status
 * events that may not yet be reflected in the manifest table.
 */
export interface ConduitStatusMessage {
  /** Task ID the event refers to. */
  taskId: string;
  /** Free-form status payload — typically `complete | partial | blocked`. */
  status: string;
  /** ISO timestamp the event was published. */
  publishedAt: string;
}

/** Options for `rollupWaveStatus`. */
export interface RollupWaveStatusOptions {
  /**
   * Optional pre-collected conduit messages from epic-<TID>.wave-<n>. The
   * caller (Lead) is expected to drain its subscription and pass messages
   * here. When omitted, rollup is computed from manifest + verification
   * only.
   */
  conduitMessages?: ConduitStatusMessage[];
}

/**
 * Resolve the operative `leadRollup.mode` from the `.cleo/config.json` cascade.
 *
 * Resolution rules:
 * 1. Look up `leadRollup.mode` via the SSoT config registry's `getConfigValue`
 *    helper (T9878). Project config (precedence 20) wins over global (10).
 * 2. When the key is absent, return the contract default `'passive'`.
 * 3. When the key is present but malformed (not one of the three valid
 *    `LeadRollupMode` values), fall back to `'passive'` rather than throwing —
 *    a typo'd config MUST NEVER break an existing caller's rollup call.
 *
 * Failures from the registry IO (e.g. unreadable config file) are caught and
 * downgraded to `'passive'` for the same reason.
 *
 * @param projectRoot - Project root to read the cascade from. Defaults to
 *   `process.cwd()` to match the rest of the lead-rollup module's behaviour
 *   when callers omit the argument.
 * @returns The resolved `LeadRollupMode` — guaranteed to be one of the three
 *   valid values, never `undefined`.
 *
 * @task T10513
 */
export async function resolveLeadRollupMode(projectRoot?: string): Promise<LeadRollupMode> {
  const root = projectRoot ?? process.cwd();
  let resolved: unknown;
  try {
    resolved = await getConfigValue('leadRollup.mode', { projectRoot: root, scope: 'merged' });
  } catch {
    // Unreadable config file — preserve legacy behaviour.
    return 'passive';
  }
  if (resolved === 'active' || resolved === 'auto' || resolved === 'passive') {
    return resolved;
  }
  return 'passive';
}

/**
 * Compute a roll-up for a single wave of an epic.
 *
 * @param epicId - Parent epic ID.
 * @param waveId - Wave number (0 = first wave). Must match `cleo deps waves`
 *   output.
 * @param projectRoot - Optional project root for SDK consumers (test fixtures
 *   pass an explicit root; CLI consumers omit it). Also used to resolve the
 *   `leadRollup.mode` feature flag from the project config cascade.
 * @param options - Optional inputs (conduit messages).
 * @returns A `WaveRollup` shape. Returns an empty wave (`workers: []`) when
 *   the wave has no tasks.
 */
export async function rollupWaveStatus(
  epicId: string,
  waveId: number,
  projectRoot?: string,
  options: RollupWaveStatusOptions = {},
): Promise<WaveRollup> {
  const mode = await resolveLeadRollupMode(projectRoot);
  const accessor = await getTaskAccessor(projectRoot);

  // Load the epic and its children.
  const epic = await accessor.loadSingleTask(epicId);
  if (!epic) {
    return {
      epicId,
      waveId,
      workers: [],
      blockers: [
        {
          taskId: epicId,
          reason: 'manifest-missing',
          detail: `Epic ${epicId} not found`,
        },
      ],
      readyToAdvance: false,
      capturedAt: new Date().toISOString(),
    };
  }
  const children = await accessor.getChildren(epicId);

  // Compute wave structure for this epic. computeWaves expects all child tasks
  // and groups them by dependency depth.
  const waves = computeWaves(children);
  const wave = waves[waveId];
  if (!wave) {
    return {
      epicId,
      waveId,
      workers: [],
      blockers: [],
      readyToAdvance: true,
      capturedAt: new Date().toISOString(),
    };
  }

  // computeWaves returns Wave.tasks as string[] (task IDs). We need a lookup
  // map from id -> Task to access verification, title, status, etc.
  const childById = new Map(children.map((c) => [c.id, c]));

  // Pull the latest manifest entry for each task in the wave.
  const taskIds = wave.tasks;
  const manifestEntriesByTask = await loadLatestManifestPerTask(taskIds, projectRoot);

  // Build per-worker summaries.
  const workers: RollupWorker[] = [];
  const blockers: RollupBlocker[] = [];

  for (const taskId of wave.tasks) {
    const task = childById.get(taskId);
    if (!task) continue;
    const manifest = manifestEntriesByTask.get(task.id);
    const verification = task.verification;
    const gates: Partial<Record<VerificationGate, boolean | null>> = verification?.gates ?? {};
    const verificationPassed = verification?.passed ?? false;
    const evidence = collectEvidenceAtoms(verification);

    workers.push({
      taskId: task.id,
      title: task.title,
      status: task.status,
      gates,
      verificationPassed,
      evidence,
      latestManifestEntry: manifest?.id ?? null,
      latestManifestStatus: manifest?.status ?? null,
      latestManifestAt: manifest?.createdAt ?? null,
    });

    // Surface blockers for tasks that aren't done yet.
    if (!verificationPassed && task.status !== 'cancelled') {
      if (task.status === 'blocked') {
        blockers.push({
          taskId: task.id,
          reason: 'manual-block',
          detail: task.blockedBy ?? 'Task is in blocked status',
        });
      } else if (!manifest) {
        blockers.push({
          taskId: task.id,
          reason: 'manifest-missing',
          detail: 'Worker has not yet appended a manifest entry',
        });
      } else if (gates && Object.values(gates).some((v) => v === false)) {
        const failed = Object.entries(gates)
          .filter(([, v]) => v === false)
          .map(([k]) => k)
          .join(',');
        blockers.push({
          taskId: task.id,
          reason: 'gate-failure',
          detail: `Failed gates: ${failed}`,
        });
      }
    }
  }

  // Apply optional conduit-message enrichment: if a worker has a fresher
  // conduit event than its manifest entry, surface it as the latest status.
  if (options.conduitMessages?.length) {
    const conduitByTask = new Map<string, ConduitStatusMessage>();
    for (const msg of options.conduitMessages) {
      const prev = conduitByTask.get(msg.taskId);
      if (!prev || msg.publishedAt > prev.publishedAt) {
        conduitByTask.set(msg.taskId, msg);
      }
    }
    for (const worker of workers) {
      const conduit = conduitByTask.get(worker.taskId);
      if (conduit && (!worker.latestManifestAt || conduit.publishedAt > worker.latestManifestAt)) {
        worker.latestManifestStatus = conduit.status;
        worker.latestManifestAt = conduit.publishedAt;
      }
    }
  }

  const readyToAdvance = workers.length > 0 && workers.every((w) => w.verificationPassed);

  // T10513 — active-mode hook. The Lead↔Worker Max-N runtime (T10512) plugs
  // in here. Until that runtime ships we deliberately keep this a no-op so
  // flipping the flag from 'passive' → 'active' is observably safe: the
  // returned WaveRollup shape is identical.
  if (mode === 'active') {
    applyActiveModeHook(workers, blockers);
  }

  return {
    epicId,
    waveId,
    workers,
    blockers,
    readyToAdvance,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Active-mode rollup hook — reserved extension point for the Lead↔Worker
 * Max-N retry runtime (T10512).
 *
 * Today this function is intentionally a no-op. Its presence (and the
 * `mode === 'active'` call site above) is the seam T10512 will plug retry
 * signal emission into without re-touching the public function signatures —
 * the WHOLE POINT of the feature-flag refactor per council action #9.
 *
 * Kept exported-internal (module scope, not re-exported from the barrel) so
 * tests in this directory can exercise it directly.
 *
 * @task T10513
 */
function applyActiveModeHook(_workers: RollupWorker[], _blockers: RollupBlocker[]): void {
  // Intentional no-op until T10512 lands. See module-level docstring above.
}

/**
 * Roll-up every wave of an epic at once. Composes `rollupWaveStatus` per
 * wave and returns an `EpicRollup`.
 */
export async function rollupEpicStatus(
  epicId: string,
  projectRoot?: string,
  options: RollupWaveStatusOptions = {},
): Promise<EpicRollup> {
  const accessor = await getTaskAccessor(projectRoot);
  const children = await accessor.getChildren(epicId);
  const waves = computeWaves(children);

  const waveRollups: WaveRollup[] = [];
  for (let i = 0; i < waves.length; i++) {
    waveRollups.push(await rollupWaveStatus(epicId, i, projectRoot, options));
  }

  const totalWorkers = waveRollups.reduce((sum, w) => sum + w.workers.length, 0);
  const doneWorkers = waveRollups.reduce(
    (sum, w) => sum + w.workers.filter((x) => x.verificationPassed).length,
    0,
  );

  return {
    epicId,
    waves: waveRollups,
    totalWorkers,
    doneWorkers,
    capturedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

interface LatestManifestRow {
  id: string;
  taskId: string | null;
  status: string;
  createdAt: string;
}

/**
 * Pull the most recent manifest entry per task, indexed by task id.
 * Uses pipelineManifestList with a per-task filter — efficient for small
 * waves (typical 3-12 tasks per wave).
 */
async function loadLatestManifestPerTask(
  taskIds: string[],
  projectRoot?: string,
): Promise<Map<string, LatestManifestRow>> {
  const out = new Map<string, LatestManifestRow>();
  if (taskIds.length === 0) return out;

  const { pipelineManifestList } = await import('../memory/pipeline-manifest-sqlite.js');
  for (const taskId of taskIds) {
    const result = await pipelineManifestList(
      { linkedTask: taskId, limit: 1 } as Parameters<typeof pipelineManifestList>[0],
      projectRoot,
    );
    if (!result.success || !result.data) continue;
    const data = result.data as { entries?: Array<{ id: string; status?: string; date?: string }> };
    const entry = data.entries?.[0];
    if (entry) {
      out.set(taskId, {
        id: entry.id,
        taskId,
        status: entry.status ?? 'unknown',
        createdAt: entry.date ?? '',
      });
    }
  }
  return out;
}

/**
 * Flatten verification evidence into a typed atom array. Returns an empty
 * array when no evidence has been recorded yet.
 */
function collectEvidenceAtoms(
  verification: { evidence?: unknown } | null | undefined,
): RollupEvidenceAtom[] {
  if (!verification?.evidence) return [];
  const out: RollupEvidenceAtom[] = [];
  const evidenceMap = verification.evidence as Record<string, unknown>;
  for (const gateEvidence of Object.values(evidenceMap)) {
    if (!gateEvidence || typeof gateEvidence !== 'object') continue;
    const atoms = (gateEvidence as { atoms?: unknown }).atoms;
    if (!Array.isArray(atoms)) continue;
    for (const atom of atoms) {
      if (!atom || typeof atom !== 'object') continue;
      const a = atom as { kind?: string; sha?: string; tool?: string; url?: string };
      const kind = a.kind;
      if (
        kind === 'commit' ||
        kind === 'files' ||
        kind === 'tool' ||
        kind === 'test-run' ||
        kind === 'url' ||
        kind === 'note'
      ) {
        out.push({ kind, payload: JSON.stringify(atom) });
      }
    }
  }
  return out;
}
