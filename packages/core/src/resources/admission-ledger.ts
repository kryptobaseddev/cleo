/**
 * The admission ledger: ONE machine-wide budget and ONE FIFO queue for every
 * heavy run (T13133, epic T13121).
 *
 * It replaces the layers that admitted heavy work before it: the tool
 * semaphore's per-tool slot directories, the governor's `test-run`,
 * `scoped-build` and `full-build` slots, `cleo run`'s per-class queues and the
 * darwin one-slot rule. Each layer bounded only what it could see, and two of
 * them taken in opposite orders deadlocked the machine queue (T13133). Here
 * every heavy run — a `cleo verify` evidence run, a `cleo run` job, the vitest
 * project probe — asks one ledger for a share of one budget.
 *
 * ## Budget
 *
 * Bytes, not runs: `capacity = totalRAM − max(4 GiB, 25%)`. A run asks for its
 * footprint ({@link footprintForTool}, {@link footprintForClass}); a run larger
 * than the capacity is clamped to it and runs alone, so nothing waits forever
 * on its size. Pressure scales the budget: the memory gate (`pressure-gate.ts`,
 * T13127) refusing means nothing starts; a `hold` verdict halves the budget and
 * a CPU-saturated `backoff` admits one run at a time (each keeps one run
 * going when nothing else is running).
 *
 * ## Queue
 *
 * FIFO with backfill: the oldest waiting run starts when it fits; a later run
 * may start ahead of it while it is young, if it fits now. Once the oldest
 * waiting run has waited {@link LEDGER_RESERVATION_MS} it holds a reservation
 * and nothing passes it, so neither a big run nor a stream of small ones can
 * starve the other. Any process that enters the ledger (an arrival, a waiter's
 * periodic pass, a release) runs the scheduling pass for everyone; waiters see
 * their admission by reading the file.
 *
 * ## Re-entrancy
 *
 * A grant exports `CLEO_ADMISSION=<id>.<nonce>` to its children. A request
 * made inside an admitted run's process tree rides that grant (no new budget,
 * no queue), so a `cleo verify` under `cleo run`, or a `cleo run` under an
 * evidence run, never waits for the budget its own ancestor holds. The token
 * only says which grant to check: the caller must descend from the holder
 * (ancestry, or membership of a tool process group it started), with the
 * holder's start time matching, so the env var alone grants nothing. A wrapper
 * that scrubs the environment is caught by the same ancestry scan.
 *
 * ## The file
 *
 * `<cleoHome>/admission/ledger.json`, rewritten by tmp + rename inside a
 * `proper-lockfile` critical section that only reads, decides and writes:
 * pressure samples and process probes happen before it is entered, and it is
 * never held across a spawn or a wait. An entry is dropped once its holder is
 * provably gone: pid gone (or recycled, by start time) and every tool group it
 * started gone; a fresh heartbeat or an unreadable probe keeps it.
 *
 * @module resources/admission-ledger
 * @task T13133
 * @epic T13121
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, totalmem } from 'node:os';
import { join } from 'node:path';
import type { MemoryPressureReading, ResourceClass } from '@cleocode/contracts';
import lockfile from 'proper-lockfile';
import { getLogger } from '../logger.js';
import { getCleoHome } from '../paths.js';
import {
  defaultSingleProcessHeapMb,
  GIB_PER_WORKER,
  HEAVY_TOOL_HEAP_MB,
  heavyToolWorkers,
  isHeavyTool,
  isMemoryBoundTool,
} from '../tasks/heavy-tool-env.js';
import type { CanonicalTool } from '../tasks/tool-resolver.js';
import type { ResourceSample } from './backend.js';
import { pressureScore, ResourceMonitor } from './monitor.js';
import {
  checkMemoryGate,
  MEMORY_GATE_RETRY_AFTER_MS,
  type MemoryGateReporter,
} from './pressure-gate.js';
import { processAncestors, processGroupOf } from './run-admission.js';
import { ownProcessStartedAt, type PidProbe, systemPidProbe } from './slot-holder.js';
import { followToolGroups, isProbeableId } from './tool-groups.js';

let _log: ReturnType<typeof getLogger> | null = null;
function log(): ReturnType<typeof getLogger> {
  if (_log === null) _log = getLogger('admission-ledger');
  return _log;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The env var a grant exports to its children: `<id>.<nonce>`. */
export const ADMISSION_ENV = 'CLEO_ADMISSION';

/** The oldest waiting run holds a reservation (no backfill passes it) after this long. */
export const LEDGER_RESERVATION_MS = 120_000;

/** An admitted run refreshes its heartbeat this often. */
export const LEDGER_HEARTBEAT_MS = 15_000;

/** A heartbeat older than this no longer proves its holder alive on its own. */
export const LEDGER_HEARTBEAT_STALE_MS = 60_000;

/** A waiter names the holders (and any suspected cycle) after this long, then this often. */
export const LEDGER_HOLDER_REPORT_MS = 60_000;

/** A crashed process's critical-section lock is taken over after this long. */
export const LEDGER_CRITICAL_STALE_MS = 10_000;

/** How often a waiter re-reads the ledger to see whether it was admitted. */
const READ_POLL_MS = 250;

/** How often a waiter runs a scheduling pass of its own when nobody has sampled pressure lately. */
const PASS_EVERY_MS = 2_000;

/** A pressure verdict written to the ledger this recently is reused instead of sampling again. */
const PRESSURE_REUSE_MS = PASS_EVERY_MS;

/**
 * The ledger file format this CLEO reads and writes. A file with a newer
 * version is never rewritten by this one: admission runs ungoverned instead.
 */
export const LEDGER_VERSION = 1;

/**
 * An entry whose holder cannot be positively identified (pid gone, recycled,
 * unprobeable, or no recorded start time) is dropped once its heartbeat is
 * this old. A live holder heartbeats every {@link LEDGER_HEARTBEAT_MS}. The
 * old slot locks had the same 10-minute takeover as a backstop.
 */
export const LEDGER_ORPHAN_MS = 600_000;

/**
 * `CLEO_ADMISSION_PRESSURE=off`: admission ignores memory and CPU pressure
 * and admits on the byte budget alone (a CI runner whose PSI is noisy, and
 * the test suite, which must never depend on the host's load). An explicit
 * sampler passed to {@link admit} is still used.
 */
export const ADMISSION_PRESSURE_ENV = 'CLEO_ADMISSION_PRESSURE';

/** One GiB in bytes. */
export const GIB = 1024 ** 3;

/** What a light run (audit, security scan) or a config probe is charged. */
export const LIGHT_FOOTPRINT_BYTES = GIB;

/**
 * Resident memory one Node process holds beyond its V8 heap ceiling, in MiB:
 * code, native allocations, buffers (the same allowance the heavy worker count
 * makes: {@link GIB_PER_WORKER} minus the default heap).
 */
export const PROCESS_OVERHEAD_MB = GIB_PER_WORKER * 1024 - HEAVY_TOOL_HEAP_MB;

/** Lock retries for the critical section: up to ~15 s, longer than the stale takeover. */
/**
 * Lock attempts while another process is inside the critical section, and the
 * backoff between them (ms, growing by 1.2, randomized up to 2x): about 15 s
 * in all. Only contention (`ELOCKED`) is retried; any other error (a
 * read-only CLEO home) fails at once, so a sandbox runs ungoverned without
 * first waiting out the retries.
 */
const LOCK_ATTEMPTS = 400;
const LOCK_BACKOFF_MS: readonly [number, number] = [2, 40];

// ---------------------------------------------------------------------------
// Budget and footprints
// ---------------------------------------------------------------------------

