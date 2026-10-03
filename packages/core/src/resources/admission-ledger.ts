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
import { GIB_PER_WORKER, heavyToolWorkers } from '../tasks/heavy-tool-env.js';
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

/** How often a waiter runs a scheduling pass of its own (and refreshes its heartbeat). */
const PASS_EVERY_MS = 2_000;

/**
 * `CLEO_ADMISSION_PRESSURE=off`: admission ignores memory and CPU pressure
 * and admits on the byte budget alone (a CI runner whose PSI is noisy, and
 * the test suite, which must never depend on the host's load). An explicit
 * sampler passed to {@link admit} is still used.
 */
export const ADMISSION_PRESSURE_ENV = 'CLEO_ADMISSION_PRESSURE';

/** One GiB in bytes. */
export const GIB = 1024 ** 3;

/** What a typecheck run is charged: a large-monorepo `tsc` holds 2–5 GiB. */
export const TYPECHECK_FOOTPRINT_BYTES = 5 * GIB;

/** What a light tool run (lint, audit, scan) or a config probe is charged. */
export const LIGHT_FOOTPRINT_BYTES = GIB;

/** Lock retries for the critical section: up to ~15 s, longer than the stale takeover. */
const LOCK_RETRIES = { retries: 400, factor: 1.2, minTimeout: 2, maxTimeout: 40, randomize: true };

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
 * What an evidence run of a canonical tool is charged.
 *
 * @param canonical - the canonical tool.
 * @param totalBytes - physical RAM. @defaultValue os.totalmem()
 */
export function footprintForTool(
  canonical: CanonicalTool,
  totalBytes: number = totalmem(),
): number {
  if (canonical === 'test' || canonical === 'build') return heavyRunFootprintBytes(totalBytes);
  if (canonical === 'typecheck') return TYPECHECK_FOOTPRINT_BYTES;
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

/**
 * Read the ledger without the lock (writes are atomic renames, so a reader
 * sees a whole file). A missing file is an empty ledger; malformed entries are
 * dropped.
 *
 * @param dir - the ledger directory. @defaultValue {@link admissionDir}
 */
export function readLedger(dir: string = admissionDir()): LedgerEntry[] {
  let raw: string;
  try {
    raw = readFileSync(ledgerFile(dir), 'utf-8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { entries?: unknown };
    return Array.isArray(parsed.entries) ? parsed.entries.filter(isEntry) : [];
  } catch {
    log().warn({ dir }, 'admission ledger unreadable; starting from an empty ledger');
    return [];
  }
}

function writeLedger(dir: string, entries: readonly LedgerEntry[]): void {
  const file = ledgerFile(dir);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ version: 1, entries }), 'utf-8');
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
 * Run `fn` inside the ledger's critical section: read, decide, write. `fn`
 * must be synchronous and do no I/O of its own; its `entries` (or `null` for
 * no change) are written back before the lock is released.
 */
