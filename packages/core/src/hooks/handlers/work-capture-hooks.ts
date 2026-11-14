/**
 * Active-Work Capture Hook Handlers
 *
 * Captures dispatch mutation events to BRAIN during active work, closing
 * the gap between lifecycle-only capture (session end, task complete) and
 * continuous capture. Only WRITE operations that represent meaningful work
 * are captured — reads and operations already handled by lifecycle hooks
 * are skipped to avoid flooding brain.db.
 *
 * Disabled by default. Enable via:
 *   - Config: brain.captureWork = true  (checked first)
 *   - Env:    CLEO_BRAIN_CAPTURE_WORK=true  (overrides config)
 *
 * Auto-registers on module load.
 *
 * @task T142
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ObserveBrainParams } from '@cleocode/contracts';
import { getLogger } from '../../logger.js';
import { resolveCleoDir } from '../../paths.js';
import {
  createOperationExecutionContext,
  OperationExecutionError,
} from '../../store/background-ops.js';
import { isPidAlive } from '../../store/pid-alive.js';
import { LeaseUnavailableError } from '../../store/writer-lease.js';
import { hooks } from '../registry.js';
import type { HookHandlerOutcome, PromptSubmitPayload, ResponseCompletePayload } from '../types.js';
import { isMissingBrainSchemaError } from './handler-helpers.js';

/**
 * Longest one work-capture write waits for the `brain` writer lease before its
 * observation is deferred (T14553). Below {@link RESPONSE_HOOK_BUDGET_MS} so
 * the handler, not the dispatch backstop, decides; a mutation dispatches two
 * captures, so a held lease delays it by at most twice this.
 *
 * @see {@link import('../registry.js').RESPONSE_HOOK_BUDGET_MS}
 */
export const WORK_CAPTURE_WRITE_BUDGET_MS = 1_500;

/** Spool directory, beside the `cleo.db` the observations are written to. */
const SPOOL_DIR = 'brain-capture-spool';

/** Spool entries this process is writing right now; a drain leaves them alone. */
const inFlight = new Set<string>();

/** One durable spool entry: the observation exactly as it will be written. */
interface SpoolEntry {
  readonly params: ObserveBrainParams;
}

/**
 * Check whether active-work capture is enabled.
 *
 * Resolution order (first truthy wins):
 *   1. CLEO_BRAIN_CAPTURE_WORK env var (explicit override)
 *   2. brain.captureWork project config value
 *
 * Defaults to false when neither is set.
 */