/**
 * RAM the ledger never hands out: the OS, resident apps, VMs and agent CLIs.
 *
 * @param totalBytes - physical RAM in bytes.
 */
export function admissionReserveBytes(totalBytes: number): number {
  return Math.max(4 * GIB, totalBytes * 0.25);
}

/**
 * The machine-wide budget for heavy runs, in bytes (at least 1 GiB).
 *
 * @param totalBytes - physical RAM. @defaultValue os.totalmem()
 *
 * @example
 * ```ts
 * admissionCapacityBytes(48 * GIB); // 36 GiB
 * ```
 */
export function admissionCapacityBytes(totalBytes: number = totalmem()): number {
  return Math.max(GIB, totalBytes - admissionReserveBytes(totalBytes));
}

/**
 * What one heavy test or build run is charged: the worker count the heavy-tool
 * overlay gives it (`heavyToolWorkers`) × {@link GIB_PER_WORKER}.
 *
 * @param totalBytes - physical RAM. @defaultValue os.totalmem()
 */
export function heavyRunFootprintBytes(totalBytes: number = totalmem()): number {
  return heavyToolWorkers(totalBytes / GIB) * GIB_PER_WORKER * GIB;
}

/**
 * What an evidence run of a canonical tool is charged: a heavy test or build
 * run its workers × {@link GIB_PER_WORKER}; a single-process memory-bound run
 * (`typecheck`, `lint`) its heap ceiling plus {@link PROCESS_OVERHEAD_MB} (the
 * heap the run is planned with, T13122, or the machine's default for a single
 * process); anything else {@link LIGHT_FOOTPRINT_BYTES}.
 *
 * @param canonical - the canonical tool.
 * @param totalBytes - physical RAM. @defaultValue os.totalmem()
 * @param heapMb - the heap ceiling the run is spawned with, in MiB, when known.
 *
 * @example
 * ```ts
 * footprintForTool('test', 48 * GIB);            // 36 GiB (6 workers × 6 GiB)
 * footprintForTool('typecheck', 48 * GIB);       // 6 GiB (4096 MiB heap + 2048 MiB)
 * footprintForTool('typecheck', 48 * GIB, 8192); // 10 GiB
 * ```
 */
export function footprintForTool(
  canonical: CanonicalTool,
  totalBytes: number = totalmem(),
  heapMb?: number,
): number {
  if (isHeavyTool(canonical)) return heavyRunFootprintBytes(totalBytes);
  if (isMemoryBoundTool(canonical)) {
    const heap = heapMb ?? defaultSingleProcessHeapMb(totalBytes / GIB);
    return (Math.max(0, heap) + PROCESS_OVERHEAD_MB) * 1024 * 1024;
  }
  return LIGHT_FOOTPRINT_BYTES;
}

/** Governor classes whose admission is the ledger's. */
export const LEDGER_CLASSES: ReadonlySet<ResourceClass> = new Set<ResourceClass>([
  'test-run',
  'scoped-build',
  'full-build',
]);

/**
 * Whether the ledger admits a governor class.
 *
 * @param cls - the governor class.
 */
export function isLedgerClass(cls: ResourceClass): boolean {
  return LEDGER_CLASSES.has(cls);
}

/**
 * What a `cleo run` job of a ledger class is charged.
 *
 * @param cls - the governor class.
 * @param totalBytes - physical RAM. @defaultValue os.totalmem()
 */
export function footprintForClass(cls: ResourceClass, totalBytes: number = totalmem()): number {
  return isLedgerClass(cls) ? heavyRunFootprintBytes(totalBytes) : LIGHT_FOOTPRINT_BYTES;
}

// ---------------------------------------------------------------------------
// The ledger file
// ---------------------------------------------------------------------------

/** One run in the ledger. */
export interface LedgerEntry {
  /** Unique id: `<pid>-<ms>-<rand>`. */
  readonly id: string;
  /** Secret half of the {@link ADMISSION_ENV} token. */
  readonly nonce: string;
  /** The holder (or waiter) process. */
  readonly pid: number;
  /** Host the pid belongs to. */
  readonly host: string;
  /** The holder's process start time, or `null` when `ps` could not say. */
  readonly startedAt: string | null;
  /** What is running: `tool:test`, `run:test-run`, `probe:vitest-projects`. */
  readonly label: string;
  /** The command line, redacted, for status and reports. */
  readonly command: string;
  /** Working directory, when known. */
  readonly cwd: string | null;
  /** Bytes requested. */
  readonly footprintBytes: number;
  /** `waiting` in the queue, or `admitted` and holding its share. */
  readonly state: 'waiting' | 'admitted';
  /** When it joined the queue (FIFO order). */
  readonly enqueuedAtMs: number;
  /** When it was admitted. */
  readonly admittedAtMs: number | null;
  /** Last proof of life. */
  readonly heartbeatAtMs: number;
  /** Process groups of the tools the holder started while admitted. */
  readonly toolGroups: readonly number[];
}

/**
 * The ledger directory under the CLEO home.
 *
 * @param cleoHome - the CLEO home. @defaultValue {@link getCleoHome}
 */
export function admissionDir(cleoHome: string = getCleoHome()): string {
  return join(cleoHome, 'admission');
}

function ledgerFile(dir: string): string {
  return join(dir, 'ledger.json');
}

function isEntry(v: unknown): v is LedgerEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.nonce === 'string' &&
    isProbeableId(e.pid) &&
    typeof e.host === 'string' &&
    (e.startedAt === null || typeof e.startedAt === 'string') &&
    typeof e.label === 'string' &&
    typeof e.command === 'string' &&
    typeof e.footprintBytes === 'number' &&
    Number.isFinite(e.footprintBytes) &&
    (e.state === 'waiting' || e.state === 'admitted') &&
    typeof e.enqueuedAtMs === 'number' &&
    typeof e.heartbeatAtMs === 'number' &&
    Array.isArray(e.toolGroups)
  );
}

/** A ledger entry in a format this CLEO does not know: kept verbatim, charged conservatively. */
export type ForeignEntry = Readonly<Record<string, unknown>>;

/** The last pressure verdict a pass computed, shared with every waiter. */
interface CachedPressure {
  readonly share: BudgetShare;
  readonly reading: MemoryPressureReading | null;
  readonly sampledAtMs: number;
}

/** The ledger file, read. */
interface LedgerDoc {
  /** The format version the file was written with. */
  readonly version: number;
  readonly entries: LedgerEntry[];
  /** Entries this CLEO cannot parse (another version's): written back into `entries` untouched. */
  readonly foreign: ForeignEntry[];
  readonly pressure: CachedPressure | null;
  /** The file existed but was not valid JSON. */
  readonly corrupt: boolean;
}

const SHARES: ReadonlySet<string> = new Set(['full', 'half', 'one', 'none']);

function isCachedPressure(v: unknown): v is CachedPressure {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.share === 'string' &&
    SHARES.has(c.share) &&
    typeof c.sampledAtMs === 'number' &&
    (c.reading === null || (typeof c.reading === 'object' && c.reading !== null))
  );
}

