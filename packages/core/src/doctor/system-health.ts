/**
 * `cleo doctor system`: what is hurting this machine, ranked, with the exact
 * remedy for each finding (T13435).
 *
 * On 2026-10-10 one Mac ran at 24 of 25 GB swap with load 24: 49 playwright-mcp,
 * 33 mcpvault and ~60 agentmbx stdio MCP servers (one set per harness session),
 * 475 dangling docker volumes from throwaway Postgres runs, long-lived database
 * containers, and full typechecks started outside `cleo run`. None of it was
 * visible from one place. This module makes it visible.
 *
 * Two halves, so the analysis is testable on any platform:
 * - {@link collectSystemSnapshot} reads the machine: one resource sample
 *   (reusing the governor's Darwin/Linux backends), one `ps`, the admission
 *   ledger, docker (each call time-boxed, skipped when absent) and the
 *   project's Spotlight/Time Machine state.
 * - {@link assessSystemHealth} is pure: snapshot in, ranked report out.
 *
 * Read-only. It never signals a process. A remedy that deletes data or stops a
 * process is marked `needsOwnerChoice` so the agent asks the owner first.
 *
 * @task T13435
 * @epic T13434
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { cpus, loadavg, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { readLedger } from '../resources/admission-ledger.js';
import type { ResourceSample } from '../resources/backend.js';
import { auditMemoryGuard, type MemoryGuardAudit } from '../resources/memory-guard.js';
import { classifyPressure, defaultResourceBackend } from '../resources/monitor.js';
import { looksHeavy } from '../resources/run-class.js';

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

/** How urgent a finding is. Findings are ranked by this, then by memory impact. */
export type SystemFindingSeverity = 'critical' | 'warning' | 'info';

/** One value in a finding's evidence. */
export type SystemEvidenceValue = string | number | boolean | null | readonly string[];

/** The fix for a finding. */
export interface SystemRemedy {
  /** The exact command to run, or `null` when the fix is a manual setting. */
  readonly command: string | null;
  /** What the remedy does, and what it costs. */
  readonly description: string;
}

/** One ranked, agent-relayable finding. */
export interface SystemFinding {
  /** Stable id, e.g. `mcp-fanout:playwright-mcp`. */
  readonly id: string;
  /** Which check produced it. */
  readonly category: SystemCheck;
  readonly severity: SystemFindingSeverity;
  /** One line for the owner. */
  readonly title: string;
  /** The measurements behind the verdict. */
  readonly evidence: Readonly<Record<string, SystemEvidenceValue>>;
  /** Resident memory the finding accounts for, in bytes, when known (ranking). */
  readonly impactBytes: number | null;
  readonly remedy: SystemRemedy | null;
  /** True when the remedy deletes data, stops work or changes machine settings: ask the owner. */
  readonly needsOwnerChoice: boolean;
}

/** The checks the report runs. */
export type SystemCheck =
  | 'memory'
  | 'mcp-fanout'
  | 'heavy-ungoverned'
  | 'containers'
  | 'sessions'
  | 'indexing'
  | 'memory-guard';

/** Whether a check ran. A missing finding means healthy only when its check is `ok`. */
export interface SystemCoverage {
  readonly check: SystemCheck;
  readonly status: 'ok' | 'skipped' | 'error';
  readonly reason?: string;
}

/** The `cleo doctor system` result. */
export interface SystemHealthReport {
  readonly platform: NodeJS.Platform;
  readonly sampledAt: string;
  readonly summary: { readonly critical: number; readonly warning: number; readonly info: number };
  /** Worst first. */
  readonly findings: readonly SystemFinding[];
  readonly coverage: readonly SystemCoverage[];
  /** Every agent session, quietest first (T13438). Quiet is not dead: ask, never close on it alone. */
  readonly sessions: readonly SessionInfo[];
}

/** One agent session (a top-level harness process and its tree). */
export interface SessionInfo {
  readonly pid: number;
  /** `claude`, `codex`, `opencode`, `kimi`, … */
  readonly harness: string;
  /** Git root of the session's working directory, or `null` when unknown. */
  readonly project: string | null;
  readonly cwd: string | null;
  readonly elapsedSec: number;
  /** RSS of the session and everything it started (MCP servers included), MiB. */
  readonly rssMib: number;
  /** The activity readings behind {@link quiet}; `null` where unmeasured. */
  readonly signals: SessionSignals;
  /**
   * True only when EVERY signal is quiet: terminal silent, no CPU time used
   * across a short second sample, no running child besides MCP servers, no
   * recent writes in its directory (T13460). A quiet session may still be
   * waiting on a plan or a person, so it is something to ask about, not close.
   */
  readonly quiet: boolean;
}

/** One session's activity readings (T13460). */
export interface SessionSignals {
  /** Seconds since its terminal last saw input or output; `null` without a tty. */
  readonly ttySilentSec: number | null;
  /** CPU seconds its process tree used between two samples; `null` when not sampled. */
  readonly cpuDeltaSec: number | null;
  /** Processes running under it other than MCP servers (tool calls, builds, shells). */
  readonly activeChildren: number;
  /** Seconds since the newest write in its cwd or git dir; `null` when unknown. */
  readonly lastWriteSec: number | null;
}

/** Per-session facts the collector reads beyond `ps` (T13438, T13460). */
export interface SessionContext {
  readonly cwd: string | null;
  readonly project: string | null;
  readonly ttyIdleSec: number | null;
  /** CPU seconds the session's tree used across the collector's two samples. */
  readonly cpuDeltaSec?: number | null;
  /** Seconds since the newest write in the session's cwd or git dir. */
  readonly lastWriteSec?: number | null;
}

// ---------------------------------------------------------------------------
// Snapshot (raw inputs)
// ---------------------------------------------------------------------------

/** Docker state, or `null` fields when a call failed. */
export interface DockerSnapshot {
  /** `docker volume ls -q -f dangling=true` output. */
  readonly danglingVolumes: string | null;
  /** `docker system df --format '{{json .}}'` output. */
  readonly systemDf: string | null;
  /** `docker ps --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.CreatedAt}}\t{{.Labels}}'` output. */
  readonly containers: string | null;
}

/** The project's indexing state (macOS). `null` fields were not measured. */
export interface IndexingSnapshot {
  /** The project root the checks looked at. */
  readonly projectRoot: string;
  /** `tmutil isexcluded <root>/node_modules` output, `null` when there is no node_modules. */
  readonly timeMachine: string | null;
  /** `mdfind -onlyin <root>/node_modules -count …` output. */
  readonly spotlightCount: string | null;
}