async function isWorkCaptureEnabled(projectRoot: string): Promise<boolean> {
  const envOverride = process.env['CLEO_BRAIN_CAPTURE_WORK'];
  if (envOverride !== undefined) {
    return envOverride === 'true';
  }
  try {
    const { loadConfig } = await import('../../config.js');
    const config = await loadConfig(projectRoot);
    return config.brain?.captureWork ?? false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Smart-filter: which mutations to capture
// ---------------------------------------------------------------------------

/**
 * Mutations that represent novel work not already captured by lifecycle hooks.
 *
 * Excluded (already captured elsewhere):
 *   - tasks.complete  → task-hooks.ts (PostToolUse)
 *   - session.start   → session-hooks.ts (SessionStart)
 *   - session.end     → session-hooks.ts (SessionEnd)
 *   - memory.brain.observe → observeBrain itself writes to brain; self-loop
 *
 * All query gateway operations are excluded by the gateway check before
 * this set is consulted.
 */
const CAPTURE_OPERATIONS = new Set<string>([
  'tasks.add',
  'tasks.update',
  'tasks.move',
  'tasks.link',
  'tasks.unlink',
  'tasks.label',
  'tasks.unlabel',
  'tasks.note',
]);

/**
 * Determine whether a mutate operation should be captured.
 *
 * Only `mutate` gateway operations in CAPTURE_OPERATIONS are captured.
 * All `query` gateway calls are skipped (reads produce no novel work).
 *
 * @param gateway - 'query' or 'mutate'
 * @param domain  - e.g. 'tasks'
 * @param operation - e.g. 'add'
 */
function shouldCapture(gateway: string, domain: string, operation: string): boolean {
  if (gateway !== 'mutate') return false;
  const key = `${domain}.${operation}`;
  return CAPTURE_OPERATIONS.has(key);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Handle PromptSubmit — log incoming mutation intents to BRAIN.
 *
 * Only fires for mutate operations in CAPTURE_OPERATIONS.
 * Gated behind brain.captureWork config (or CLEO_BRAIN_CAPTURE_WORK env).
 *
 * @param projectRoot - Absolute path to the project root
 * @param payload     - PromptSubmit event payload
 * @returns `'deferred'` when the observation was spooled for a later write
 */
export async function handleWorkPromptSubmit(
  projectRoot: string,
  payload: PromptSubmitPayload,
): Promise<HookHandlerOutcome | undefined> {
  if (!shouldCapture(payload.gateway, payload.domain, payload.operation)) return;
  if (!(await isWorkCaptureEnabled(projectRoot))) return;

  return captureObservation(projectRoot, {
    text: `Dispatch intent: ${payload.gateway}:${payload.domain}.${payload.operation}${payload.source ? ` (from ${payload.source})` : ''}`,
    title: `Work intent: ${payload.domain}.${payload.operation}`,
    type: 'discovery',
    sourceType: 'agent',
  });
}

/**
 * Handle ResponseComplete — capture completed mutations to BRAIN.
 *
 * Only fires for successful mutate operations in CAPTURE_OPERATIONS.
 * Failures are skipped — the intent was already captured by handleWorkPromptSubmit.
 * Gated behind brain.captureWork config (or CLEO_BRAIN_CAPTURE_WORK env).
 *
 * @param projectRoot - Absolute path to the project root
 * @param payload     - ResponseComplete event payload
 * @returns `'deferred'` when the observation was spooled for a later write
 */
export async function handleWorkResponseComplete(
  projectRoot: string,
  payload: ResponseCompletePayload,
): Promise<HookHandlerOutcome | undefined> {
  if (!shouldCapture(payload.gateway, payload.domain, payload.operation)) return;
  // Only capture successful completions — failures are noise
  if (!payload.success) return;
  if (!(await isWorkCaptureEnabled(projectRoot))) return;

  const durationNote = payload.durationMs != null ? ` (${payload.durationMs}ms)` : '';
  return captureObservation(projectRoot, {
    text: `Dispatch complete: ${payload.gateway}:${payload.domain}.${payload.operation}${durationNote}`,
    title: `Work done: ${payload.domain}.${payload.operation}`,
    type: 'change',
    sourceType: 'agent',
  });
}

// ---------------------------------------------------------------------------
// Durable capture: spool first, then a deadline-bound write (T14553)
// ---------------------------------------------------------------------------

/**
 * Capture one observation without letting a held `brain` lease hold the
 * command. The entry is spooled to disk (fsync + rename) BEFORE the write, the
 * capture spends at most {@link WORK_CAPTURE_WRITE_BUDGET_MS} reaching the lease, and
 * only a write that settled removes the entry. When the lease stays held, the
 * entry remains and the next capture that reaches the store drains it (in this
 * process, or any later one once this one has exited), so the observation is
 * deferred, never dropped.
 *
 * @returns `'deferred'` when the write did not happen within the budget.
 */
async function captureObservation(
  projectRoot: string,
  params: ObserveBrainParams,
): Promise<HookHandlerOutcome | undefined> {
  const entry = spoolObservation(projectRoot, params);
  if (entry) inFlight.add(entry);
  const execution = createOperationExecutionContext(
    {
      projectId: projectRoot,
      projectRoot,
      actor: 'work-capture',
      operation: 'memory.observe',
      idempotencyKey: entry ?? randomUUID(),
    },
    { budgetMs: WORK_CAPTURE_WRITE_BUDGET_MS },
  );
  try {
    const { observeBrain } = await import('../../memory/brain-retrieval.js');
    try {
      await observeBrain(projectRoot, params, { execution });
    } catch (err) {
      if (isDeferral(err)) {
        if (entry) return 'deferred';
        getLogger('work-capture').warn(
          { err, title: params.title },
          'Work-capture observation dropped: the brain lease stayed held and spooling failed',
        );
        return undefined;
      }
      if (entry) rmSync(entry, { force: true });
      if (isMissingBrainSchemaError(err)) return undefined;
      throw err;
    }
    if (entry) rmSync(entry, { force: true });
    await drainSpool(projectRoot, observeBrain, execution);
    return undefined;
  } finally {
    if (entry) inFlight.delete(entry);
    execution.close();
  }
}

/** Whether a write was refused by its deadline (nothing was written). */
function isDeferral(err: unknown): boolean {
  return err instanceof LeaseUnavailableError || err instanceof OperationExecutionError;
}

/**
 * Persist an observation durably before it is written.
 *
 * @returns The entry path, or `null` when the spool is unavailable (the write
 *   is still attempted).
 */
function spoolObservation(projectRoot: string, params: ObserveBrainParams): string | null {
  try {
    const dir = join(resolveCleoDir(projectRoot), SPOOL_DIR);
    mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${process.pid}-${randomUUID()}.json`;
    const tmp = join(dir, `.${name}.tmp`);
    const fd = openSync(tmp, 'w');
    try {
      const body: SpoolEntry = { params };
      writeSync(fd, JSON.stringify(body));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const path = join(dir, name);
    renameSync(tmp, path);
    return path;
  } catch (err) {
    getLogger('work-capture').warn({ err }, 'Work-capture spool unavailable');
    return null;
  }
}

/** The pid that wrote (`<ms>-<pid>-<uuid>.json`) or claimed (`….claim-<pid>`) an entry. */
function ownerPid(name: string): number {
  const claim = /\.claim-(\d+)$/.exec(name);
  if (claim) return Number(claim[1]);
  return Number(name.split('-')[1]);
}

/**
 * Write spooled observations that no live writer owns (deferred earlier by this
 * process, or left by one that exited), within what remains of the budget.
 * Each entry is claimed by an atomic rename so two draining processes never
 * write it twice; a claim whose process died is claimed again. An entry whose write fails for a reason other than the
 * deadline is removed, as a direct write's failure would have been.
 */
async function drainSpool(
  projectRoot: string,
  observeBrain: typeof import('../../memory/brain-retrieval.js').observeBrain,
  execution: ReturnType<typeof createOperationExecutionContext>,
): Promise<void> {
  let dir: string;
  let names: string[];
  try {
    dir = join(resolveCleoDir(projectRoot), SPOOL_DIR);
    names = readdirSync(dir)
      .filter((n) => !n.startsWith('.'))
      .sort();
  } catch {
    return;
  }
  for (const name of names) {
    const pid = ownerPid(name);
    if (inFlight.has(join(dir, name)) || !Number.isInteger(pid)) continue;
    if (pid !== process.pid && isPidAlive(pid)) continue;
    if (execution.remainingMs() === 0) return;
    const claimed = join(dir, `${name.replace(/\.claim-\d+$/, '')}.claim-${process.pid}`);
    try {
      renameSync(join(dir, name), claimed);
    } catch {
      continue; // another process claimed it first
    }
    inFlight.add(claimed);
    try {
      let entry: SpoolEntry;
      try {
        entry = JSON.parse(readFileSync(claimed, 'utf8')) as SpoolEntry;
      } catch (err) {
        getLogger('work-capture').warn(
          { err, entry: claimed },
          'Unreadable work-capture spool entry',
        );
        rmSync(claimed, { force: true });
        continue;
      }
      try {
        await observeBrain(projectRoot, entry.params, { execution });
      } catch (err) {
        if (isDeferral(err)) return; // stays spooled, under this pid's claim, for a later drain
        if (!isMissingBrainSchemaError(err)) {
          getLogger('work-capture').warn(
            { err, entry: claimed },
            'Spooled work-capture write failed',
          );
        }
      }
      rmSync(claimed, { force: true });
    } finally {
      inFlight.delete(claimed);
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-registration
// ---------------------------------------------------------------------------

// Register at lower priority (90) than lifecycle hooks (100) so lifecycle
// handlers always run first.
hooks.register({
  id: 'work-capture-prompt-submit',
  awaitBeforeResponse: true,
  event: 'PromptSubmit',
  handler: handleWorkPromptSubmit,
  priority: 90,
});

hooks.register({
  id: 'work-capture-response-complete',
  awaitBeforeResponse: true,
  event: 'ResponseComplete',
  handler: handleWorkResponseComplete,
  priority: 90,
});