function readLedgerDoc(dir: string): LedgerDoc {
  const empty: LedgerDoc = {
    version: LEDGER_VERSION,
    entries: [],
    foreign: [],
    pressure: null,
    corrupt: false,
  };
  let raw: string;
  try {
    raw = readFileSync(ledgerFile(dir), 'utf-8');
  } catch {
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...empty, corrupt: true };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...empty, corrupt: true };
  }
  const o = parsed as Record<string, unknown>;
  const version =
    typeof o.version === 'number' && Number.isFinite(o.version) ? o.version : LEDGER_VERSION;
  const entries: LedgerEntry[] = [];
  const foreign: ForeignEntry[] = [];
  for (const v of Array.isArray(o.entries) ? o.entries : []) {
    if (isEntry(v)) entries.push(v);
    else if (typeof v === 'object' && v !== null && !Array.isArray(v))
      foreign.push(v as ForeignEntry);
  }
  return {
    version,
    entries,
    foreign,
    pressure: isCachedPressure(o.pressure) ? o.pressure : null,
    corrupt: false,
  };
}

/**
 * Read the ledger's entries without the lock (writes are atomic renames, so a
 * reader sees a whole file). A missing or corrupt file has no entries;
 * entries of a format this CLEO does not know are left out (they are kept in
 * the file and still charged).
 *
 * @param dir - the ledger directory. @defaultValue {@link admissionDir}
 */
export function readLedger(dir: string = admissionDir()): LedgerEntry[] {
  return readLedgerDoc(dir).entries;
}

/**
 * Entries of a format this CLEO does not know (written by another CLEO
 * version sharing the CLEO home), read without the lock.
 *
 * @param dir - the ledger directory. @defaultValue {@link admissionDir}
 */
export function readForeignEntries(dir: string = admissionDir()): ForeignEntry[] {
  return readLedgerDoc(dir).foreign;
}

function writeLedgerDoc(dir: string, doc: LedgerDoc): void {
  const file = ledgerFile(dir);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(
      tmp,
      JSON.stringify({
        version: LEDGER_VERSION,
        // Foreign entries go back where they were found, verbatim.
        entries: [...doc.entries, ...doc.foreign],
        pressure: doc.pressure,
      }),
      'utf-8',
    );
    renameSync(tmp, file);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing more to do.
    }
    throw err;
  }
}

/**
 * The ledger file was written by a newer CLEO: this one never rewrites it.
 * Admission treats it like unwritable state and runs ungoverned.
 */
export class LedgerVersionError extends Error {
  /** Error code, matched by {@link admissionIoError}. */
  readonly code = 'E_LEDGER_VERSION';
  /** The ledger file. */
  readonly path: string;

  /**
   * @param version - the version found in the file.
   * @param path - the ledger file.
   */
  constructor(version: number, path: string) {
    super(
      `admission ledger ${path} has format version ${version}; this CLEO understands ${LEDGER_VERSION} and will not rewrite it`,
    );
    this.name = 'LedgerVersionError';
    this.path = path;
  }
}

/** Take the ledger lock, retrying only while another process holds it. */
async function lockLedger(file: string): Promise<() => Promise<void>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await lockfile.lock(file, {
        lockfilePath: `${file}.lock`,
        realpath: false,
        stale: LEDGER_CRITICAL_STALE_MS,
        retries: 0,
        onCompromised: (err: Error) => {
          log().warn({ err: err.message }, 'admission ledger lock compromised; continuing');
        },
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== 'ELOCKED' || attempt >= LOCK_ATTEMPTS) throw err;
      const backoff = Math.min(LOCK_BACKOFF_MS[1], LOCK_BACKOFF_MS[0] * 1.2 ** attempt);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, backoff * (1 + Math.random()));
      });
    }
  }
}

/**
 * Run `fn` inside the ledger's critical section: read, decide, write. `fn`
 * must be synchronous and do no I/O of its own; its `doc` (or `null` for no
 * change) is written back before the lock is released. A file of a newer
 * format throws {@link LedgerVersionError} and is left untouched; a corrupt
 * file is moved aside before it is replaced.
 */
