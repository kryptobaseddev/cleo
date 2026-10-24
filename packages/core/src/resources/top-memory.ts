/**
 * The host's largest memory users (T13914), so an admission wait names what
 * took the memory instead of waiting silently at a zero budget.
 *
 * macOS ranks by `top`'s MEM column, the process footprint: resident plus
 * compressed and swapped pages. `ps` RSS leaves those out, so a leaking
 * long-lived agent (17 GB, almost all compressed) reads as 260 MB there.
 * Linux ranks by `ps` RSS. Every failure reads as "no list", never an error.
 *
 * @task T13914
 */

import { execFileSync } from 'node:child_process';
import type { MemoryConsumer, MemoryPressureReading } from '@cleocode/contracts';

/** How many processes a wait names. */
export const TOP_MEMORY_COUNT = 3;

/** A probe younger than this is reused while the gate keeps refusing. */
export const TOP_MEMORY_REUSE_MS = 30_000;

/** A FAILED probe is reused this long, so a hanging probe cannot block every pass. */
export const TOP_MEMORY_FAILED_REUSE_MS = 20_000;

/** Set once `top` has failed on this host: later probes go straight to `ps`. */
let topFailed = false;

/** Forget that `top` failed (tests). */
export function _resetTopMemoryForTest(): void {
  topFailed = false;
}

/** Runs one probe command and returns its stdout; throws on failure or timeout. */
export type ProbeRunner = (cmd: string, args: readonly string[]) => string;

const UNIT: Readonly<Record<string, number>> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 };

/**
 * Parse `top -l 1 -o mem -stats pid,mem,command` output (macOS): the rows
 * after the `PID MEM COMMAND` header, MEM as `4391M`, `17G`, `512K` (a
 * trailing `+`/`-` is ignored).
 *
 * @param text - `top` stdout.
 * @param limit - Rows to keep.
 * @returns Largest first, as `top` sorted them.
 */
export function parseTopMemory(text: string, limit: number = TOP_MEMORY_COUNT): MemoryConsumer[] {
  const lines = text.split('\n');
  const header = lines.findIndex((l) => /^\s*PID\s+MEM\s+COMMAND/.test(l));
  if (header < 0) return [];
  const out: MemoryConsumer[] = [];
  for (const line of lines.slice(header + 1)) {
    const m = /^\s*(\d+)\s+(\d+(?:\.\d+)?)([BKMG])[+-]?\s+(.+?)\s*$/.exec(line);
    if (m === null) continue;
    out.push({
      pid: Number(m[1]),
      command: m[4] as string,
      footprintBytes: Math.round(Number(m[2]) * (UNIT[m[3] as string] ?? 1)),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Parse `ps -eo pid=,rss=,comm=` output (RSS in KiB) and keep the largest.
 *
 * @param text - `ps` stdout.
 * @param limit - Rows to keep.
 * @returns Largest first.
 */
export function parsePsMemory(text: string, limit: number = TOP_MEMORY_COUNT): MemoryConsumer[] {
  const out: MemoryConsumer[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m === null) continue;
    out.push({ pid: Number(m[1]), command: m[3] as string, footprintBytes: Number(m[2]) * 1024 });
  }
  return out.sort((a, b) => b.footprintBytes - a.footprintBytes).slice(0, limit);
}

/** Longest one probe may take; it is then SIGKILLed (T13964). */
export const TOP_MEMORY_TIMEOUT_MS = 2_000;

/**
 * The host's largest memory users right now: one `top` sample on macOS
 * (footprint), falling back to `ps` RSS when `top` fails (and, once `top`
 * has failed on this host, going straight to `ps`); one `ps` on Linux. Each
 * probe is SIGKILLed after {@link TOP_MEMORY_TIMEOUT_MS}. `null` when no probe
 * could list them (the caller says UNKNOWN, never "nothing").
 *
 * @param limit - How many. @defaultValue {@link TOP_MEMORY_COUNT}
 * @param platform - @defaultValue process.platform
 * @param run - Runs one probe command (tests). @defaultValue a bounded execFileSync
 * @returns Largest first, or `null` when the probe failed.
 */
export function topMemoryConsumers(
  limit: number = TOP_MEMORY_COUNT,
  platform: NodeJS.Platform = process.platform,
  run: ProbeRunner = (cmd, args) =>
    execFileSync(cmd, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: TOP_MEMORY_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    }),
): MemoryConsumer[] | null {
  const ps = (): MemoryConsumer[] | null => {
    try {
      const rows = parsePsMemory(run('/bin/ps', ['-A', '-o', 'pid=,rss=,comm=']), limit);
      return rows.length > 0 ? rows : null;
    } catch {
      return null;
    }
  };
  if (platform === 'darwin' && !topFailed) {
    try {
      const args = ['-l', '1', '-o', 'mem', '-n', String(limit), '-stats', 'pid,mem,command'];
      const rows = parseTopMemory(run('/usr/bin/top', args), limit);
      if (rows.length > 0) return rows;
    } catch {
      // Fall back to ps below (RSS misses compressed pages, but names the process).
    }
    topFailed = true;
    return ps();
  }
  return platform === 'darwin' || platform === 'linux' ? ps() : null;
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/**
 * The memory gate's cause in words: the platform signals, then the largest
 * memory users when they were probed and how to free them, e.g.
 * `kernel level warn; swap 8.6 GiB used; largest memory users: agy pid 4242
 * 17.0 GiB, node pid 77 1.8 GiB (quit or restart them to free memory; check
 * with top -o mem)`.
 *
 * @param reading - The gate's readings.
 * @returns One line.
 */
export function memoryPressureCause(reading: MemoryPressureReading): string {
  if (reading.topConsumers?.failed === true) {
    return (
      `${reading.summary}; largest memory users: UNKNOWN ` +
      '(memory probe failed; check with top -o mem)'
    );
  }
  // The reading is read back from the shared ledger file: trust only a list.
  const top = reading.topConsumers?.processes;
  if (!Array.isArray(top) || top.length === 0) return reading.summary;
  const named = top.map((p) => `${p.command} pid ${p.pid} ${gib(p.footprintBytes)}`).join(', ');
  return (
    `${reading.summary}; largest memory users: ${named} ` +
    '(quit or restart them to free memory; check with top -o mem)'
  );
}
