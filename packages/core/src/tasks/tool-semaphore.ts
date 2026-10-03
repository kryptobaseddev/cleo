/**
 * Machine-wide admission for evidence-tool runs (T1534 / ADR-061, T13133).
 *
 * The cache layer ({@link runToolCached}) coalesces *identical* parallel runs
 * via a per-key file lock. Orchestrator-spawned worktree agents each operate
 * on a *different* HEAD, so their cache keys differ and the per-key lock does
 * not coalesce them; without a machine-wide bound, N worktree agents would
 * each spawn the full toolchain, multiplying CPU and resident memory by N.
 *
 * Since T13133 that bound is the admission ledger (`resources/admission-ledger.ts`):
 * one budget in bytes and one FIFO queue shared by every evidence run, every
 * `cleo run` job and the vitest project probe, machine-wide. An evidence run
 * asks for its footprint (`footprintForTool`: a heavy test/build run is
 * charged its worker count × 6 GiB, typecheck 5 GiB, lint and the rest 1 GiB),
 * waits its turn, and exports the grant's `CLEO_ADMISSION` token to the tool
 * it spawns, so a `cleo verify` or `cleo run` the tool starts rides the grant
 * instead of waiting for the budget its own ancestor holds.
 *
 * What it replaced: per-tool slot directories under `<cleoHome>/locks/tool-*`,
 * core- and RAM-derived slot counts (`defaultMaxConcurrent`), PSI slot scaling
 * (`pressureScaleSlots`), the darwin one-slot rule (T12963) and a second,
 * separate governor slot taken after the tool slot, the order that could
 * deadlock against `cleo run` (T13133). Memory pressure now narrows the one
 * budget, and the memory gate (T13127) refuses heavy work outright while
 * memory is short; a waiting run says so on stderr with the readings.
 *
 * `CLEO_TOOL_CONCURRENCY_<TOOL>` no longer counts runs: `0` (or below) still
 * bypasses admission for that tool, any other value is ignored, and either
 * prints one deprecation line per process on stderr. `CLEO_RESOURCES_MODE=off`
 * is the supported switch.
 *
 * @task T1534
 * @task T12091
 * @task T12963
 * @task T13127
 * @task T13133
 * @adr ADR-061
 */

import {
  type AdmissionRefusal,
  admissionCapacityBytes,
  admit,
  footprintForTool,
} from '../resources/admission-ledger.js';
import type { ResourceSample } from '../resources/backend.js';
import { memoryGateReporter } from '../resources/pressure-gate.js';
import type { CanonicalTool } from './tool-resolver.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Function returned by {@link acquireGlobalSlot} that must be called to give
 * the admission back. Always-callable; idempotent against re-entry. `admission`
 * is the `CLEO_ADMISSION` value to export to the tool's environment (empty
 * when the run was not admitted through the ledger).
 *
 * @task T1534
 * @task T13133
 */
export type ReleaseSlotFn = (() => Promise<void>) & { readonly admission?: string };

/**
 * Options for {@link acquireGlobalSlot}.
 *
 * @task T1534
 */
export interface AcquireSlotOptions {
  /**
   * Maximum wall-clock time to wait for admission before throwing. The
   * default — 60 minutes — covers a long-running monorepo test suite ahead in
   * the queue.
   *
   * @defaultValue `3_600_000` (60 min)
   */
  timeoutMs?: number;
  /**
   * How often a waiting run re-reads the ledger.
   *
   * @defaultValue `250`
   */
  pollMs?: number;
  /**
   * Override `os.totalmem()` (in GiB) for the budget and the footprint, so a
   * test resolves the same budget on every host.
   *
   * @internal
   */
  totalRamGib?: number;
  /**
   * A fixed memory-pressure sample for every admission decision (tests). When
   * omitted, a live sample is taken; `null` disables pressure (no signal).
   *
   * @internal
   */
  pressureSample?: ResourceSample | null;
  /**
   * Bytes to ask for instead of the tool's default footprint: a vitest config
   * probe asks for 1 GiB, not a whole test run's.
   */
  footprintBytes?: number;
  /**
   * Skip admission altogether (tests that exercise only the cache layer).
   *
   * @internal
   */
  skipAdmission?: boolean;
  /**
   * Where a progress line goes while the run waits ("waiting: memory pressure
   * …", the holder report after a minute), T13127/T13133.
   *
   * @defaultValue one `[cleo] <line>` per notice on stderr (stdout carries the envelope)
   */
  notice?: (line: string) => void;
}

/** The default {@link AcquireSlotOptions.notice}: one stderr line. */
function stderrNotice(line: string): void {
  process.stderr.write(`[cleo] ${line}\n`); // json-stream-hygiene-allowed: progress while waiting; stdout carries the envelope
}

/** Tools whose deprecated `CLEO_TOOL_CONCURRENCY_<TOOL>` notice was printed in this process. */
const _deprecationNoticed = new Set<string>();

/**
 * The deprecated `CLEO_TOOL_CONCURRENCY_<TOOL>` override: `bypass` for `0` or
 * below, `ignored` for any other number, `null` when unset. Prints one
 * deprecation line per tool per process on stderr, never on stdout.
 *
 * @param canonical - the canonical tool.
 * @param notice - where the line goes.
 * @returns what the override does now.
 *
 * @task T13133
 */