/** Everything {@link assessSystemHealth} needs, gathered by {@link collectSystemSnapshot}. */
export interface SystemSnapshot {
  readonly platform: NodeJS.Platform;
  readonly sampledAtMs: number;
  readonly totalMemBytes: number;
  readonly cpuCount: number;
  readonly loadAvg1: number;
  /** The governor's resource sample, or `null` when it could not be read. */
  readonly sample: ResourceSample | null;
  /** Linux swap from `/proc/meminfo`; macOS carries it on `sample.darwinMemory`. */
  readonly linuxSwap: { readonly usedBytes: number; readonly totalBytes: number } | null;
  /** `ps -A -o pid=,ppid=,pgid=,rss=,pcpu=,etime=,tty=,args=` output, `null` when ps failed. */
  readonly ps: string | null;
  /** Process groups and pids `cleo run` holds (the admission ledger). */
  readonly governedPgids: readonly number[];
  readonly governedPids: readonly number[];
  /** `null` when docker is not installed or its daemon did not answer. */
  readonly docker: DockerSnapshot | null;
  readonly indexing: IndexingSnapshot | null;
  /** Linux only. */
  readonly memoryGuard: MemoryGuardAudit | null;
  /** Keyed by session pid; absent entries are reported with unknown project and activity. */
  readonly sessionContext?: Readonly<Record<number, SessionContext>>;
}

// ---------------------------------------------------------------------------
// ps parsing
// ---------------------------------------------------------------------------

/** One `ps` row. */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly rssBytes: number;
  readonly pcpu: number;
  readonly elapsedSec: number;
  /** Controlling terminal (`ttys003`, `pts/2`), `null` when none. */
  readonly tty: string | null;
  readonly args: string;
  /** `args` split on whitespace (ps does not quote; good enough for recognition). */
  readonly argv: readonly string[];
}

/** `[[dd-]hh:]mm:ss` (both BSD and procps `etime`) to seconds. */
export function parseEtime(etime: string): number {
  const [days, rest] = etime.includes('-') ? etime.split('-', 2) : ['0', etime];
  const parts = (rest ?? '').split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts as [number, number, number];
  const total = Number(days) * 86400 + h * 3600 + m * 60 + s;
  return Number.isFinite(total) ? total : 0;
}

/** Parse `ps -A -o pid=,ppid=,pgid=,rss=,pcpu=,etime=,tty=,args=` output. */
export function parsePs(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const args = (m[8] as string).trim();
    const tty = m[7] as string;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      rssBytes: Number(m[4]) * 1024,
      pcpu: Number(m[5]),
      elapsedSec: parseEtime(m[6] as string),
      tty: /^(\?+|-)$/.test(tty) ? null : tty,
      args,
      argv: args.split(/\s+/),
    });
  }
  return rows;
}

function basename(token: string): string {
  return token.split('/').pop() ?? token;
}

const INTERPRETERS = /^(node|nodejs|bun|deno|python3?)$/;

/**
 * The command words with the interpreter dropped and the script's extension
 * stripped: `node …/typescript/bin/tsc -b` → `['tsc', '-b']`.
 */
export function commandWords(argv: readonly string[]): string[] {
  const words = withoutInterpreter(argv);
  if (words[0] !== undefined) words[0] = basename(words[0]).replace(/\.(m?js|cjs|ts)$/, '');
  return words;
}

function withoutInterpreter(argv: readonly string[]): string[] {
  const first = argv[0];
  return argv.length > 1 && first !== undefined && INTERPRETERS.test(basename(first))
    ? argv.slice(1)
    : [...argv];
}

// ---------------------------------------------------------------------------
// Process tree helpers
// ---------------------------------------------------------------------------

interface Tree {
  readonly byPid: ReadonlyMap<number, ProcessRow>;
  readonly children: ReadonlyMap<number, readonly ProcessRow[]>;
}

function buildTree(rows: readonly ProcessRow[]): Tree {
  const byPid = new Map<number, ProcessRow>();
  const children = new Map<number, ProcessRow[]>();
  for (const r of rows) {
    byPid.set(r.pid, r);
    const list = children.get(r.ppid) ?? [];
    list.push(r);
    children.set(r.ppid, list);
  }
  return { byPid, children };
}

/** Ancestors of `row`, nearest first (cycle-safe, stops at pid 1). */
function ancestors(tree: Tree, row: ProcessRow): ProcessRow[] {
  const out: ProcessRow[] = [];
  const seen = new Set<number>([row.pid]);
  let cur = tree.byPid.get(row.ppid);
  while (cur && !seen.has(cur.pid) && cur.pid > 1) {
    out.push(cur);
    seen.add(cur.pid);
    cur = tree.byPid.get(cur.ppid);
  }
  return out;
}

/** `row` and every descendant (cycle-safe). */
function subtree(tree: Tree, row: ProcessRow): ProcessRow[] {
  const out: ProcessRow[] = [];
  const seen = new Set<number>();
  const stack = [row];
  while (stack.length > 0) {
    const cur = stack.pop() as ProcessRow;
    if (seen.has(cur.pid)) continue;
    seen.add(cur.pid);
    out.push(cur);
    stack.push(...(tree.children.get(cur.pid) ?? []));
  }
  return out;
}

const sumRss = (rows: readonly ProcessRow[]): number => rows.reduce((n, r) => n + r.rssBytes, 0);
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const mib = (bytes: number): number => Math.round(bytes / MIB);
const gib = (bytes: number): number => Math.round((bytes / GIB) * 10) / 10;

// ---------------------------------------------------------------------------
// Process classification
// ---------------------------------------------------------------------------

const HARNESSES = new Set(['claude', 'codex', 'opencode', 'kimi', 'kimi-code', 'gemini', 'aider']);
/** Harness binaries started as helpers or servers, not as agent sessions. */
const HARNESS_HELPER_ARGS = /--chrome-native-host|\b(app|exec)-server\b|\bserve\b|\bmcp\b/;

/** An interactive agent session (claude, codex, opencode, kimi, …). */
export function isHarnessSession(row: ProcessRow): boolean {
  const words = commandWords(row.argv);
  return HARNESSES.has(words[0] ?? '') && !HARNESS_HELPER_ARGS.test(row.args);
}

/**
 * The MCP server a process runs, or `null` when it is not one. Recognised by
 * `mcp` in the command or script name (`playwright-mcp`, `mcpvault`,
 * `agentmbx mcp`, `railway mcp`, `…/axiom-qa-mcp/dist/server.js`).
 */