async function withLedger<T>(
  dir: string,
  fn: (doc: LedgerDoc) => { readonly doc: LedgerDoc | null; readonly result: T },
): Promise<T> {
  mkdirSync(dir, { recursive: true });
  const file = ledgerFile(dir);
  const unlock = await lockLedger(file);
  try {
    const current = readLedgerDoc(dir);
    if (current.version > LEDGER_VERSION) {
      // @sync-invariant none:local-only the admission ledger is a machine-local file, not a store write
      throw new LedgerVersionError(current.version, file);
    }
    const { doc, result } = fn(current);
    if (doc !== null) {
      if (current.corrupt) {
        log().warn({ file }, 'admission ledger was not valid JSON; moved aside and replaced');
        renameSync(file, `${file}.corrupt-${Date.now()}`);
      }
      writeLedgerDoc(dir, doc);
    }
    return result;
  } finally {
    try {
      await unlock();
    } catch {
      // Already released (stale takeover): the post-condition holds.
    }
  }
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

/**
 * Whether an entry's holder is still there.
 *
 * - A pid that is provably gone (or recycled: alive with another start time,
 *   once the heartbeat is stale) is dead as soon as every tool group it
 *   started is gone too; a detached tool outlives a SIGKILLed cleo.
 * - A fresh heartbeat, or a live pid whose start time matches the recorded
 *   one, is alive.
 * - A holder that cannot be identified (the probe fails, or no start time was
 *   recorded or can be read) is alive until its heartbeat is
 *   {@link LEDGER_ORPHAN_MS} old, and so is a gone holder whose tool group id
 *   still runs (a group id carries no start time, so it may be recycled).
 *   Past that bound both are dead: nothing holds the budget forever.
 * - An entry of another host is judged by its heartbeat alone.
 *
 * @param entry - the ledger entry.
 * @param nowMs - the clock.
 * @param probe - pid probe (tests inject one).
 */
export function entryLiveness(
  entry: LedgerEntry,
  nowMs: number,
  probe: PidProbe = systemPidProbe,
): 'alive' | 'dead' {
  const age = nowMs - entry.heartbeatAtMs;
  if (entry.host !== hostname()) return age < LEDGER_HEARTBEAT_STALE_MS ? 'alive' : 'dead';
  const orphaned = age >= LEDGER_ORPHAN_MS;
  const goneUnlessGroups = (): 'alive' | 'dead' =>
    orphaned || entry.toolGroups.every((g) => isProbeableId(g) && probe.groupLiveness(g) === 'gone')
      ? 'dead'
      : 'alive';
  const pid = probe.liveness(entry.pid);
  if (pid === 'gone') return goneUnlessGroups();
  if (age < LEDGER_HEARTBEAT_STALE_MS) return 'alive';
  if (pid === 'alive' && entry.startedAt !== null) {
    const startedAt = probe.startedAt(entry.pid);
    if (startedAt === entry.startedAt) return 'alive';
    if (startedAt !== null) return goneUnlessGroups(); // a recycled pid
  }
  return orphaned ? 'dead' : 'alive';
}

/**
 * The budget an entry of an unknown format is charged: its numeric
 * `footprintBytes` when it has one, else the whole capacity.
 */
function foreignCharge(f: ForeignEntry, capacityBytes: number): number {
  const fp = f.footprintBytes;
  return typeof fp === 'number' && Number.isFinite(fp) && fp >= 0
    ? Math.min(fp, capacityBytes)
    : capacityBytes;
}

/**
 * Whether an entry of an unknown format is provably finished: its heartbeat
 * (when it has one) is {@link LEDGER_ORPHAN_MS} old, or its pid on this host
 * is gone.
 */
function foreignLiveness(f: ForeignEntry, nowMs: number, probe: PidProbe): 'alive' | 'dead' {
  const hb = f.heartbeatAtMs;
  if (typeof hb === 'number' && Number.isFinite(hb) && nowMs - hb >= LEDGER_ORPHAN_MS)
    return 'dead';
  if (isProbeableId(f.pid) && f.host === hostname() && probe.liveness(f.pid) === 'gone') {
    return 'dead';
  }
  return 'alive';
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * How much of the budget pressure leaves: `full`; `half` (memory or CPU at
 * hold); `one` run at a time (CPU saturated); `none` (the memory gate refuses).
 */
export type BudgetShare = 'full' | 'half' | 'one' | 'none';

/**
 * The budget share for a sample, from the memory gate's verdict and the
 * pressure score (memory, or CPU rescaled; see `pressureScore`).
 *
 * @param sample - a backend sample.
 * @param gateRefuses - the memory gate's verdict for the sample.
 */
export function budgetShare(sample: ResourceSample, gateRefuses: boolean): BudgetShare {
  if (gateRefuses) return 'none';
  const score = pressureScore(sample);
  if (score > 25) return 'one';
  if (score > 10) return 'half';
  return 'full';
}

/** Inputs to one scheduling pass. */
export interface PassContext {
  /** The machine-wide budget in bytes. */
  readonly capacityBytes: number;
  /** What pressure leaves of it. */
  readonly share: BudgetShare;
  /** The clock. */
  readonly nowMs: number;
  /** @defaultValue {@link LEDGER_RESERVATION_MS} */
  readonly reservationMs?: number;
  /** Entries of an unknown format, counted as admitted with their charge. */
  readonly foreign?: { readonly bytes: number; readonly count: number };
}

function charged(entry: LedgerEntry, capacityBytes: number): number {
  return Math.min(Math.max(0, entry.footprintBytes), capacityBytes);
}

/**
 * One scheduling pass: admit every waiting entry the budget and the queue
 * order allow. Pure.
 *
 * - FIFO by `enqueuedAtMs`. A later entry may be admitted ahead of an older
 *   one that does not fit (backfill) until that older one has waited
 *   `reservationMs`; from then on nothing passes it.
 * - A footprint above the capacity is charged the capacity (it runs alone).
 * - `half` halves the budget and `one` admits a single run, but either still
 *   admits the oldest waiting entry when nothing is admitted; `none` admits
 *   nothing.
 *
 * @param entries - the ledger.
 * @param ctx - capacity, pressure share and clock.
 * @returns the ledger with admissions applied (same order).
 *
 * @example
 * ```ts
 * schedulePass(entries, { capacityBytes: 36 * GIB, share: 'full', nowMs: Date.now() });
 * ```
 */
export function schedulePass(entries: readonly LedgerEntry[], ctx: PassContext): LedgerEntry[] {
  if (ctx.share === 'none') return [...entries];
  const reservationMs = ctx.reservationMs ?? LEDGER_RESERVATION_MS;
  const budget =
    ctx.share === 'full' ? ctx.capacityBytes : ctx.share === 'half' ? ctx.capacityBytes / 2 : 0;
  let used = ctx.foreign?.bytes ?? 0;
  let running = ctx.foreign?.count ?? 0;
  for (const e of entries) {
    if (e.state === 'admitted') {
      used += charged(e, ctx.capacityBytes);
      running++;
    }
  }
  const waiting = entries
    .filter((e) => e.state === 'waiting')
    .sort((a, b) => a.enqueuedAtMs - b.enqueuedAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const admit = new Set<string>();
  let blocked = false;
  for (const w of waiting) {
    const cost = charged(w, ctx.capacityBytes);
    // With nothing running, the oldest waiting run always starts (it is
    // charged at most the capacity), so pressure narrows but never stops work.
    if (used + cost <= budget || running === 0) {
      admit.add(w.id);
      used += cost;
      running++;
      continue;
    }
    if (!blocked) {
      blocked = true;
      if (ctx.nowMs - w.enqueuedAtMs >= reservationMs) break;
    }
  }
  return entries.map((e) =>
    admit.has(e.id)
      ? { ...e, state: 'admitted', admittedAtMs: ctx.nowMs, heartbeatAtMs: ctx.nowMs }
      : e,
  );
}

// ---------------------------------------------------------------------------
// Re-entrancy
// ---------------------------------------------------------------------------

/**
 * Split a {@link ADMISSION_ENV} value into its id and nonce, or `null`.
 *
 * @param value - the env value.
 */
export function parseAdmissionToken(
  value: string | undefined,
): { id: string; nonce: string } | null {
  if (!value) return null;
  const at = value.lastIndexOf('.');
  if (at <= 0 || at === value.length - 1) return null;
  return { id: value.slice(0, at), nonce: value.slice(at + 1) };
}

/** The process facts the re-entrancy check needs (tests inject them). */
export interface ProcessFacts {
  /** Ancestors of a pid, nearest first, or `null` when `ps` fails. */
  readonly ancestorsOf: (pid: number) => readonly number[] | null;
  /** Process group of a pid, or `null`. */
  readonly groupOf: (pid: number) => number | null;
  /** Start time of a pid (the ledger's format), or `null`. */
  readonly startedAt: (pid: number) => string | null;
}

const systemProcessFacts: ProcessFacts = {
  ancestorsOf: processAncestors,
  groupOf: processGroupOf,
  startedAt: (pid) => systemPidProbe.startedAt(pid),
};

/**
 * The admitted entry whose process tree `pid` belongs to, or `null`.
 *
 * Proof is ancestry: the holder is an ancestor of `pid`, with its recorded
 * start time matching. The token in `env` only narrows which entry is checked
 * first; a missing or foreign token falls back to checking every admitted
 * entry by ancestry, so a wrapper that scrubs the environment cannot deadlock
 * a nested run.
 *
 * Group membership (`pid` runs in a tool process group the holder started,
 * which covers a tool that outlived a killed holder) is accepted only for the
 * entry the token names on this host: a process group id carries no start
 * time, so a recycled group id alone proves nothing.
 *
 * @param entries - the ledger.
 * @param pid - the requesting process.
 * @param env - its environment.
 * @param facts - process probes (tests inject them).
 */
export function enclosingGrant(
  entries: readonly LedgerEntry[],
  pid: number,
  env: NodeJS.ProcessEnv,
  facts: ProcessFacts = systemProcessFacts,
): LedgerEntry | null {
  const host = hostname();
  // No host filter for ancestry: an ancestor is local by definition, and a
  // laptop's hostname follows the network (LOW-4 of the #1829 review).
  const admitted = entries.filter((e) => e.state === 'admitted' && e.pid !== pid);
  if (admitted.length === 0) return null;
  const token = parseAdmissionToken(env[ADMISSION_ENV]);
  const hinted = token ? admitted.filter((e) => e.id === token.id && e.nonce === token.nonce) : [];
  const ordered = [...hinted, ...admitted.filter((e) => !hinted.includes(e))];
  let ancestors: readonly number[] | null | undefined;
  let group: number | null | undefined;
  for (const e of ordered) {
    ancestors ??= facts.ancestorsOf(pid);
    group ??= facts.groupOf(pid);
    const byAncestry = ancestors?.includes(e.pid) === true;
    const byGroup =
      e.host === host &&
      hinted.includes(e) &&
      group !== null &&
      isProbeableId(group) &&
      e.toolGroups.includes(group);
    if (!byAncestry && !byGroup) continue;
    if (byAncestry && e.startedAt !== null && facts.startedAt(e.pid) !== e.startedAt) continue;
    return e;
  }
  return null;
}

/** The {@link ADMISSION_ENV} value of an entry. */
export function admissionToken(entry: Pick<LedgerEntry, 'id' | 'nonce'>): string {
  return `${entry.id}.${entry.nonce}`;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function gib(bytes: number): string {
  return `${(bytes / GIB).toFixed(bytes < 10 * GIB ? 1 : 0)} GiB`;
}

function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/**
 * One line per admitted run: label, pid, command, directory and age.
 *
 * @param entries - the ledger.
 * @param nowMs - the clock.
 */
export function describeHolders(entries: readonly LedgerEntry[], nowMs: number): string[] {
  return entries
    .filter((e) => e.state === 'admitted')
    .map(
      (e) =>
        `${e.label} pid ${e.pid} (${e.command})${e.cwd ? ` in ${e.cwd}` : ''}, ${gib(e.footprintBytes)}, for ${age(nowMs - (e.admittedAtMs ?? e.enqueuedAtMs))}`,
    );
}

/** Commands too generic to name a lock-taking wrapper. */
const GENERIC_PROGRAMS = new Set([
  'node',
  'cleo',
  'ct',
  'sh',
  'bash',
  'zsh',
  'env',
  'nice',
  'nohup',
  'time',
  'npm',
  'pnpm',
  'npx',
  'yarn',
  'bun',
  'vitest',
  'tsc',
  'login',
  'tmux',
  'claude',
]);

/** The program a command line runs: the first argument that is not an interpreter or a flag. */
function programOf(command: string): string | null {
  for (const token of command.trim().split(/\s+/)) {
    if (token.startsWith('-') || token.includes('=')) continue;
    const base = token.split('/').pop() ?? token;
    if (/^(node|bash|sh|zsh|env|nice|nohup|time|python3?)$/.test(base)) continue;
    return base;
  }
  return null;
}

/** `ps -A -o pid=,ppid=,command=`, or `null` when `ps` fails. */
function processTable(): Map<number, { ppid: number; command: string }> | null {
  let out: string;
  try {
    out = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,command='], {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    });
  } catch {
    return null;
  }
  const table = new Map<number, { ppid: number; command: string }>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m?.[1] && m[2]) table.set(Number(m[1]), { ppid: Number(m[2]), command: m[3] ?? '' });
  }
  return table;
}

/**
 * A suspected wait cycle through a lock outside CLEO: a holder's process tree
 * and this waiter's ancestry run the same (non-generic) program, such as a
 * wrapper script that takes its own lock. `null` when nothing points to one.
 *
 * @param pid - the waiting process.
 * @param holders - admitted entries.
 * @param table - the process table (`pid → {ppid, command}`).
 */
export function suspectCycle(
  pid: number,
  holders: readonly LedgerEntry[],
  table: ReadonlyMap<number, { ppid: number; command: string }>,
): string | null {
  const ours = new Map<string, number>();
  for (let at = table.get(pid)?.ppid, n = 0; at !== undefined && at > 1 && n < 64; n++) {
    const row = table.get(at);
    if (!row) break;
    const prog = programOf(row.command);
    if (prog && !GENERIC_PROGRAMS.has(prog) && !ours.has(prog)) ours.set(prog, at);
    at = row.ppid;
  }
  if (ours.size === 0) return null;
  const children = new Map<number, number[]>();
  for (const [child, row] of table) {
    const list = children.get(row.ppid) ?? [];
    list.push(child);
    children.set(row.ppid, list);
  }
  for (const h of holders) {
    const stack = [...(children.get(h.pid) ?? [])];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const at = stack.pop() as number;
      if (seen.has(at) || seen.size > 4096) continue;
      seen.add(at);
      const prog = programOf(table.get(at)?.command ?? '');
      const mine = prog ? ours.get(prog) : undefined;
      if (prog && mine !== undefined) {
        return (
          `suspected wait cycle: holder pid ${h.pid} (${h.label}) runs ${prog} (pid ${at}), and this ` +
          `waiter runs under ${prog} (pid ${mine}). If ${prog} takes a lock of its own, neither can ` +
          `proceed: run heavy work under one of them, not both.`
        );
      }
      stack.push(...(children.get(at) ?? []));
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

/** What a request asks for. */
export interface AdmissionRequest {
  /** What is running: `tool:test`, `run:test-run`, `probe:vitest-projects`. */
  readonly label: string;
  /** Bytes it needs (see {@link footprintForTool}, {@link footprintForClass}). */
  readonly footprintBytes: number;
  /** The command line, redacted. @defaultValue this process's argv */
  readonly command?: string;
  /** Working directory. @defaultValue process.cwd() */
  readonly cwd?: string | null;
}

/** How to wait, and where to report. */
export interface AdmitOptions {
  /** Wait in the queue (`true`) or return a deferral at once. */
  readonly wait: boolean;
  /** Give up after this long. @defaultValue 60 min */
  readonly timeoutMs?: number;
  /** Re-read cadence while waiting. @defaultValue 250 ms */
  readonly pollMs?: number;
  /**
   * One pressure sample; a throw counts as no signal. A sampler given here is
   * always called: it bypasses the verdict another process wrote to the
   * ledger in the last 2 s, which the default reuses.
   * @defaultValue a ResourceMonitor sample, or none under `CLEO_ADMISSION_PRESSURE=off`
   */
  readonly sample?: () => Promise<ResourceSample>;
  /** The machine budget in bytes. @defaultValue {@link admissionCapacityBytes} */
  readonly capacityBytes?: number;
  /** The requester's environment (for {@link ADMISSION_ENV}). @defaultValue process.env */
  readonly env?: NodeJS.ProcessEnv;
  /** Told while the memory gate holds the run back, and when it admits. */
  readonly memoryPressure?: MemoryGateReporter;
  /** Where the holder report goes while waiting. */
  readonly notice?: (line: string) => void;
  /** The ledger directory. @defaultValue {@link admissionDir} */
  readonly dir?: string;
  /** Process probes for re-entrancy (tests). */
  readonly facts?: ProcessFacts;
  /** Pid probe for liveness (tests). */
  readonly probe?: PidProbe;
  /** The requesting pid (tests). @defaultValue process.pid */
  readonly pid?: number;
  /** Clock (tests). @defaultValue Date.now */
  readonly now?: () => number;
  /** Wait (tests). @defaultValue setTimeout */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** An admission: the share is held until `release`. */
export interface AdmissionGrant {
  /** The ledger entry, or `null` for a pass-through (nested, off, ungoverned). */
  readonly id: string | null;
  /** The {@link ADMISSION_ENV} value to export to children; `''` when there is none. */
  readonly token: string;
  /** `true` when it rides an enclosing grant. */
  readonly nested: boolean;
  /** Set when the ledger could not be written here: the run proceeds ungoverned. */
  readonly ungoverned: { readonly code: string; readonly path: string | null } | null;
  /** How long it waited. */
  readonly waitedMs: number;
  /** Bytes charged. */
  readonly footprintBytes: number;
  /** Give the share back. Idempotent. */
  release(): Promise<void>;
}

/** A refusal: nothing was started. */
export interface AdmissionRefusal {
  /** Why, with the numbers. */
  readonly reason: string;
  /** Back-off hint. */
  readonly retryAfterMs: number;
  /** The memory gate's readings when it was the reason. */
  readonly memoryPressure: MemoryPressureReading | null;
  /** Waiting runs ahead of this one. */
  readonly ahead: number;
  /** One line per admitted run. */
  readonly holders: readonly string[];
}

/** {@link admit}'s result. */
export type AdmissionOutcome =
  | { readonly admitted: true; readonly grant: AdmissionGrant }
  | { readonly admitted: false; readonly refusal: AdmissionRefusal };

/** Filesystem errors meaning the ledger cannot be kept here. */
const STATE_IO_CODES = new Set([
  'EACCES',
  'EPERM',
  'EROFS',
  'ENOSPC',
  'EDQUOT',
  'ENOTDIR',
  'ELOOP',
  // A ledger written by a newer CLEO: never rewritten, so admission runs ungoverned.
  'E_LEDGER_VERSION',
]);

/** Why admission state cannot be written: the errno code and the path, when known. */
export interface AdmissionIoError {
  readonly code: string;
  readonly path: string | null;
}

/**
 * The code and path of an error that means "admission state cannot be kept
 * here" (a sandbox that blocks writes to the CLEO home, a read-only or full
 * disk, a broken CLEO home), or `null` for any other error, which is a bug and
 * must not be hidden.
 *
 * @param err - a caught error.
 */
export function admissionIoError(err: unknown): AdmissionIoError | null {
  const e = err as NodeJS.ErrnoException | null;
  if (!e || typeof e !== 'object' || typeof e.code !== 'string') return null;
  if (!STATE_IO_CODES.has(e.code)) return null;
  return { code: e.code, path: typeof e.path === 'string' ? e.path : null };
}

/**
 * Why a run is ungoverned, in words: `admission state is not writable (EACCES
 * /path)`, or, for a ledger a newer CLEO wrote, that this CLEO will not
 * rewrite it. Callers append what they do about it.
 *
 * @param io - from {@link admissionIoError} or a grant's `ungoverned`.
 */
export function describeAdmissionIoError(io: AdmissionIoError): string {
  const at = io.path ? ` ${io.path}` : '';
  return io.code === 'E_LEDGER_VERSION'
    ? `the admission ledger${at} was written by a newer CLEO, which this one never rewrites (upgrade CLEO to share the machine budget)`
    : `admission state is not writable (${io.code}${at})`;
}

function passThrough(
  token: string,
  nested: boolean,
  ungoverned: AdmissionGrant['ungoverned'],
): AdmissionGrant {
  return {
    id: null,
    token,
    nested,
    ungoverned,
    waitedMs: 0,
    footprintBytes: 0,
    release: async () => {},
  };
}

function newId(pid: number, nowMs: number): string {
  return `${pid}-${nowMs}-${randomBytes(3).toString('hex')}`;
}

/** A pressure verdict, and the record to write back when it was freshly sampled. */
interface ShareVerdict {
  readonly share: BudgetShare;
  readonly reading: MemoryPressureReading | null;
  readonly sampled: CachedPressure | null;
}

/**
 * Sample pressure and ask the memory gate, outside the critical section. A
 * verdict another process wrote to the ledger less than
 * {@link PRESSURE_REUSE_MS} ago is reused instead, unless `opts.sample` is
 * given, so a crowd of waiters costs one sample per interval, not one each.
 */
async function sampleShare(
  opts: AdmitOptions,
  cached: CachedPressure | null,
  nowMs: number,
): Promise<ShareVerdict> {
  if (!opts.sample) {
    if (process.env[ADMISSION_PRESSURE_ENV] === 'off') {
      return { share: 'full', reading: null, sampled: null };
    }
    if (cached !== null && isFresh(cached, nowMs)) {
      return { share: cached.share, reading: cached.reading, sampled: null };
    }
  }
  let sample: ResourceSample | null;
  try {
    sample = await (opts.sample ?? (() => new ResourceMonitor().sample()))();
  } catch {
    sample = null;
  }
  if (sample === null) return { share: 'full', reading: null, sampled: null };
  const gate = checkMemoryGate(sample, opts.now ? { now: opts.now } : {});
  const share = budgetShare(sample, gate.refuse);
  const reading = gate.refuse ? gate.reading : null;
  return { share, reading, sampled: { share, reading, sampledAtMs: nowMs } };
}

function isFresh(cached: CachedPressure, nowMs: number): boolean {
  const age = nowMs - cached.sampledAtMs;
  return age >= 0 && age < PRESSURE_REUSE_MS;
}

/** What a pass may drop: entries (with the heartbeat probed) and foreign entries (by content). */
interface DeadSet {
  readonly entries: ReadonlyMap<string, number>;
  readonly foreign: ReadonlySet<string>;
}

/** The provably finished entries of a ledger, probed outside the critical section. */
function findDead(doc: LedgerDoc, nowMs: number, probe: PidProbe): DeadSet {
  const entries = new Map<string, number>();
  for (const e of doc.entries) {
    if (entryLiveness(e, nowMs, probe) === 'dead') entries.set(e.id, e.heartbeatAtMs);
  }
  const foreign = new Set<string>();
  for (const f of doc.foreign) {
    if (foreignLiveness(f, nowMs, probe) === 'dead') foreign.add(JSON.stringify(f));
  }
  return { entries, foreign };
}

const NO_DEAD: DeadSet = { entries: new Map(), foreign: new Set() };

/** The budget foreign entries take, counted as running. */
function foreignLoad(
  foreign: readonly ForeignEntry[],
  capacityBytes: number,
): { readonly bytes: number; readonly count: number } {
  let bytes = 0;
  for (const f of foreign) bytes += foreignCharge(f, capacityBytes);
  return { bytes, count: foreign.length };
}

/**
 * Drop the dead (unless they heartbeated since the probe), charge foreign
 * entries, schedule, and keep the freshest pressure verdict.
 */
function reapAndSchedule(
  doc: LedgerDoc,
  dead: DeadSet,
  ctx: Omit<PassContext, 'foreign'>,
  sampled: CachedPressure | null,
): LedgerDoc {
  const live = doc.entries.filter((e) => dead.entries.get(e.id) !== e.heartbeatAtMs);
  const foreign = doc.foreign.filter((f) => !dead.foreign.has(JSON.stringify(f)));
  return {
    ...doc,
    entries: schedulePass(live, { ...ctx, foreign: foreignLoad(foreign, ctx.capacityBytes) }),
    foreign,
    pressure: sampled ?? doc.pressure,
  };
}

/**
 * Ask the ledger for a share of the machine budget.
 *
 * `CLEO_RESOURCES_MODE=off` admits everything. Re-entrant: inside an admitted
 * run's process tree it returns a pass-through grant at once. Otherwise it joins the FIFO queue; with `wait: false` it
 * leaves again unless admitted on the spot, and with `wait: true` it waits
 * (reporting memory-pressure waits and, after a minute, the holders and any
 * suspected cycle) until admitted or `timeoutMs`. Never throws for admission
 * control. An unwritable ledger, or one written by a newer CLEO, is a
 * pass-through grant with `ungoverned` set (callers say so with
 * {@link describeAdmissionIoError}); any other error propagates.
 *
 * @param req - what is asked for.
 * @param opts - waiting and reporting.
 *
 * @example
 * ```ts
 * const out = await admit({ label: 'tool:test', footprintBytes: footprintForTool('test') }, { wait: true });
 * if (out.admitted) {
 *   try { await run({ env: { [ADMISSION_ENV]: out.grant.token } }); } finally { await out.grant.release(); }
 * }
 * ```
 */
export async function admit(req: AdmissionRequest, opts: AdmitOptions): Promise<AdmissionOutcome> {
  // The governor's off switch turns admission off here too.
  if (process.env.CLEO_RESOURCES_MODE === 'off') {
    return { admitted: true, grant: passThrough('', false, null) };
  }
  try {
    return await admitInner(req, opts);
  } catch (err) {
    const io = admissionIoError(err);
    if (io === null) throw err;
    return { admitted: true, grant: passThrough('', false, io) };
  }
}

async function admitInner(req: AdmissionRequest, opts: AdmitOptions): Promise<AdmissionOutcome> {
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const dir = opts.dir ?? admissionDir();
  const pid = opts.pid ?? process.pid;
  const env = opts.env ?? process.env;
  const probe = opts.probe ?? systemPidProbe;
  const capacityBytes = opts.capacityBytes ?? admissionCapacityBytes();
  const timeoutMs = opts.timeoutMs ?? 3_600_000;
  const t0 = now();

  // Re-entrant: a request inside an admitted run's tree rides its grant.
  const parent = enclosingGrant(readLedger(dir), pid, env, opts.facts);
  if (parent !== null) {
    return { admitted: true, grant: passThrough(admissionToken(parent), true, null) };
  }

  const entry: LedgerEntry = {
    id: newId(pid, t0),
    nonce: randomBytes(12).toString('hex'),
    pid,
    host: hostname(),
    startedAt: pid === process.pid ? ownProcessStartedAt() : probe.startedAt(pid),
    label: req.label,
    command: req.command ?? process.argv.slice(1).join(' '),
    cwd: req.cwd === undefined ? process.cwd() : req.cwd, // CWD-OK: display only — where the run was started, shown in status and reports
    footprintBytes: Math.max(0, req.footprintBytes),
    state: 'waiting',
    enqueuedAtMs: t0,
    admittedAtMs: null,
    heartbeatAtMs: t0,
    toolGroups: [],
  };

  /** One pass: reap, (re-)enqueue ourselves, schedule; returns our entry's state. */
  const pass = async (): Promise<{
    mine: LedgerEntry | null;
    doc: LedgerDoc;
    reading: MemoryPressureReading | null;
  }> => {
    const before = readLedgerDoc(dir);
    const nowMs = now();
    const { share, reading, sampled } = await sampleShare(opts, before.pressure, nowMs);
    const dead = findDead(before, nowMs, probe);
    return withLedger(dir, (doc) => {
      let entries = doc.entries;
      const at = entries.findIndex((e) => e.id === entry.id);
      if (at < 0) entries = [...entries, { ...entry, heartbeatAtMs: nowMs }];
      else if (entries[at]?.state === 'waiting') {
        entries = entries.map((e) => (e.id === entry.id ? { ...e, heartbeatAtMs: nowMs } : e));
      }
      const next = reapAndSchedule(
        { ...doc, entries },
        dead,
        { capacityBytes, share, nowMs },
        sampled,
      );
      return {
        doc: next,
        result: { mine: next.entries.find((e) => e.id === entry.id) ?? null, doc: next, reading },
      };
    });
  };

  const leave = async (): Promise<LedgerEntry | null> =>
    withLedger(dir, (doc) => {
      const mine = doc.entries.find((e) => e.id === entry.id) ?? null;
      if (mine?.state === 'admitted') return { doc: null, result: mine };
      return {
        doc: { ...doc, entries: doc.entries.filter((e) => e.id !== entry.id) },
        result: null,
      };
    });

  const refusal = (doc: LedgerDoc, reading: MemoryPressureReading | null): AdmissionRefusal => {
    const nowMs = now();
    const ahead = doc.entries.filter(
      (e) => e.state === 'waiting' && e.id !== entry.id && e.enqueuedAtMs <= entry.enqueuedAtMs,
    ).length;
    const load = budgetLoad(doc, capacityBytes);
    const reason =
      reading !== null
        ? `memory pressure ${reading.score} (refused above ${reading.refuseAbove}, resumes at ` +
          `${reading.resumeAtOrBelow} or below): ${reading.summary}`
        : `machine budget in use: ${gib(load.bytes)} of ${gib(capacityBytes)} by ${load.runs} run(s); ` +
          `this run needs ${gib(charged(entry, capacityBytes))}${ahead > 0 ? `; ${ahead} waiting ahead` : ''}`;
    return {
      reason,
      retryAfterMs: reading !== null ? MEMORY_GATE_RETRY_AFTER_MS : 2_000,
      memoryPressure: reading,
      ahead,
      holders: describeLoad(doc, nowMs),
    };
  };

  let first = await pass();
  if (first.mine?.state === 'admitted') {
    return { admitted: true, grant: holdGrant(first.mine, dir, now() - t0, opts) };
  }
  if (!opts.wait) {
    const raced = await leave();
    if (raced !== null) return { admitted: true, grant: holdGrant(raced, dir, now() - t0, opts) };
    return { admitted: false, refusal: refusal(first.doc, first.reading) };
  }

  let lastPassAt = now();
  let lastReportAt = t0;
  let reading = first.reading;
  for (;;) {
    if (reading !== null) opts.memoryPressure?.waiting(reading, now() - t0);
    if (now() - lastReportAt >= LEDGER_HOLDER_REPORT_MS && opts.notice) {
      lastReportAt = now();
      opts.notice(holderReport(first.doc, entry, pid, now() - t0, capacityBytes, now()));
    }
    const remaining = timeoutMs - (now() - t0);
    if (remaining <= 0) {
      const raced = await leave();
      if (raced !== null) return { admitted: true, grant: holdGrant(raced, dir, now() - t0, opts) };
      return { admitted: false, refusal: refusal(first.doc, reading) };
    }
    await sleep(Math.min(opts.pollMs ?? READ_POLL_MS, remaining));
    const seen = readLedgerDoc(dir);
    const mine = seen.entries.find((e) => e.id === entry.id);
    if (mine?.state === 'admitted') {
      opts.memoryPressure?.admitted(now() - t0, null);
      return { admitted: true, grant: holdGrant(mine, dir, now() - t0, opts) };
    }
    if (seen.pressure !== null && isFresh(seen.pressure, now())) reading = seen.pressure.reading;
    if (passDue(mine === undefined, now() - lastPassAt, seen.pressure, now(), opts)) {
      lastPassAt = now();
      first = await pass();
      reading = first.reading;
      if (first.mine?.state === 'admitted') {
        opts.memoryPressure?.admitted(now() - t0, null);
        return { admitted: true, grant: holdGrant(first.mine, dir, now() - t0, opts) };
      }
    }
  }
}

/**
 * Whether a waiter runs a pass of its own now: its entry is gone (reaped or
 * never written), its heartbeat is due, or a pass is due and nobody has
 * sampled pressure lately (a fresh verdict in the ledger means another
 * process just ran a pass, which scheduled everyone).
 */
function passDue(
  missing: boolean,
  sinceLastPassMs: number,
  pressure: CachedPressure | null,
  nowMs: number,
  opts: AdmitOptions,
): boolean {
  if (missing || sinceLastPassMs >= LEDGER_HEARTBEAT_MS) return true;
  if (sinceLastPassMs < PASS_EVERY_MS) return false;
  // An injected sampler never reads the cache, so it never waits on it either.
  return opts.sample !== undefined || pressure === null || !isFresh(pressure, nowMs);
}

/** What the admitted runs and foreign entries take from the budget. */
function budgetLoad(
  doc: LedgerDoc,
  capacityBytes: number,
): { readonly bytes: number; readonly runs: number } {
  const admitted = doc.entries.filter((e) => e.state === 'admitted');
  const foreign = foreignLoad(doc.foreign, capacityBytes);
  return {
    bytes: admitted.reduce((n, e) => n + charged(e, capacityBytes), 0) + foreign.bytes,
    runs: admitted.length + foreign.count,
  };
}

/** {@link describeHolders}, plus a line for entries of another CLEO version. */
function describeLoad(doc: LedgerDoc, nowMs: number): string[] {
  const lines = describeHolders(doc.entries, nowMs);
  if (doc.foreign.length > 0) {
    lines.push(
      `${doc.foreign.length} entr${doc.foreign.length === 1 ? 'y' : 'ies'} of another CLEO version`,
    );
  }
  return lines;
}

/** The holder report a long waiter prints. */
function holderReport(
  doc: LedgerDoc,
  mine: LedgerEntry,
  pid: number,
  waitedMs: number,
  capacityBytes: number,
  nowMs: number,
): string {
  const holders = doc.entries.filter((e) => e.state === 'admitted');
  const used = budgetLoad(doc, capacityBytes).bytes;
  const ahead = doc.entries.filter(
    (e) => e.state === 'waiting' && e.id !== mine.id && e.enqueuedAtMs <= mine.enqueuedAtMs,
  ).length;
  const lines = [
    `still waiting after ${age(waitedMs)} for the machine budget (${gib(used)} of ${gib(capacityBytes)} in use, ` +
      `${ahead} waiting ahead). Holders: ${describeLoad(doc, nowMs).join('; ') || 'none'}.`,
  ];
  const table = holders.length > 0 ? processTable() : null;
  const cycle = table ? suspectCycle(pid, holders, table) : null;
  if (cycle) lines.push(cycle);
  return lines.join(' ');
}

/** First and longest delay between attempts to remove a released entry that failed. */
const RELEASE_RETRY_MS: readonly [number, number] = [1_000, LEDGER_HEARTBEAT_MS];

/** Hold an admitted entry: heartbeat, follow tool groups, release. */
function holdGrant(
  entry: LedgerEntry,
  dir: string,
  waitedMs: number,
  opts: AdmitOptions,
): AdmissionGrant {
  const update = (patch: (e: LedgerEntry) => LedgerEntry): Promise<void> =>
    withLedger(dir, (doc) => {
      if (!doc.entries.some((e) => e.id === entry.id)) return { doc: null, result: undefined };
      return {
        doc: { ...doc, entries: doc.entries.map((e) => (e.id === entry.id ? patch(e) : e)) },
        result: undefined,
      };
    }).catch(() => {
      // Best effort: a missed heartbeat only means the next probe asks ps.
    });
  const now = opts.now ?? Date.now;
  const timer = setInterval(() => {
    void update((e) => ({ ...e, heartbeatAtMs: now() }));
  }, LEDGER_HEARTBEAT_MS);
  timer.unref();
  const following = followToolGroups((groups) => {
    void update((e) => ({ ...e, toolGroups: [...groups] }));
  });
  if (following.groups.length > 0)
    void update((e) => ({ ...e, toolGroups: [...following.groups] }));

  /** Remove the entry and schedule the queue. True when done (or never possible here). */
  const removeOnce = async (): Promise<boolean> => {
    try {
      const before = readLedgerDoc(dir);
      const nowMs = now();
      const { share, sampled } = await sampleShare(opts, before.pressure, nowMs);
      const capacityBytes = opts.capacityBytes ?? admissionCapacityBytes();
      await withLedger(dir, (doc) => ({
        doc: reapAndSchedule(
          { ...doc, entries: doc.entries.filter((e) => e.id !== entry.id) },
          NO_DEAD,
          { capacityBytes, share, nowMs },
          sampled,
        ),
        result: undefined,
      }));
      return true;
    } catch (err) {
      // State that cannot be written cannot be cleaned either: the entry is
      // reaped once this process is gone.
      if (admissionIoError(err) !== null) return true;
      log().warn(
        { err: err instanceof Error ? err.message : String(err), id: entry.id },
        'admission release failed; retrying in the background',
      );
      return false;
    }
  };
  /** Keep trying in the background (never keeping the process alive) until removed. */
  const retry = (delayMs: number): void => {
    const t = setTimeout(() => {
      void removeOnce().then((done) => {
        if (!done) retry(Math.min(delayMs * 2, RELEASE_RETRY_MS[1]));
      });
    }, delayMs);
    t.unref();
  };

  let released = false;
  return {
    id: entry.id,
    token: admissionToken(entry),
    nested: false,
    ungoverned: null,
    waitedMs,
    footprintBytes: entry.footprintBytes,
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      following.stop();
      if (!(await removeOnce())) retry(RELEASE_RETRY_MS[0]);
    },
  };
}

/** Remove the ledger file (tests). @internal */
export function _resetAdmissionLedgerForTest(dir?: string): void {
  try {
    rmSync(ledgerFile(dir ?? admissionDir()), { force: true });
  } catch {
    // Absent already, or no CLEO home to clean.
  }
}

/** The id shown for an entry of an unknown format. */
function foreignId(f: ForeignEntry): string {
  return typeof f.id === 'string' ? f.id : `foreign:${JSON.stringify(f).slice(0, 60)}`;
}

/**
 * Drop every entry whose holder is provably gone, and schedule. For
 * `cleo doctor tool-locks --reap`; admission does this on every pass.
 *
 * @param opts - ledger directory, capacity and probes (tests).
 * @returns the ids removed (entries of another CLEO version included).
 */
export async function reapLedger(
  opts: Pick<AdmitOptions, 'dir' | 'capacityBytes' | 'probe' | 'now' | 'sample'> = {},
): Promise<string[]> {
  const dir = opts.dir ?? admissionDir();
  const now = opts.now ?? Date.now;
  const before = readLedgerDoc(dir);
  const nowMs = now();
  const dead = findDead(before, nowMs, opts.probe ?? systemPidProbe);
  if (dead.entries.size === 0 && dead.foreign.size === 0) return [];
  const { share, sampled } = await sampleShare({ wait: false, ...opts }, before.pressure, nowMs);
  const capacityBytes = opts.capacityBytes ?? admissionCapacityBytes();
  return withLedger(dir, (doc) => {
    const removed = [
      ...doc.entries.filter((e) => dead.entries.get(e.id) === e.heartbeatAtMs).map((e) => e.id),
      ...doc.foreign.filter((f) => dead.foreign.has(JSON.stringify(f))).map(foreignId),
    ];
    return {
      doc: reapAndSchedule(doc, dead, { capacityBytes, share, nowMs }, sampled),
      result: removed,
    };
  });
}

/**
 * Remove one entry by id, whatever its liveness, and schedule. For
 * `cleo doctor tool-locks --remove <id>`, when an entry cannot be proven dead
 * (its holder is unidentifiable) but the operator knows it is.
 *
 * @param id - the entry id (as `cleo doctor tool-locks` lists it).
 * @param opts - ledger directory, capacity and probes (tests).
 * @returns whether an entry was removed.
 */
export async function removeLedgerEntry(
  id: string,
  opts: Pick<AdmitOptions, 'dir' | 'capacityBytes' | 'now' | 'sample'> = {},
): Promise<boolean> {
  const dir = opts.dir ?? admissionDir();
  const now = opts.now ?? Date.now;
  const before = readLedgerDoc(dir);
  if (
    !before.entries.some((e) => e.id === id) &&
    !before.foreign.some((f) => foreignId(f) === id)
  ) {
    return false;
  }
  const nowMs = now();
  const { share, sampled } = await sampleShare({ wait: false, ...opts }, before.pressure, nowMs);
  const capacityBytes = opts.capacityBytes ?? admissionCapacityBytes();
  return withLedger(dir, (doc) => {
    const entries = doc.entries.filter((e) => e.id !== id);
    const foreign = doc.foreign.filter((f) => foreignId(f) !== id);
    if (entries.length === doc.entries.length && foreign.length === doc.foreign.length) {
      return { doc: null, result: false };
    }
    return {
      doc: reapAndSchedule(
        { ...doc, entries, foreign },
        NO_DEAD,
        { capacityBytes, share, nowMs },
        sampled,
      ),
      result: true,
    };
  });
}