export function legacyConcurrencyOverride(
  canonical: CanonicalTool,
  notice: (line: string) => void = stderrNotice,
): 'bypass' | 'ignored' | null {
  const key = `CLEO_TOOL_CONCURRENCY_${canonical.toUpperCase().replace(/-/g, '_')}`;
  const raw = process.env[key];
  if (raw === undefined || raw === '') return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return null;
  const effect = parsed <= 0 ? 'bypass' : 'ignored';
  if (!_deprecationNoticed.has(key)) {
    _deprecationNoticed.add(key);
    notice(
      `${key} is deprecated: heavy runs now share one machine-wide memory budget and no ` +
        `longer count slots (T13133). ${effect === 'bypass' ? `${key}=${raw} still bypasses admission for now;` : `${key}=${raw} is ignored;`} ` +
        'use CLEO_RESOURCES_MODE=off to turn admission off.',
    );
  }
  return effect;
}

/** Forget which deprecation notices were printed. Tests only. @internal */
export function _resetToolSemaphoreForTest(): void {
  _deprecationNoticed.clear();
}

/**
 * {@link acquireGlobalSlot} gave up: the run was not admitted within its
 * timeout. `refusal` says why (memory pressure, or the budget in use) and who
 * holds the budget.
 *
 * @task T13133
 */
export class AdmissionTimeoutError extends Error {
  /** Why the run was not admitted, with the holders. */
  readonly refusal: AdmissionRefusal;

  /**
   * @param canonical - the tool whose run waited.
   * @param refusal - the ledger's refusal.
   */
  constructor(canonical: CanonicalTool, refusal: AdmissionRefusal) {
    super(
      `Timed out waiting for admission of a '${canonical}' run: ${refusal.reason}.` +
        (refusal.holders.length > 0 ? ` Current holders — ${refusal.holders.join('; ')}.` : '') +
        ' Use CI as test evidence (ci:<pr>), narrow the run, or set CLEO_RESOURCES_MODE=off to turn admission off.',
    );
    this.name = 'AdmissionTimeoutError';
    this.refusal = refusal;
  }
}

function withAdmission(release: () => Promise<void>, admission: string): ReleaseSlotFn {
  return Object.assign(release, { admission });
}

const NOOP_RELEASE: ReleaseSlotFn = withAdmission(async () => {
  /* nothing was admitted */
}, '');

/**
 * Wait for admission of one evidence run of a canonical tool, machine-wide.
 * Blocks until the ledger admits it or `timeoutMs` elapses.
 *
 * Re-entrant: inside an admitted run's process tree (a `cleo verify` that a
 * `cleo run` job or another evidence run started) it is admitted at once on
 * that grant. While it waits on memory pressure it says so through
 * {@link AcquireSlotOptions.notice}, and after a minute it names the holders.
 *
 * @param canonical - Canonical tool name from the resolver.
 * @param opts - Acquisition options.
 * @returns A release function carrying the `CLEO_ADMISSION` token. Idempotent.
 * @throws When `timeoutMs` elapses without admission, naming the reason and
 *   the holders.
 *
 * @example
 * ```ts
 * const release = await acquireGlobalSlot('test');
 * try {
 *   await runTheTool({ env: { CLEO_ADMISSION: release.admission } });
 * } finally {
 *   await release();
 * }
 * ```
 *
 * @task T1534
 * @task T13133
 */
export async function acquireGlobalSlot(
  canonical: CanonicalTool,
  opts: AcquireSlotOptions = {},
): Promise<ReleaseSlotFn> {
  const notice = opts.notice ?? stderrNotice;
  if (opts.skipAdmission === true || legacyConcurrencyOverride(canonical, notice) === 'bypass') {
    return NOOP_RELEASE;
  }
  const totalBytes = opts.totalRamGib !== undefined ? opts.totalRamGib * 1024 ** 3 : undefined;
  const fixed = opts.pressureSample;
  const outcome = await admit(
    {
      label: `tool:${canonical}`,
      footprintBytes: opts.footprintBytes ?? footprintForTool(canonical, totalBytes),
    },
    {
      wait: true,
      timeoutMs: opts.timeoutMs ?? 3_600_000,
      ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
      ...(totalBytes !== undefined ? { capacityBytes: admissionCapacityBytes(totalBytes) } : {}),
      // A fixed sample (or none) when given; otherwise the ledger's default.
      ...(fixed === undefined
        ? {}
        : {
            sample: async () => {
              if (fixed === null) throw new Error('pressure disabled');
              return fixed;
            },
          }),
      memoryPressure: memoryGateReporter(notice, `'${canonical}' run`),
      notice,
    },
  );
  if (!outcome.admitted) {
    // @sync-invariant none:local-only machine-wide admission timeout; no store write
    throw new AdmissionTimeoutError(canonical, outcome.refusal);
  }
  const { grant } = outcome;
  if (grant.ungoverned) {
    notice(
      `admission ledger is not writable (${grant.ungoverned.code}${grant.ungoverned.path ? ` ${grant.ungoverned.path}` : ''}): running the '${canonical}' run ungoverned`,
    );
  }
  return withAdmission(() => grant.release(), grant.token);
}