export function mcpServerName(row: ProcessRow): string | null {
  const words = commandWords(row.argv);
  // `npx -y @playwright/mcp@latest`, `uvx mcp-server-fetch`: the package names the server.
  const pkg = launchedPackage(words);
  if (pkg !== undefined) {
    if (pkg === null) return null;
    // `npx -y agentmbx mcp`: an `mcp` subcommand marks a server too.
    const next = words[words.findIndex((w) => w.startsWith(pkg)) + 1];
    return /mcp/i.test(pkg) || next === 'mcp' ? pkg : null;
  }
  if (
    !withoutInterpreter(row.argv)
      .slice(0, 3)
      .some((w) => /mcp/i.test(w))
  )
    return null;
  // Harness self-invocations (`claude mcp serve`) are not per-session servers.
  if (HARNESSES.has(words[0] ?? '')) return null;
  const first = words[0] ?? '';
  // A generic entry file names nothing: use the package directory above it.
  if (/^(index|server|main|cli|serve)$/.test(first)) {
    const script =
      row.argv.find((w) => /\/(index|server|main|cli|serve)\.(m?js|cjs|ts)$/.test(w)) ?? '';
    const dirs = script.split('/').slice(0, -1);
    const pkg = [...dirs]
      .reverse()
      .find((d) => d !== '' && !/^(dist|build|bin|lib|src|\.)$/.test(d));
    return pkg ?? first;
  }
  return first;
}

const LAUNCHERS = new Set(['npx', 'pnpx', 'bunx', 'uvx']);
const PM_LAUNCH = /^(npm|pnpm|yarn|bun)$/;
const PM_LAUNCH_SUB = new Set(['exec', 'dlx', 'x']);
/** Launcher flags that take a separate value. */
const LAUNCHER_VALUE_FLAGS = new Set([
  '--package',
  '-p',
  '--from',
  '--with',
  '--python',
  '--call',
  '-c',
  '--spec',
]);

/**
 * The package a launcher runs (`npx -y @playwright/mcp@latest` → `@playwright/mcp`),
 * `null` when a launcher names none, `undefined` when `words` is not a launcher.
 * The scope is kept (`@a/mcp` and `@b/mcp` are different servers); the version is not.
 */
export function launchedPackage(words: readonly string[]): string | null | undefined {
  const [head = '', sub = ''] = words;
  let rest: readonly string[];
  if (LAUNCHERS.has(head)) rest = words.slice(1);
  else if (head === 'pipx' && sub === 'run') rest = words.slice(2);
  else if (PM_LAUNCH.test(head) && PM_LAUNCH_SUB.has(sub)) rest = words.slice(2);
  else return undefined;
  let pkg: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i] as string;
    if (w === '--') continue;
    if (w.startsWith('-')) {
      // `npx --package foo bin`, `uvx --from git+… srv`: the flag's value is not the server.
      if (LAUNCHER_VALUE_FLAGS.has(w)) i++;
      continue;
    }
    pkg = w;
    break;
  }
  if (pkg === undefined) return null;
  return pkg.replace(/(.)@[^/]*$/, '$1').replace(/==.*$/, '');
}

/** Single-quote `value` for a POSIX shell. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Long-lived tool servers `looksHeavy` would otherwise count (`biome lsp-proxy`, `esbuild --service`). */
const SERVER_ARGS = /\blsp-proxy\b|__run_server|--stdio\b|\blsp\b|--watch\b|--service\b/;