async function withLedger<T>(
  dir: string,
  fn: (entries: LedgerEntry[]) => { readonly entries: LedgerEntry[] | null; readonly result: T },
): Promise<T> {
  mkdirSync(dir, { recursive: true });
  const file = ledgerFile(dir);
  const unlock = await lockfile.lock(file, {
    lockfilePath: `${file}.lock`,
    realpath: false,
    stale: LEDGER_CRITICAL_STALE_MS,
    retries: LOCK_RETRIES,
    onCompromised: (err: Error) => {
      log().warn({ err: err.message }, 'admission ledger lock compromised; continuing');
    },
  });
  try {
    const { entries, result } = fn(readLedger(dir));
    if (entries !== null) writeLedger(dir, entries);
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
 * Whether an entry's holder is still there. `dead` only when the pid is gone
 * (or recycled, by start time) and every tool group it started is gone, or
 * when it belongs to another host and stopped heartbeating. A fresh heartbeat
 * or a probe that failed keeps it.
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
  const fresh = nowMs - entry.heartbeatAtMs < LEDGER_HEARTBEAT_STALE_MS;
  if (entry.host !== hostname()) return fresh ? 'alive' : 'dead';
  const groupsGone = (): boolean =>
    entry.toolGroups.every((g) => isProbeableId(g) && probe.groupLiveness(g) === 'gone');
  const pid = probe.liveness(entry.pid);
  if (pid === 'gone') return groupsGone() ? 'dead' : 'alive';
  if (pid === 'unknown' || fresh || entry.startedAt === null) return 'alive';
  const startedAt = probe.startedAt(entry.pid);
  if (startedAt === null || startedAt === entry.startedAt) return 'alive';
  return groupsGone() ? 'dead' : 'alive'; // a recycled pid
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
  let used = 0;
  let running = 0;
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
 * Proof is ancestry (the holder is an ancestor of `pid`) or group membership
 * (`pid` runs in a tool process group the holder started, which also covers a
 * tool that outlived a killed holder), with the holder's recorded start time
 * matching. The token in `env` only narrows which entry is checked first; a
 * missing or foreign token falls back to checking every admitted entry, so a
 * wrapper that scrubs the environment cannot deadlock a nested run.
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
  const admitted = entries.filter(
    (e) => e.state === 'admitted' && e.host === host && e.pid !== pid,
  );
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
    const byGroup = group !== null && isProbeableId(group) && e.toolGroups.includes(group);
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
   * One pressure sample; a throw counts as no signal.
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

/** Sample pressure and ask the memory gate, outside the critical section. */
async function sampleShare(
  opts: AdmitOptions,
): Promise<{ share: BudgetShare; reading: MemoryPressureReading | null }> {
  if (!opts.sample && process.env[ADMISSION_PRESSURE_ENV] === 'off') {
    return { share: 'full', reading: null };
  }
  let sample: ResourceSample | null;
  try {
    sample = await (opts.sample ?? (() => new ResourceMonitor().sample()))();
  } catch {
    sample = null;
  }
  if (sample === null) return { share: 'full', reading: null };
  const gate = checkMemoryGate(sample, opts.now ? { now: opts.now } : {});
  return { share: budgetShare(sample, gate.refuse), reading: gate.refuse ? gate.reading : null };
}

/** Ids of entries whose holders are provably gone, probed outside the critical section. */
function deadIds(
  entries: readonly LedgerEntry[],
  nowMs: number,
  probe: PidProbe,
): Map<string, number> {
  const dead = new Map<string, number>();
  for (const e of entries) {
    if (entryLiveness(e, nowMs, probe) === 'dead') dead.set(e.id, e.heartbeatAtMs);
  }
  return dead;
}

/** Drop the dead (unless they heartbeated since the probe), then schedule. */
function reapAndSchedule(
  entries: LedgerEntry[],
  dead: ReadonlyMap<string, number>,
  ctx: PassContext,
): LedgerEntry[] {
  const live = entries.filter((e) => dead.get(e.id) !== e.heartbeatAtMs);
  return schedulePass(live, ctx);
}

/**
 * Ask the ledger for a share of the machine budget.
 *
 * `CLEO_RESOURCES_MODE=off` admits everything. Re-entrant: inside an admitted
 * run's process tree it returns a pass-through grant at once. Otherwise it joins the FIFO queue; with `wait: false` it
 * leaves again unless admitted on the spot, and with `wait: true` it waits
 * (reporting memory-pressure waits and, after a minute, the holders and any
 * suspected cycle) until admitted or `timeoutMs`. Never throws for admission
 * control. An unwritable ledger is a pass-through grant with `ungoverned` set;
 * any other error propagates.
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
    cwd: req.cwd === undefined ? process.cwd() : req.cwd,
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
    entries: LedgerEntry[];
    reading: MemoryPressureReading | null;
  }> => {
    const { share, reading } = await sampleShare(opts);
    const nowMs = now();
    const dead = deadIds(readLedger(dir), nowMs, probe);
    return withLedger(dir, (entries) => {
      let next = entries;
      const at = next.findIndex((e) => e.id === entry.id);
      if (at < 0) next = [...next, { ...entry, heartbeatAtMs: nowMs }];
      else if (next[at]?.state === 'waiting') {
        next = next.map((e) => (e.id === entry.id ? { ...e, heartbeatAtMs: nowMs } : e));
      }
      next = reapAndSchedule(next, dead, { capacityBytes, share, nowMs });
      return {
        entries: next,
        result: { mine: next.find((e) => e.id === entry.id) ?? null, entries: next, reading },
      };
    });
  };

  const leave = async (): Promise<LedgerEntry | null> =>
    withLedger(dir, (entries) => {
      const mine = entries.find((e) => e.id === entry.id) ?? null;
      if (mine?.state === 'admitted') return { entries: null, result: mine };
      return { entries: entries.filter((e) => e.id !== entry.id), result: null };
    });

  const refusal = (
    entries: readonly LedgerEntry[],
    reading: MemoryPressureReading | null,
  ): AdmissionRefusal => {
    const nowMs = now();
    const ahead = entries.filter(
      (e) => e.state === 'waiting' && e.id !== entry.id && e.enqueuedAtMs <= entry.enqueuedAtMs,
    ).length;
    const admitted = entries.filter((e) => e.state === 'admitted');
    const used = admitted.reduce((n, e) => n + charged(e, capacityBytes), 0);
    const reason =
      reading !== null
        ? `memory pressure ${reading.score} (refused above ${reading.refuseAbove}, resumes at ` +
          `${reading.resumeAtOrBelow} or below): ${reading.summary}`
        : `machine budget in use: ${gib(used)} of ${gib(capacityBytes)} by ${admitted.length} run(s); ` +
          `this run needs ${gib(charged(entry, capacityBytes))}${ahead > 0 ? `; ${ahead} waiting ahead` : ''}`;
    return {
      reason,
      retryAfterMs: reading !== null ? MEMORY_GATE_RETRY_AFTER_MS : 2_000,
      memoryPressure: reading,
      ahead,
      holders: describeHolders(entries, nowMs),
    };
  };

  let first = await pass();
  if (first.mine?.state === 'admitted') {
    return { admitted: true, grant: holdGrant(first.mine, dir, now() - t0, opts) };
  }
  if (!opts.wait) {
    const raced = await leave();
    if (raced !== null) return { admitted: true, grant: holdGrant(raced, dir, now() - t0, opts) };
    return { admitted: false, refusal: refusal(first.entries, first.reading) };
  }

  let lastPassAt = now();
  let lastReportAt = t0;
  let reading = first.reading;
  for (;;) {
    if (reading !== null) opts.memoryPressure?.waiting(reading, now() - t0);
    if (now() - lastReportAt >= LEDGER_HOLDER_REPORT_MS && opts.notice) {
      lastReportAt = now();
      opts.notice(holderReport(first.entries, entry, pid, now() - t0, capacityBytes, now()));
    }
    const remaining = timeoutMs - (now() - t0);
    if (remaining <= 0) {
      const raced = await leave();
      if (raced !== null) return { admitted: true, grant: holdGrant(raced, dir, now() - t0, opts) };
      return { admitted: false, refusal: refusal(first.entries, reading) };
    }
    await sleep(Math.min(opts.pollMs ?? READ_POLL_MS, remaining));
    const seen = readLedger(dir).find((e) => e.id === entry.id);
    if (seen?.state === 'admitted') {
      opts.memoryPressure?.admitted(now() - t0, null);
      return { admitted: true, grant: holdGrant(seen, dir, now() - t0, opts) };
    }
    if (seen === undefined || now() - lastPassAt >= PASS_EVERY_MS) {
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

/** The holder report a long waiter prints. */
function holderReport(
  entries: readonly LedgerEntry[],
  mine: LedgerEntry,
  pid: number,
  waitedMs: number,
  capacityBytes: number,
  nowMs: number,
): string {
  const holders = entries.filter((e) => e.state === 'admitted');
  const used = holders.reduce((n, e) => n + charged(e, capacityBytes), 0);
  const ahead = entries.filter(
    (e) => e.state === 'waiting' && e.id !== mine.id && e.enqueuedAtMs <= mine.enqueuedAtMs,
  ).length;
  const lines = [
    `still waiting after ${age(waitedMs)} for the machine budget (${gib(used)} of ${gib(capacityBytes)} in use, ` +
      `${ahead} waiting ahead). Holders: ${describeHolders(entries, nowMs).join('; ') || 'none'}.`,
  ];
  const table = holders.length > 0 ? processTable() : null;
  const cycle = table ? suspectCycle(pid, holders, table) : null;
  if (cycle) lines.push(cycle);
  return lines.join(' ');
}

/** Hold an admitted entry: heartbeat, follow tool groups, release. */
function holdGrant(
  entry: LedgerEntry,
  dir: string,
  waitedMs: number,
  opts: AdmitOptions,
): AdmissionGrant {
  const update = (patch: (e: LedgerEntry) => LedgerEntry): Promise<void> =>
    withLedger(dir, (entries) => {
      if (!entries.some((e) => e.id === entry.id)) return { entries: null, result: undefined };
      return { entries: entries.map((e) => (e.id === entry.id ? patch(e) : e)), result: undefined };
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
      const { share } = await sampleShare(opts);
      const nowMs = now();
      const capacityBytes = opts.capacityBytes ?? admissionCapacityBytes();
      await withLedger(dir, (entries) => ({
        entries: schedulePass(
          entries.filter((e) => e.id !== entry.id),
          { capacityBytes, share, nowMs },
        ),
        result: undefined,
      })).catch((err: unknown) => {
        if (admissionIoError(err) === null) throw err;
      });
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

/**
 * Drop every entry whose holder is provably gone, and schedule. For
 * `cleo doctor tool-locks --reap`; admission does this on every pass.
 *
 * @param opts - ledger directory, capacity and probes (tests).
 * @returns the ids removed.
 */
export async function reapLedger(
  opts: Pick<AdmitOptions, 'dir' | 'capacityBytes' | 'probe' | 'now' | 'sample'> = {},
): Promise<string[]> {
  const dir = opts.dir ?? admissionDir();
  const now = opts.now ?? Date.now;
  const { share } = await sampleShare({ wait: false, ...opts });
  const nowMs = now();
  const dead = deadIds(readLedger(dir), nowMs, opts.probe ?? systemPidProbe);
  if (dead.size === 0) return [];
  const capacityBytes = opts.capacityBytes ?? admissionCapacityBytes();
  return withLedger(dir, (entries) => {
    const removed = entries.filter((e) => dead.get(e.id) === e.heartbeatAtMs).map((e) => e.id);
    return {
      entries: reapAndSchedule(entries, dead, { capacityBytes, share, nowMs }),
      result: removed,
    };
  });
}