/** Whether `row` is a governed `cleo run` (or the heavy-run script). */
function isGovernor(row: ProcessRow): boolean {
  const words = commandWords(row.argv);
  if ((words[0] === 'cleo' || words[0] === 'ct') && words[1] === 'run') return true;
  return row.args.includes('.cleo-heavy/run.sh');
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

type Finding = SystemFinding;

function memoryFindings(s: SystemSnapshot, rows: readonly ProcessRow[]): Finding[] {
  const out: Finding[] = [];
  const top = [...rows]
    .sort((a, b) => b.rssBytes - a.rssBytes)
    .slice(0, 5)
    .map((r) => `${commandWords(r.argv)[0] ?? '?'} pid ${r.pid} ${mib(r.rssBytes)} MiB`);

  if (s.sample) {
    const { state, reason } = classifyPressure(s.sample);
    if (state !== 'ok') {
      out.push({
        id: 'memory-pressure',
        category: 'memory',
        severity: state === 'backoff' ? 'critical' : 'warning',
        title: `Memory pressure is ${state === 'backoff' ? 'severe' : 'elevated'}: cleo run is holding heavy jobs`,
        evidence: { state, reason, topProcesses: top },
        impactBytes: null,
        remedy: {
          command: null,
          description:
            'Free memory by acting on the findings below (quiet sessions the owner no longer needs, MCP fan-out, ungoverned heavy jobs, containers), largest first.',
        },
        needsOwnerChoice: false,
      });
    }
  }

  const swap =
    s.sample?.darwinMemory?.swapTotalBytes != null && s.sample.darwinMemory.swapUsedBytes != null
      ? {
          usedBytes: s.sample.darwinMemory.swapUsedBytes,
          totalBytes: s.sample.darwinMemory.swapTotalBytes,
        }
      : s.linuxSwap;
  if (swap && swap.totalBytes > 0) {
    const ratio = swap.usedBytes / swap.totalBytes;
    // macOS grows swap on demand, so also weigh swap against RAM.
    const ofRam = swap.usedBytes / s.totalMemBytes;
    if (ratio >= 0.6 || ofRam >= 0.25) {
      out.push({
        id: 'swap',
        category: 'memory',
        severity: ratio >= 0.9 || ofRam >= 0.5 ? 'critical' : 'warning',
        title: `Swap is ${Math.round(ratio * 100)}% used (${gib(swap.usedBytes)} of ${gib(swap.totalBytes)} GiB)`,
        evidence: {
          swapUsedGib: gib(swap.usedBytes),
          swapTotalGib: gib(swap.totalBytes),
          swapOfRamPercent: Math.round(ofRam * 100),
          topProcesses: top,
        },
        impactBytes: swap.usedBytes,
        remedy: {
          command: null,
          description:
            'Swap drains only when resident memory falls: close what the findings below name. A reboot clears it but ends every session.',
        },
        needsOwnerChoice: false,
      });
    }
  }

  const perCore = s.cpuCount > 0 ? s.loadAvg1 / s.cpuCount : 0;
  if (perCore >= 1.5) {
    out.push({
      id: 'cpu-load',
      category: 'memory',
      severity: perCore >= 3 ? 'critical' : 'warning',
      title: `Load ${s.loadAvg1.toFixed(1)} on ${s.cpuCount} cores (${perCore.toFixed(1)} per core)`,
      evidence: { loadAvg1: Math.round(s.loadAvg1 * 10) / 10, cpuCount: s.cpuCount },
      impactBytes: null,
      remedy: {
        command: null,
        description:
          'Run heavy work one at a time through `cleo run --wait`; see ungoverned heavy jobs below.',
      },
      needsOwnerChoice: false,
    });
  }
  return out;
}

/** Servers with at least this many copies are flagged. */
const MCP_FANOUT_WARN = 6;

/**
 * Servers whose owners asked for a specific remedy instead of the generic
 * "scope it to projects" one. agentmbx: its leases are tied to the processes,
 * so never suggest killing them (agentmbx-lead, 2026-10-10; their T487/T488).
 */
const KNOWN_MCP_REMEDIES: Readonly<
  Record<string, { remedy: SystemRemedy; needsOwnerChoice: boolean }>
> = {
  agentmbx: {
    remedy: {
      command: 'agentmbx doctor',
      description:
        'One stdio agentmbx per session is by design, and its leases are tied to those processes: never kill them. ' +
        'Upgrade agentmbx to the release that ships T487/T488 (pending), which removes duplicate and orphaned processes. ' +
        '`agentmbx doctor` reports stale MCP rows. Restart idle harness sessions you no longer need.',
    },
    // upgrading and restarting sessions are the owner's actions
    needsOwnerChoice: true,
  },
};

/**
 * Whether an MCP outside every session was left behind: re-parented to init
 * (pid 1, launchd) or to a Linux user manager (`systemd --user`) once its
 * session exited.
 */
function isOrphanParent(parent: ProcessRow | undefined, ppid: number): boolean {
  if (ppid <= 1 || parent === undefined) return true;
  return /^(systemd|launchd|init)$/.test(commandWords(parent.argv)[0] ?? '');
}

function mcpFindings(tree: Tree, rows: readonly ProcessRow[]): Finding[] {
  const sessions = harnessSessions(rows);
  const sessionOf = new Map<number, number>();
  for (const sess of sessions) for (const r of subtree(tree, sess)) sessionOf.set(r.pid, sess.pid);
  const groups = new Map<
    string,
    { count: number; rss: number; pids: number[]; sessions: Set<number>; orphans: number }
  >();
  for (const r of rows) {
    const name = mcpServerName(r);
    if (name === null) continue;
    // Count a wrapper (`npm exec` → `node … mcp`) once: skip a server under another server.
    const parent = tree.byPid.get(r.ppid);
    if (parent && mcpServerName(parent) !== null) continue;
    const g = groups.get(name) ?? { count: 0, rss: 0, pids: [], sessions: new Set(), orphans: 0 };
    g.count++;
    g.rss += sumRss(subtree(tree, r));
    if (g.pids.length < 10) g.pids.push(r.pid);
    const sess = sessionOf.get(r.pid);
    if (sess !== undefined) g.sessions.add(sess);
    else if (isOrphanParent(tree.byPid.get(r.ppid), r.ppid)) g.orphans++;
    groups.set(name, g);
  }
  const out: Finding[] = [];
  for (const [name, g] of groups) {
    if (g.count < MCP_FANOUT_WARN) continue;
    const everySession = sessions.length >= 2 && g.sessions.size === sessions.length;
    const known = KNOWN_MCP_REMEDIES[name];
    out.push({
      id: `mcp-fanout:${name}`,
      category: 'mcp-fanout',
      severity: g.count >= 20 || g.rss >= 2 * GIB ? 'warning' : 'info',
      title:
        `${g.count} copies of MCP server ${name} (${mib(g.rss)} MiB) in ${g.sessions.size} of ${sessions.length} sessions` +
        (g.orphans > 0 ? `, ${g.orphans} orphaned` : ''),
      evidence: {
        server: name,
        processes: g.count,
        rssMib: mib(g.rss),
        perProcessMib: mib(g.rss / g.count),
        sessionsWithServer: g.sessions.size,
        sessionsTotal: sessions.length,
        inEverySession: everySession,
        orphans: g.orphans,
        samplePids: g.pids.map(String),
      },
      impactBytes: g.rss,
      remedy: known?.remedy ?? {
        command: `claude mcp remove ${name} --scope user`,
        description:
          `${everySession ? 'Every' : 'Each'} harness session starts its own stdio copy, whether or not it calls the server ` +
          '(the doctor cannot see tool calls). ' +
          `If ${name} is not needed in every session, remove it from user scope and add it to only the projects that use it ` +
          '(`claude mcp add … --scope project`); the name may differ in the harness config (`claude mcp list`). ' +
          'Restarting sessions applies it. Servers with a shared-daemon mode should use one daemon per machine instead.',
      },
      needsOwnerChoice: known?.needsOwnerChoice ?? true,
    });
  }
  return out;
}

function heavyFindings(s: SystemSnapshot, tree: Tree, rows: readonly ProcessRow[]): Finding[] {
  const governedPgids = new Set(s.governedPgids);
  const governedPids = new Set(s.governedPids);
  const isHeavy = (r: ProcessRow): boolean =>
    !SERVER_ARGS.test(r.args) && looksHeavy(commandWords(r.argv));
  const ungoverned = rows.filter((r) => {
    if (!isHeavy(r) || governedPgids.has(r.pgid) || governedPids.has(r.pid)) return false;
    const up = ancestors(tree, r);
    if (up.some((a) => isGovernor(a) || governedPids.has(a.pid))) return false;
    // Report the root of a heavy tree once (pnpm → vitest → workers).
    return !up.some(isHeavy);
  });
  return ungoverned.map((r) => {
    const rss = sumRss(subtree(tree, r));
    return {
      id: `heavy-ungoverned:${r.pid}`,
      category: 'heavy-ungoverned' as const,
      severity: rss >= 4 * GIB ? ('critical' as const) : ('warning' as const),
      title: `Heavy job outside cleo run: ${commandWords(r.argv).slice(0, 4).join(' ')} (${mib(rss)} MiB)`,
      evidence: {
        pid: r.pid,
        command: r.args.slice(0, 300),
        rssMib: mib(rss),
        elapsedSec: r.elapsedSec,
      },
      impactBytes: rss,
      remedy: {
        command: 'cleo doctor heavy-command-hook --fix',
        description:
          'Runs in the project that started it: installs the hook that routes agent-run tests, builds and typechecks through ' +
          '`cleo run --wait`. Re-run the job as `cleo run --wait --class <test|build|full-build> -- <cmd>`. ' +
          'Stopping the running job is the owner’s call.',
      },
      needsOwnerChoice: false,
    };
  });
}

const DB_IMAGES = /^(postgres|postgis|timescaledb|mysql|mariadb|redis|valkey|mongo|clickhouse)/;
/** A database container not managed by compose and up this long is probably a forgotten throwaway. */
const THROWAWAY_AGE_SEC = 12 * 3600;

/** `2026-10-10 10:23:54 -0700 PDT` (docker CreatedAt) to epoch ms, `NaN` when unparseable. */
export function parseDockerCreatedAt(value: string): number {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})/.exec(value.trim());
  return m ? Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`) : Number.NaN;
}

/** Docker's human sizes (`52.3GB`, `16.38kB`, `0B`) to bytes. */
export function parseDockerSize(value: string): number {
  const m = /^([\d.]+)\s*([kMGT]?B)/.exec(value.trim());
  if (!m) return 0;
  const unit = { B: 1, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2] as string] ?? 1;
  return Math.round(Number(m[1]) * unit);
}

function containerFindings(s: SystemSnapshot, docker: DockerSnapshot): Finding[] {
  const out: Finding[] = [];
  const dangling = (docker.danglingVolumes ?? '').split('\n').filter((l) => l.trim() !== '');
  const df = new Map<string, { reclaimable: number; size: number }>();
  for (const line of (docker.systemDf ?? '').split('\n')) {
    try {
      const row = JSON.parse(line) as { Type?: string; Reclaimable?: string; Size?: string };
      if (row.Type)
        df.set(row.Type, {
          reclaimable: parseDockerSize(row.Reclaimable ?? '0B'),
          size: parseDockerSize(row.Size ?? '0B'),
        });
    } catch {
      // not a JSON line
    }
  }
  const volumes = df.get('Local Volumes');
  if (dangling.length >= 10 || (volumes?.reclaimable ?? 0) >= 5e9) {
    out.push({
      id: 'docker-dangling-volumes',
      category: 'containers',
      severity: dangling.length >= 100 || (volumes?.reclaimable ?? 0) >= 20e9 ? 'warning' : 'info',
      title: `${dangling.length} anonymous dangling docker volumes (${gib(volumes?.reclaimable ?? 0)} GB reclaimable)`,
      evidence: {
        danglingVolumes: dangling.length,
        reclaimableBytes: volumes?.reclaimable ?? null,
      },
      impactBytes: null,
      remedy: {
        command: 'docker volume prune --force',
        description:
          'Removes anonymous volumes no container uses (Docker 23+ keeps named volumes unless `--all`). ' +
          'Their data is gone. Throwaway runs should use `docker run --rm` so none are left.',
      },
      needsOwnerChoice: true,
    });
  }
  const cache = df.get('Build Cache');
  if ((cache?.reclaimable ?? 0) >= 10e9) {
    out.push({
      id: 'docker-build-cache',
      category: 'containers',
      severity: 'info',
      title: `${gib(cache?.reclaimable ?? 0)} GB of docker build cache is reclaimable`,
      evidence: { reclaimableBytes: cache?.reclaimable ?? null },
      impactBytes: null,
      remedy: { command: 'docker builder prune --force', description: 'Next builds start cold.' },
      needsOwnerChoice: true,
    });
  }

  const stale: string[] = [];
  for (const line of (docker.containers ?? '').split('\n')) {
    const [id, name, image, createdAt, labels = ''] = line.split('\t');
    if (!id || !name || !image || !createdAt) continue;
    const repo = basename(image.split(':')[0] ?? '');
    if (!DB_IMAGES.test(repo) || labels.includes('com.docker.compose.project=')) continue;
    const ageSec = (s.sampledAtMs - parseDockerCreatedAt(createdAt)) / 1000;
    if (ageSec >= THROWAWAY_AGE_SEC)
      stale.push(`${name} (${image}, created ${Math.round(ageSec / 3600)}h ago)`);
  }
  if (stale.length > 0) {
    out.push({
      id: 'docker-long-running-db',
      category: 'containers',
      severity: stale.length >= 5 ? 'warning' : 'info',
      title: `${stale.length} running database containers outside compose, created over ${THROWAWAY_AGE_SEC / 3600}h ago`,
      evidence: { containers: stale.slice(0, 20) },
      impactBytes: null,
      remedy: {
        command: `docker rm -f ${stale.map((c) => c.split(' ')[0]).join(' ')}`,
        description:
          'Stops and removes them, and their anonymous volumes become dangling. Keep any that hold data someone still needs.',
      },
      needsOwnerChoice: true,
    });
  }
  return out;
}

/** Terminal silence and directory writes older than this count as quiet (T13438). */
export const SESSION_QUIET_SEC = 3600;
/** CPU seconds across the second sample above which a session is working. */
const ACTIVE_CPU_DELTA_SEC = 0.05;
/** Without a second sample, tree `%cpu` at or above this is working. */
const ACTIVE_PCPU = 1;

/** Top-level agent sessions: harness processes with no harness above them. */
export function harnessSessions(rows: readonly ProcessRow[]): ProcessRow[] {
  const tree = buildTree(rows);
  return rows.filter((r) => isHarnessSession(r) && !ancestors(tree, r).some(isHarnessSession));
}

/** Processes under `session` that are not MCP servers or inside one. */
function activeChildren(tree: Tree, session: ProcessRow): number {
  let count = 0;
  const stack = [...(tree.children.get(session.pid) ?? [])];
  const seen = new Set<number>([session.pid]);
  while (stack.length > 0) {
    const r = stack.pop() as ProcessRow;
    // MCP servers, and wrappers that only launched one (`npm exec …` → `node … mcp`), are not work.
    const wrapper = (tree.children.get(r.pid) ?? []).some((c) => mcpServerName(c) !== null);
    if (seen.has(r.pid) || mcpServerName(r) !== null || wrapper) continue;
    seen.add(r.pid);
    count++;
    stack.push(...(tree.children.get(r.pid) ?? []));
  }
  return count;
}

/** Quiet only when no signal shows activity; terminal silence alone never decides (T13460). */
export function isQuiet(signals: SessionSignals, treePcpu: number): boolean {
  const ttyQuiet = signals.ttySilentSec === null || signals.ttySilentSec >= SESSION_QUIET_SEC;
  const cpuQuiet =
    signals.cpuDeltaSec !== null
      ? signals.cpuDeltaSec <= ACTIVE_CPU_DELTA_SEC
      : treePcpu < ACTIVE_PCPU;
  const writesQuiet = signals.lastWriteSec === null || signals.lastWriteSec >= SESSION_QUIET_SEC;
  return ttyQuiet && cpuQuiet && signals.activeChildren === 0 && writesQuiet;
}

function describeSessions(
  tree: Tree,
  rows: readonly ProcessRow[],
  context: Readonly<Record<number, SessionContext>>,
): SessionInfo[] {
  return harnessSessions(rows)
    .map((r) => {
      const all = subtree(tree, r);
      const ctx = context[r.pid];
      const signals: SessionSignals = {
        ttySilentSec: ctx?.ttyIdleSec ?? null,
        cpuDeltaSec: ctx?.cpuDeltaSec ?? null,
        activeChildren: activeChildren(tree, r),
        lastWriteSec: ctx?.lastWriteSec ?? null,
      };
      return {
        pid: r.pid,
        harness: commandWords(r.argv)[0] ?? '?',
        project: ctx?.project ?? null,
        cwd: ctx?.cwd ?? null,
        elapsedSec: r.elapsedSec,
        rssMib: mib(sumRss(all)),
        signals,
        quiet: isQuiet(
          signals,
          all.reduce((n, x) => n + x.pcpu, 0),
        ),
      };
    })
    .sort(
      (a, b) =>
        Number(b.quiet) - Number(a.quiet) ||
        (b.signals.ttySilentSec ?? -1) - (a.signals.ttySilentSec ?? -1) ||
        b.rssMib - a.rssMib,
    );
}

const hours = (sec: number): string => `${Math.round((sec / 3600) * 10) / 10}h`;
const projectName = (s: SessionInfo): string =>
  s.project === null ? '(unknown project)' : basename(s.project);

function describeSignals(m: SessionInfo): string {
  const s = m.signals;
  return [
    s.ttySilentSec === null ? 'no tty' : `tty silent ${hours(s.ttySilentSec)}`,
    s.cpuDeltaSec === null ? 'cpu unsampled' : `cpu ${s.cpuDeltaSec.toFixed(2)}s/sample`,
    `${s.activeChildren} children`,
    s.lastWriteSec === null ? 'writes unknown' : `last write ${hours(s.lastWriteSec)} ago`,
  ].join(', ');
}

function sessionFindings(sessions: readonly SessionInfo[]): Finding[] {
  if (sessions.length === 0) return [];
  const quiet = sessions.filter((m) => m.quiet);
  const totalMib = sessions.reduce((n, m) => n + m.rssMib, 0);
  const quietMib = quiet.reduce((n, m) => n + m.rssMib, 0);
  const byProject = new Map<string, { count: number; quiet: number; mib: number }>();
  for (const m of sessions) {
    const g = byProject.get(projectName(m)) ?? { count: 0, quiet: 0, mib: 0 };
    g.count++;
    g.quiet += m.quiet ? 1 : 0;
    g.mib += m.rssMib;
    byProject.set(projectName(m), g);
  }
  const severity: SystemFindingSeverity =
    quietMib >= 8 * 1024 || quiet.length >= 15 ? 'warning' : 'info';
  return [
    {
      id: 'sessions',
      category: 'sessions',
      severity,
      title: `${sessions.length} agent sessions across ${byProject.size} projects (${gib(totalMib * MIB)} GiB with their MCP servers); ${quiet.length} quiet hold ${gib(quietMib * MIB)} GiB`,
      evidence: {
        sessions: sessions.length,
        quiet: quiet.length,
        totalRssMib: totalMib,
        quietRssMib: quietMib,
        byProject: [...byProject]
          .sort((a, b) => b[1].mib - a[1].mib)
          .map(([name, g]) => `${name}: ${g.count} sessions (${g.quiet} quiet), ${g.mib} MiB`),
        quietSessions: quiet
          .slice(0, 20)
          .map(
            (m) =>
              `${projectName(m)} ${m.harness} pid ${m.pid} up ${hours(m.elapsedSec)}, ${m.rssMib} MiB (${describeSignals(m)})`,
          ),
      },
      impactBytes: quietMib * MIB,
      remedy: {
        command: null,
        description:
          'Quiet is not dead: a session waiting on a plan, a reviewer or the owner looks the same. ' +
          'Ask the owner (ask tool, one option per session) whether each quiet session in `sessions[]` is still needed; ' +
          'they close any they no longer need from their own terminal or Orca pane. Nothing is closed automatically.',
      },
      needsOwnerChoice: quiet.length > 0,
    },
  ];
}

function indexingFindings(
  rows: readonly ProcessRow[],
  indexing: IndexingSnapshot | null,
): Finding[] {
  const out: Finding[] = [];
  for (const r of rows) {
    const name = commandWords(r.argv)[0] ?? '';
    if (!/^(mds_stores|mdworker_shared|backupd|baloo_file|tracker-miner-fs-3?)$/.test(name))
      continue;
    if (r.pcpu < 50) continue;
    out.push({
      id: `indexing-cpu:${name}:${r.pid}`,
      category: 'indexing',
      severity: 'warning',
      title: `${name} is using ${Math.round(r.pcpu)}% CPU`,
      evidence: { pid: r.pid, pcpu: r.pcpu, rssMib: mib(r.rssBytes) },
      impactBytes: r.rssBytes,
      remedy: {
        command: null,
        description:
          'Indexing or backup is churning, usually over node_modules, build output or worktrees. Exclude code directories (see below).',
      },
      needsOwnerChoice: false,
    });
  }
  if (!indexing) return out;
  const nodeModules = join(indexing.projectRoot, 'node_modules');
  if (indexing.timeMachine?.trimStart().startsWith('[Included]')) {
    out.push({
      id: 'time-machine-node-modules',
      category: 'indexing',
      severity: 'info',
      title: 'Time Machine backs up this project’s node_modules',
      evidence: { path: nodeModules },
      impactBytes: null,
      remedy: {
        command: `tmutil addexclusion ${shellQuote(nodeModules)}`,
        description:
          'A sticky exclusion on the directory; it is reinstallable, so nothing of value is lost. ' +
          'It changes the owner’s backup settings, so ask first.',
      },
      needsOwnerChoice: true,
    });
  }
  const count = Number((indexing.spotlightCount ?? '').trim());
  if (Number.isFinite(count) && count > 0) {
    out.push({
      id: 'spotlight-node-modules',
      category: 'indexing',
      severity: 'info',
      title: `Spotlight indexes this project’s node_modules (${count} package.json files indexed)`,
      evidence: { path: nodeModules, indexedPackageJson: count },
      impactBytes: null,
      remedy: {
        command: null,
        description: `Add ${indexing.projectRoot} (or its parent code directory) under System Settings > Siri & Spotlight > Spotlight Privacy.`,
      },
      needsOwnerChoice: true,
    });
  }
  return out;
}

function memoryGuardFindings(audit: MemoryGuardAudit): Finding[] {
  if (!audit.supported || audit.guarded) return [];
  return [
    {
      id: 'memory-guard',
      category: 'memory-guard',
      severity: 'warning',
      title: 'No cgroup memory limit bounds agent-run test commands',
      evidence: {
        memoryHighGib: audit.memoryHighGib,
        recommendedHighGib: audit.recommendedHighGib,
        findings: audit.findings.filter((f) => f.severity !== 'ok').map((f) => f.summary),
      },
      impactBytes: null,
      remedy: {
        command: 'cleo doctor memory-guard --fix',
        description:
          'Applies MemoryHigh/MemoryMax to app.slice: a systemd drop-in that affects the whole desktop session.',
      },
      needsOwnerChoice: true,
    },
  ];
}

const SEVERITY_RANK: Record<SystemFindingSeverity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * Turn a snapshot into a ranked report. Pure: no I/O.
 *
 * @param s - the raw machine state from {@link collectSystemSnapshot}.
 * @returns findings worst first, plus which checks ran.
 *
 * @example
 * ```ts
 * const report = assessSystemHealth(await collectSystemSnapshot({ projectRoot }));
 * for (const f of report.findings) console.error(f.severity, f.title, f.remedy?.command);
 * ```
 *
 * @task T13435
 */
export function assessSystemHealth(s: SystemSnapshot): SystemHealthReport {
  const coverage: SystemCoverage[] = [];
  const findings: Finding[] = [];
  const rows = s.ps === null ? [] : parsePs(s.ps);
  const tree = buildTree(rows);
  const psCoverage = (check: SystemCheck): SystemCoverage =>
    s.ps === null ? { check, status: 'error', reason: 'ps failed' } : { check, status: 'ok' };

  findings.push(...memoryFindings(s, rows));
  coverage.push(
    s.sample === null
      ? {
          check: 'memory',
          status: 'error',
          reason: 'resource sample unavailable; swap and load only',
        }
      : { check: 'memory', status: 'ok' },
  );

  const sessions = describeSessions(tree, rows, s.sessionContext ?? {});
  if (s.ps !== null) {
    findings.push(
      ...mcpFindings(tree, rows),
      ...heavyFindings(s, tree, rows),
      ...sessionFindings(sessions),
    );
  }
  coverage.push(psCoverage('mcp-fanout'), psCoverage('heavy-ungoverned'), psCoverage('sessions'));

  if (s.docker === null) {
    coverage.push({
      check: 'containers',
      status: 'skipped',
      reason: 'docker not installed or not running',
    });
  } else {
    findings.push(...containerFindings(s, s.docker));
    coverage.push({ check: 'containers', status: 'ok' });
  }

  findings.push(...indexingFindings(rows, s.indexing));
  coverage.push(
    s.indexing === null
      ? {
          check: 'indexing',
          status: 'skipped',
          reason:
            s.platform === 'darwin'
              ? 'no project root'
              : 'Spotlight/Time Machine are macOS-only; indexer CPU still checked',
        }
      : { check: 'indexing', status: 'ok' },
  );

  if (s.memoryGuard?.supported) {
    findings.push(...memoryGuardFindings(s.memoryGuard));
    coverage.push({ check: 'memory-guard', status: 'ok' });
  } else {
    coverage.push({ check: 'memory-guard', status: 'skipped', reason: 'Linux cgroup v2 only' });
  }

  findings.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (b.impactBytes ?? 0) - (a.impactBytes ?? 0),
  );
  const count = (sev: SystemFindingSeverity): number =>
    findings.filter((f) => f.severity === sev).length;
  return {
    platform: s.platform,
    sampledAt: new Date(s.sampledAtMs).toISOString(),
    summary: { critical: count('critical'), warning: count('warning'), info: count('info') },
    findings,
    coverage,
    sessions,
  };
}

// ---------------------------------------------------------------------------
// Collection (I/O)
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

/** The `ps` columns {@link parsePs} reads. */
const PS_FORMAT = 'pid=,ppid=,pgid=,rss=,pcpu=,etime=,tty=,args=';

/**
 * Run a read-only command, time-boxed. `null` on any failure (absent, timeout,
 * non-zero). With `keepStdoutOnExit`, a non-zero exit that still printed
 * returns what it printed: `lsof -p a,b` exits 1 when one pid has vanished but
 * still reports the others.
 *
 * @task T13435
 */
export async function runReadOnly(
  cmd: string,
  args: readonly string[],
  opts: { readonly timeoutMs?: number; readonly keepStdoutOnExit?: boolean } = {},
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, [...args], {
      timeout: opts.timeoutMs ?? 5000,
      maxBuffer: 32 * MIB,
      encoding: 'utf8',
    });
    return stdout;
  } catch (err) {
    const exited = err instanceof Error && 'code' in err && typeof err.code === 'number';
    const stdout = err instanceof Error && 'stdout' in err ? err.stdout : undefined;
    return opts.keepStdoutOnExit === true && exited && typeof stdout === 'string' && stdout !== ''
      ? stdout
      : null;
  }
}

const run = (cmd: string, args: readonly string[]): Promise<string | null> =>
  runReadOnly(cmd, args);

/** Linux swap from `/proc/meminfo`, `null` when unreadable. */
export function parseLinuxSwap(meminfo: string): { usedBytes: number; totalBytes: number } | null {
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm').exec(meminfo);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb('SwapTotal');
  const free = kb('SwapFree');
  return total === null || free === null ? null : { usedBytes: total - free, totalBytes: total };
}

/** Options for {@link collectSystemSnapshot}. */
export interface CollectSystemSnapshotOptions {
  /** The project to check Spotlight/Time Machine for; `null` skips those checks. */
  readonly projectRoot: string | null;
}

/**
 * Read the machine for {@link assessSystemHealth}. Read-only, never throws:
 * a failed source leaves its field `null` and the report marks the check.
 *
 * @task T13435
 */
export async function collectSystemSnapshot(
  opts: CollectSystemSnapshotOptions,
): Promise<SystemSnapshot> {
  const platform = process.platform;
  const sample = await defaultResourceBackend(platform)
    .sample()
    .catch(() => null);
  let linuxSwap: SystemSnapshot['linuxSwap'] = null;
  if (platform === 'linux') {
    try {
      linuxSwap = parseLinuxSwap(readFileSync('/proc/meminfo', 'utf8'));
    } catch {
      linuxSwap = null;
    }
  }

  let governedPgids: number[] = [];
  let governedPids: number[] = [];
  try {
    const ledger = readLedger();
    governedPids = ledger.map((e) => e.pid);
    governedPgids = ledger.flatMap((e) => [...e.toolGroups]);
  } catch {
    // no ledger: every heavy job is judged by its ancestry alone
  }

  const [ps, danglingVolumes, systemDf, containers] = await Promise.all([
    run('ps', ['-A', '-o', PS_FORMAT]),
    run('docker', ['volume', 'ls', '-q', '-f', 'dangling=true']),
    run('docker', ['system', 'df', '--format', '{{json .}}']),
    run('docker', [
      'ps',
      '--format',
      '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.CreatedAt}}\t{{.Labels}}',
    ]),
  ]);
  const docker =
    danglingVolumes === null && systemDf === null && containers === null
      ? null
      : { danglingVolumes, systemDf, containers };

  let indexing: IndexingSnapshot | null = null;
  if (platform === 'darwin' && opts.projectRoot !== null) {
    const nodeModules = join(opts.projectRoot, 'node_modules');
    const present = existsSync(nodeModules);
    const [timeMachine, spotlightCount] = present
      ? await Promise.all([
          run('tmutil', ['isexcluded', nodeModules]),
          run('mdfind', ['-onlyin', nodeModules, '-count', 'kMDItemFSName == "package.json"']),
        ])
      : [null, null];
    indexing = { projectRoot: opts.projectRoot, timeMachine, spotlightCount };
  }

  const sessionContext = ps === null ? {} : await collectSessionContext(platform, parsePs(ps));

  return {
    platform,
    sampledAtMs: Date.now(),
    totalMemBytes: totalmem(),
    cpuCount: cpus().length,
    loadAvg1: loadavg()[0] ?? 0,
    sample,
    linuxSwap,
    ps,
    governedPgids,
    governedPids,
    docker,
    indexing,
    memoryGuard: platform === 'linux' ? auditMemoryGuard() : null,
    sessionContext,
  };
}

/** Nearest ancestor of `dir` (itself included) holding `.git`, or `null`. */
export function gitRootOf(dir: string, exists: (p: string) => boolean = existsSync): string | null {
  let cur = dir;
  for (;;) {
    if (exists(join(cur, '.git'))) return cur;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/** pid → cwd from `lsof -a -d cwd -p <pids> -Fpn` output. */
export function parseLsofCwd(output: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid: number | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== null) out.set(pid, line.slice(1));
  }
  return out;
}

/** `ps` `time` (BSD `m:ss.cc`, procps `[dd-]hh:mm:ss`) to CPU seconds. */
export function parseCpuTime(value: string): number {
  const [days, rest] = value.includes('-') ? value.split('-', 2) : ['0', value];
  const parts = (rest ?? '').split(':').map(Number);
  const total = parts.reduce((acc, n) => acc * 60 + n, 0) + Number(days) * 86400;
  return Number.isFinite(total) ? total : 0;
}

/** pid → CPU seconds from `ps -A -o pid=,time=`. */
export function parsePsTimes(output: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of output.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), parseCpuTime(m[2] as string));
  }
  return out;
}

/** Gap between the two CPU samples. */
const CPU_SAMPLE_MS = 2000;

/**
 * Working directory, project and activity readings of each agent session:
 * one `lsof` on macOS (`/proc/<pid>/cwd` on Linux), one `stat` per tty and
 * per directory, and two CPU-time samples {@link CPU_SAMPLE_MS} apart.
 */
async function collectSessionContext(
  platform: NodeJS.Platform,
  rows: readonly ProcessRow[],
): Promise<Record<number, SessionContext>> {
  const sessions = harnessSessions(rows);
  if (sessions.length === 0) return {};
  const sampleStart = Date.now();
  const cpuBefore = await run('ps', ['-A', '-o', 'pid=,time=']);
  let cwds = new Map<number, string>();
  if (platform === 'linux') {
    for (const r of sessions) {
      try {
        cwds.set(r.pid, readlinkSync(`/proc/${r.pid}/cwd`));
      } catch {
        // gone or not ours
      }
    }
  } else {
    // A session that exits between ps and lsof makes lsof exit 1; keep the rest.
    const out = await runReadOnly(
      'lsof',
      ['-a', '-d', 'cwd', '-p', sessions.map((r) => r.pid).join(','), '-Fpn'],
      { keepStdoutOnExit: true },
    );
    cwds = out === null ? cwds : parseLsofCwd(out);
  }
  const now = Date.now();
  const lastWrite = (cwd: string, project: string | null): number | null => {
    let newest = Number.NEGATIVE_INFINITY;
    for (const p of [
      cwd,
      project,
      project && join(project, '.git'),
      project && join(project, '.git', 'index'),
    ]) {
      if (!p) continue;
      try {
        newest = Math.max(newest, statSync(p).mtimeMs);
      } catch {
        // absent (a worktree's .git is a file; its index lives elsewhere)
      }
    }
    return Number.isFinite(newest) ? Math.max(0, Math.round((now - newest) / 1000)) : null;
  };
  await new Promise((r) => setTimeout(r, Math.max(0, CPU_SAMPLE_MS - (Date.now() - sampleStart))));
  const cpuAfter = await run('ps', ['-A', '-o', 'pid=,time=']);
  const before = cpuBefore === null ? null : parsePsTimes(cpuBefore);
  const after = cpuAfter === null ? null : parsePsTimes(cpuAfter);
  const tree = buildTree(rows);
  const context: Record<number, SessionContext> = {};
  for (const r of sessions) {
    const cwd = cwds.get(r.pid) ?? null;
    let cpuDeltaSec: number | null = null;
    if (before && after) {
      cpuDeltaSec = 0;
      for (const p of subtree(tree, r)) {
        const a = after.get(p.pid);
        const b = before.get(p.pid);
        if (a !== undefined && b !== undefined) cpuDeltaSec += Math.max(0, a - b);
      }
    }
    const project = cwd === null ? null : gitRootOf(cwd);
    let ttyIdleSec: number | null = null;
    if (r.tty !== null) {
      try {
        const st = statSync(`/dev/${r.tty}`);
        ttyIdleSec = Math.max(0, Math.round((now - Math.max(st.atimeMs, st.mtimeMs)) / 1000));
      } catch {
        ttyIdleSec = null;
      }
    }
    context[r.pid] = {
      cwd,
      project,
      ttyIdleSec,
      cpuDeltaSec,
      lastWriteSec: cwd === null ? null : lastWrite(cwd, project),
    };
  }
  return context;
}
