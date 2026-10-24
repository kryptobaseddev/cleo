/**
 * Code-graph index freshness — disclosed on every graph query, and repaired
 * inline when the repair is small (T12316).
 *
 * A graph answer from a stale index is a confident answer about code that no
 * longer exists. The check compares the published generation's file manifest
 * against the working tree: a file whose size and mtime are unchanged keeps its
 * recorded hash, and only a metadata mismatch is re-hashed, so a checkout or
 * `touch` that changed no bytes is not reported stale.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 *
 * @task T12316
 * @module nexus/freshness
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import type {
  GraphIndexFreshness,
  NexusAnswerFreshness,
  ParserExecutionPort,
} from '@cleocode/contracts';
import { PARSER_WORKER_HEAP_MAX_MB } from '@cleocode/contracts/code-symbol.js';
import type { KnownFileFingerprint } from '@cleocode/nexus/pipeline';
import { sql } from 'drizzle-orm';
import { getConfigValue } from '../config/registry.js';
import { readEnvOverride } from '../config.js';
import { pushWarning } from '../output.js';
import { getCleoDirAbsolute } from '../paths.js';
import { getNexusDb } from '../store/nexus-sqlite.js';
import { runNexusAnalysis } from './analyze-orchestrator.js';
import {
  type GraphRunCost,
  readActiveRefreshCooldown,
  readFileManifest,
  readIndexedRevision,
  readRunCost,
  writeRefreshCooldown,
} from './graph-manifest.js';
import { releasePidLock, takePidLock } from './pid-lock.js';

/** Command that refreshes the index; incremental by default since T12315. */
export const NEXUS_REFRESH_COMMAND = 'cleo nexus analyze';

/**
 * Retired file-count cap for an inline refresh (T14014): the size-scaled cost
 * estimate against the budget decides. Kept as the reported default of the
 * ignored `nexus.autoRefresh.maxFiles`.
 */
export const DEFAULT_AUTO_REFRESH_MAX_FILES = 25;

/** Default wall-clock budget for an inline refresh. */
export const DEFAULT_AUTO_REFRESH_BUDGET_MS = 60_000;

/** Options for {@link assessNexusIndexFreshness}. */
export interface NexusFreshnessOptions {
  /** Files of the queried symbol(s); their own staleness is reported separately. */
  symbolFiles?: readonly string[];
  /** Maximum stale paths listed in the result. @defaultValue 10 */
  sampleLimit?: number;
}

/**
 * A freshness verdict plus the complete stale set it was computed from, so the
 * files of a symbol identified only AFTER the query can still be judged.
 */
export interface NexusFreshnessAssessment {
  /** Disclosed freshness facts. */
  freshness: GraphIndexFreshness;
  /** Every stale path (modified, added, deleted or unreadable). */
  staleFiles: ReadonlySet<string>;
  /**
   * What a refresh would cost (T14014): files it must parse (stale ones and
   * any without a reusable cache entry), files it can reuse, and the estimate.
   */
  refreshPlan?: NexusRefreshPlan;
}

/** What an inline refresh would parse, reuse and cost (T14014). */
export interface NexusRefreshPlan {
  /** Files that must be parsed: stale, or with no exact cache entry for this build. */
  toParse: number;
  /** Unchanged files with an exact cache entry for this build. */
  reusable: number;
  /** Estimated milliseconds, or `null` when no previous run cost is recorded. */
  estimateMs: number | null;
}

/**
 * Judge the queried symbol's own files against an assessment.
 * @param assessment - Assessment taken before the query ran.
 * @param files - Files of the queried symbol(s), e.g. from {@link querySymbolFiles}.
 * @returns The freshness facts with `symbolFileStale`/`symbolFile` set when files are known.
 */
export function judgeSymbolFiles(
  assessment: NexusFreshnessAssessment,
  files: readonly string[],
): GraphIndexFreshness {
  const unique = [...new Set(files)];
  if (unique.length === 0) return assessment.freshness;
  const stale = unique.find((file) => assessment.staleFiles.has(file));
  return {
    ...assessment.freshness,
    symbolFileStale: stale !== undefined,
    symbolFile: stale ?? unique[0],
  };
}

/** Auto-refresh policy, read from `nexus.autoRefresh.*` config unless given. */
export interface NexusAutoRefreshPolicy {
  /** Whether queries may refresh the index inline. @defaultValue true */
  enabled: boolean;
  /**
   * Retired (T14014): the size-scaled cost estimate against `budgetMs` decides.
   * Still read from `nexus.autoRefresh.maxFiles` for compatibility; ignored.
   */
  maxFiles: number;
  /** Wall-clock budget; a refresh estimated to exceed it is not started. @defaultValue 60000 */
  budgetMs: number;
  /** What turned refresh off, when not the config key (`--no-refresh`, `CLEO_NEXUS_AUTO_REFRESH`). */
  disabledBy?: string;
}

/** Largest factor a recorded run's whole-graph cost is scaled up by (T14014). */
const MAX_COST_SCALE = 4;

/**
 * Estimate a refresh from the last recorded run, or `null` when nothing is
 * recorded (T14014).
 *
 * Every refresh re-resolves, re-clusters and republishes the whole graph, so
 * that cost is scaled from the last run's per-file rate to today's file count
 * (at most {@link MAX_COST_SCALE} times, so one small sample cannot vouch for
 * a far larger repository). Files without an exact cache entry for this build
 * are parsed at the last run's parse rate, whatever their staleness: a wiped
 * cache or an extractor upgrade means a full parse. Decoding reused
 * extractions is recorded apart (`reuseDecode`) and never inflates that rate.
 */
function estimateRefreshMs(
  cost: GraphRunCost | null,
  toParse: number,
  reusable: number,
  fileCount: number,
): number | null {
  if (!cost) return null;
  const parseMs = cost.summary.phaseMs['parse'] ?? 0;
  const decodeMs = cost.summary.phaseMs['reuseDecode'] ?? 0;
  const parsed = cost.summary.parsedFiles;
  const resolved = Math.max(1, cost.summary.resolvedFiles);
  const wholeGraphMs = Math.max(0, cost.durationMs - parseMs - decodeMs);
  const scale = Math.max(1, fileCount / resolved);
  if (scale > MAX_COST_SCALE) return null;
  const perFileMs = parsed > 0 ? parseMs / parsed : 0;
  const perReusedMs = cost.summary.reusedFiles > 0 ? decodeMs / cost.summary.reusedFiles : 0;
  return Math.round(wholeGraphMs * scale + toParse * perFileMs + reusable * perReusedMs);
}

/**
 * Split the parseable files of the manifest (T14014) into those a refresh must
 * parse (stale, or without an exact cache entry for this build) and those it
 * can reuse (unchanged, same content hash, this build's extractor fingerprint).
 * Files no extractor parses are neither.
 */
async function planParse(
  db: Awaited<ReturnType<typeof getNexusDb>>,
  manifestFiles: readonly (readonly [string, number, number, string])[],
  stale: ReadonlySet<string>,
): Promise<{ toParse: number; reusable: number }> {
  const { computeExtractorFingerprint, isParseablePath } = await import('@cleocode/nexus/pipeline');
  const fingerprint = computeExtractorFingerprint();
  const cached = new Map<string, string>();
  for (const [path, contentHash, entryFingerprint] of db.values(
    sql`SELECT path, content_hash, fingerprint FROM main._nexus_parse_cache`,
  )) {
    if (
      entryFingerprint === fingerprint &&
      typeof path === 'string' &&
      typeof contentHash === 'string'
    )
      cached.set(path, contentHash);
  }
  let reusable = 0;
  let toParse = 0;
  for (const [path, , , contentHash] of manifestFiles) {
    if (!isParseablePath(path)) continue;
    if (!stale.has(path) && cached.get(path) === contentHash) reusable++;
    else toParse++;
  }
  // A new parseable file is stale but not yet in the manifest.
  const known = new Set(manifestFiles.map(([path]) => path));
  for (const path of stale) if (isParseablePath(path) && !known.has(path)) toParse++;
  return { toParse, reusable };
}

/** Render an estimate for humans and agents alike. */
function describeEstimate(ms: number | null, staleFiles: number, toParse: number): string {
  if (staleFiles === 0) return 'none needed';
  const kind = `re-parses ~${toParse} file(s), re-resolves the whole graph`;
  if (ms === null) return `unknown duration (${kind}; no previous analysis cost recorded)`;
  return `~${Math.max(1, Math.round(ms / 1000))}s (${kind})`;
}

/**
 * Assess how far the published code graph lags the working tree.
 *
 * @param projectRoot - Project whose graph database is inspected.
 * @param options - Symbol files to judge individually and the stale-path sample size.
 * @returns Freshness facts; `status: 'unknown'` carries a `reason` and is never a pass.
 * @example
 * ```ts
 * const freshness = await assessNexusIndexFreshness('/repo', { symbolFiles: ['src/a.ts'] });
 * if (freshness.status === 'stale') console.error(freshness.refreshCommand);
 * ```
 */
export async function assessNexusIndexFreshness(
  projectRoot: string,
  options: NexusFreshnessOptions = {},
): Promise<GraphIndexFreshness> {
  const assessment = await assessWithStaleSet(projectRoot, options.sampleLimit);
  return judgeSymbolFiles(assessment, options.symbolFiles ?? []);
}

/** Milliseconds per day, for {@link GraphIndexFreshness.ageDays}. */
const DAY_MS = 86_400_000;

/**
 * Where the index stands against the base branch (T14007): the indexed
 * revision, the base ref and its commit, the commits the index has not seen,
 * and its age. Measured against the base ref, never the working tree or HEAD,
 * so a checkout on an old branch cannot make a stale index look fresh.
 *
 * @param db - Project graph database.
 * @param sourceRoot - Repository the index describes.
 * @param lastIndexedAt - Assessment time of the published generation.
 * @returns The revision fields of {@link GraphIndexFreshness}.
 */
export async function measureAgainstBase(
  db: Awaited<ReturnType<typeof getNexusDb>>,
  sourceRoot: string,
  lastIndexedAt: string | null,
): Promise<
  Pick<
    GraphIndexFreshness,
    | 'indexedRevision'
    | 'baseRef'
    | 'baseRevision'
    | 'commitsBehind'
    | 'commitsBehindHead'
    | 'changedFilesSinceIndex'
    | 'ageDays'
  >
> {
  const { changedFilesSince, commitsBetween, resolveBaseRef, revParse } = await import(
    '../git/base-ref.js'
  );
  const indexedRevision = readIndexedRevision(db);
  const baseRef = resolveBaseRef(sourceRoot);
  const baseRevision = baseRef ? revParse(sourceRoot, baseRef) : null;
  const commitsBehind =
    indexedRevision && baseRevision
      ? commitsBetween(sourceRoot, indexedRevision, baseRevision)
      : null;
  // T14008: what is checked out is what a query is about; the base distance is report-only.
  const commitsBehindHead = indexedRevision
    ? commitsBetween(sourceRoot, indexedRevision, 'HEAD')
    : null;
  // T14014: a cheap, walk-free count for reporting; the walk stays authoritative.
  const changedFilesSinceIndex = indexedRevision
    ? changedFilesSince(sourceRoot, indexedRevision)
    : null;
  const indexedMs = lastIndexedAt ? Date.parse(lastIndexedAt) : Number.NaN;
  const ageDays = Number.isFinite(indexedMs)
    ? Math.max(0, Math.floor((Date.now() - indexedMs) / DAY_MS))
    : null;
  return {
    indexedRevision,
    baseRef,
    baseRevision,
    commitsBehind,
    commitsBehindHead,
    changedFilesSinceIndex,
    ageDays,
  };
}

/** Walk the tree once and keep the full stale set alongside the disclosed facts. */
async function assessWithStaleSet(
  projectRoot: string,
  sampleLimit = 10,
): Promise<NexusFreshnessAssessment> {
  const started = performance.now();
  const base = {
    refreshCommand: NEXUS_REFRESH_COMMAND,
    stalePaths: [] as string[],
  };
  const db = await getNexusDb(projectRoot);
  let manifest: ReturnType<typeof readFileManifest>;
  const none = new Set<string>();
  try {
    manifest = readFileManifest(db, projectRoot);
  } catch (error) {
    const freshness: GraphIndexFreshness = {
      ...base,
      indexed: true,
      status: 'unknown',
      lastIndexedAt: null,
      fileCount: 0,
      staleFileCount: -1,
      refreshEstimate: 'unknown',
      checkMs: Math.round(performance.now() - started),
      reason: `the recorded file manifest is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
    return { freshness, staleFiles: none };
  }
  if (!manifest) {
    const freshness: GraphIndexFreshness = {
      ...base,
      indexed: false,
      status: 'unknown',
      lastIndexedAt: null,
      fileCount: 0,
      staleFileCount: -1,
      refreshEstimate: 'unknown',
      checkMs: Math.round(performance.now() - started),
      reason:
        'no file manifest is recorded — the project was never indexed, or its index predates ' +
        `freshness tracking; run ${NEXUS_REFRESH_COMMAND} once`,
    };
    return { freshness, staleFiles: none };
  }

  const known = new Map<string, KnownFileFingerprint>();
  for (const [path, size, mtimeMs, contentHash] of manifest.files)
    known.set(path, { size, mtimeMs, contentHash });

  const { walkRepositoryPaths } = await import('@cleocode/nexus/pipeline');
  const unreadable: string[] = [];
  let current: Awaited<ReturnType<typeof walkRepositoryPaths>>;
  try {
    current = await walkRepositoryPaths(
      manifest.sourceRoot,
      undefined,
      (report) => {
        if (report.status === 'failed') unreadable.push(report.path);
      },
      manifest.includedRepositories,
      { knownFiles: known },
    );
  } catch (error) {
    // T12474: an unreachable source root is an unassessable index, never a crash.
    const freshness: GraphIndexFreshness = {
      ...base,
      ...(await measureAgainstBase(db, manifest.sourceRoot, manifest.assessedAt)),
      indexed: true,
      status: 'unknown',
      lastIndexedAt: manifest.assessedAt,
      fileCount: manifest.files.length,
      staleFileCount: -1,
      refreshEstimate: 'unknown',
      checkMs: Math.round(performance.now() - started),
      reason:
        `the recorded source root ${manifest.sourceRoot} could not be walked ` +
        `(${error instanceof Error ? error.message : String(error)}); run ${NEXUS_REFRESH_COMMAND}`,
    };
    return { freshness, staleFiles: none };
  }

  const stale = new Set<string>(unreadable);
  const seen = new Set<string>();
  for (const file of current) {
    seen.add(file.path);
    if (known.get(file.path)?.contentHash !== file.contentHash) stale.add(file.path);
  }
  for (const path of known.keys()) if (!seen.has(path)) stale.add(path);

  const fileCount = manifest.files.length;
  const { toParse, reusable } =
    stale.size > 0 ? await planParse(db, manifest.files, stale) : { toParse: 0, reusable: 0 };
  const estimate = estimateRefreshMs(readRunCost(db), toParse, reusable, fileCount);
  const freshness: GraphIndexFreshness = {
    ...base,
    ...(await measureAgainstBase(db, manifest.sourceRoot, manifest.assessedAt)),
    indexed: true,
    status: stale.size === 0 ? 'fresh' : 'stale',
    lastIndexedAt: manifest.assessedAt,
    fileCount,
    staleFileCount: stale.size,
    stalePaths: [...stale].sort().slice(0, sampleLimit),
    refreshEstimate: describeEstimate(estimate, stale.size, toParse),
    checkMs: Math.round(performance.now() - started),
  };
  return { freshness, staleFiles: stale, refreshPlan: { toParse, reusable, estimateMs: estimate } };
}

/** Default for `nexus.freshness.maxCommitsBehind` (T14008, lead decision 2026-10-24). */
export const DEFAULT_MAX_COMMITS_BEHIND = 50;

/** Env var that accepts a stale answer for any graph query (T14008). */
export const NEXUS_ALLOW_STALE_ENV = 'CLEO_NEXUS_ALLOW_STALE';

/** When a graph answer from a stale index is refused (T14008). */
export interface NexusStalePolicy {
  /** Most commits the index may trail the base branch. */
  maxCommitsBehind: number;
  /** The caller accepted a stale answer (`--allow-stale` or {@link NEXUS_ALLOW_STALE_ENV}). */
  allowStale: boolean;
}

/**
 * Read the stale-answer policy: `nexus.freshness.maxCommitsBehind` (default
 * {@link DEFAULT_MAX_COMMITS_BEHIND}) and the caller's opt-out.
 *
 * @param projectRoot - Project whose merged config is read.
 * @param options - `allowStale` from the caller's flag.
 * @returns The effective policy.
 * @example
 * ```ts
 * const policy = await readNexusStalePolicy(root, { allowStale: args['allow-stale'] });
 * ```
 */
export async function readNexusStalePolicy(
  projectRoot: string,
  options: { allowStale?: boolean } = {},
): Promise<NexusStalePolicy> {
  let raw: unknown;
  try {
    raw = await getConfigValue('nexus.freshness.maxCommitsBehind', { projectRoot });
  } catch {
    raw = undefined;
  }
  const configured = Number(raw);
  return {
    maxCommitsBehind:
      raw !== undefined && raw !== null && Number.isInteger(configured) && configured >= 0
        ? configured
        : DEFAULT_MAX_COMMITS_BEHIND,
    allowStale:
      options.allowStale === true || envSwitch(process.env[NEXUS_ALLOW_STALE_ENV]) === true,
  };
}

/**
 * The freshness block every index-sensitive answer carries as `data.freshness`.
 *
 * @param freshness - The assessment behind the answer.
 * @returns Revision, base, commits behind, age and verdict.
 */
export function answerFreshness(freshness: GraphIndexFreshness): NexusAnswerFreshness {
  return {
    status: freshness.status,
    indexedRevision: freshness.indexedRevision ?? null,
    baseRef: freshness.baseRef ?? null,
    commitsBehind: freshness.commitsBehind ?? null,
    commitsBehindHead: freshness.commitsBehindHead ?? null,
    changedFilesSinceIndex: freshness.changedFilesSinceIndex ?? null,
    refreshCooldownUntil: freshness.refreshCooldownUntil ?? null,
    ageDays: freshness.ageDays ?? null,
    lastIndexedAt: freshness.lastIndexedAt,
  };
}

/** A refused graph answer: the index is too far behind to answer from (T14008). */
export interface NexusStaleRefusal {
  /** Stable error code. */
  code: 'E_NEXUS_INDEX_STALE';
  /** Why the answer was refused. */
  message: string;
  /** The exact reindex command, and the opt-out. */
  fix: string;
  /** The freshness facts and the threshold that refused. */
  details: NexusAnswerFreshness & { maxCommitsBehind: number };
}

/**
 * Whether a graph answer must be refused as stale: the index trails the
 * checked-out HEAD by more than the policy allows, or the target is missing
 * from an index that is stale for this checkout (commits behind HEAD or
 * changed files), so it may exist in code the index never saw. Distance to the
 * base branch (`commitsBehind`) is reported only: on a feature branch or
 * worktree it grows as the base moves, and no reindex here could clear it.
 *
 * @param freshness - The assessment behind the answer.
 * @param policy - The stale-answer policy.
 * @param options - `targetMissing` when the query found no symbol; `projectRoot`
 *   names the checkout in the reindex command.
 * @returns The refusal, or `null` when the answer may stand.
 * @example
 * ```ts
 * const refusal = staleIndexRefusal(freshness, policy, { projectRoot: root });
 * if (refusal) return refusalEnvelope(refusal);
 * ```
 */
export function staleIndexRefusal(
  freshness: GraphIndexFreshness,
  policy: NexusStalePolicy,
  options: { targetMissing?: boolean; projectRoot?: string } = {},
): NexusStaleRefusal | null {
  if (policy.allowStale) return null;
  // Judged against what is checked out: a reindex here clears it on any branch
  // or worktree. Distance to the base branch is reported, never refused on.
  const behind = freshness.commitsBehindHead ?? null;
  const tooFar = behind !== null && behind > policy.maxCommitsBehind;
  const staleHere = freshness.status === 'stale' || (behind !== null && behind > 0);
  if (!tooFar && !(options.targetMissing && staleHere)) return null;
  const reason = tooFar
    ? `The index is ${behind} commit(s) behind the checked-out HEAD (more than nexus.freshness.maxCommitsBehind = ${policy.maxCommitsBehind})`
    : `The symbol is missing from an index that is stale for this checkout (${behind ?? 0} commit(s) behind HEAD, ${freshness.staleFileCount} changed file(s)); it may exist in code the index has not seen`;
  const reindex = options.projectRoot
    ? `${NEXUS_REFRESH_COMMAND} ${JSON.stringify(options.projectRoot)}`
    : NEXUS_REFRESH_COMMAND;
  return {
    code: 'E_NEXUS_INDEX_STALE',
    message: `${reason}; this answer would describe code that has changed.`,
    fix: `${reindex} (then repeat the query); to accept the stale answer, pass --allow-stale (nexus impact, nexus context) or set ${NEXUS_ALLOW_STALE_ENV}=1`,
    details: { ...answerFreshness(freshness), maxCommitsBehind: policy.maxCommitsBehind },
  };
}

/**
 * Read the auto-refresh policy from `nexus.autoRefresh.*`, applying defaults.
 * @param projectRoot - Project whose merged config is read.
 * @returns The effective policy.
 */
export async function readNexusAutoRefreshPolicy(
  projectRoot: string,
): Promise<NexusAutoRefreshPolicy> {
  const read = async (key: string): Promise<unknown> => {
    try {
      return await getConfigValue(`nexus.autoRefresh.${key}`, { projectRoot });
    } catch {
      return undefined;
    }
  };
  const [enabled, maxFiles, budgetMs] = await Promise.all([
    read('enabled'),
    read('maxFiles'),
    read('budgetMs'),
  ]);
  // T13523: the env var wins over config, as ENV_MAP does for loadConfig.
  const env = envSwitch(readEnvOverride('nexus.autoRefresh.enabled'));
  if (env === true) return policyFrom(true, maxFiles, budgetMs);
  if (env === false)
    return { ...policyFrom(false, maxFiles, budgetMs), disabledBy: 'CLEO_NEXUS_AUTO_REFRESH' };
  return policyFrom(enabled, maxFiles, budgetMs);
}

/** Read an on/off env value (`true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`); `undefined` otherwise. */
function envSwitch(value: unknown): boolean | undefined {
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  return undefined;
}

/** Apply defaults to raw `nexus.autoRefresh.*` values. */
function policyFrom(
  enabled: unknown,
  maxFiles: unknown,
  budgetMs: unknown,
): NexusAutoRefreshPolicy {
  return {
    enabled: typeof enabled === 'boolean' ? enabled : true,
    maxFiles:
      typeof maxFiles === 'number' && Number.isInteger(maxFiles) && maxFiles >= 0
        ? maxFiles
        : DEFAULT_AUTO_REFRESH_MAX_FILES,
    budgetMs:
      typeof budgetMs === 'number' && Number.isFinite(budgetMs) && budgetMs > 0
        ? budgetMs
        : DEFAULT_AUTO_REFRESH_BUDGET_MS,
  };
}

/** What an inline refresh is asked to do (sent to its child process). */
export interface NexusRefreshInput {
  /** Project whose graph is refreshed. */
  projectRoot: string;
  /** Source root the previous generation was built from. */
  repoPath: string;
  /** Included nested repositories carried over from the previous generation. */
  includedRepositories?: readonly string[];
  /** Wall-clock budget; cancels the run at its next phase boundary. */
  budgetMs: number;
}

/** What an inline refresh reports back. */
export interface NexusRefreshSummary {
  /** Analysis mode the refresh ran in. */
  mode: GraphRunCost['summary']['mode'];
  /** Why that mode was chosen. */
  reason: string;
}

/** Runs one inline refresh; {@link runRefreshInChild} unless a caller supplies another. */
export type NexusRefreshRunner = (input: NexusRefreshInput) => Promise<NexusRefreshSummary>;

/**
 * Run a refresh in this thread, bounded by its budget. Unbounded in memory:
 * {@link runRefreshInChild} runs it inside a heap-limited child process.
 *
 * @param input - The refresh to run.
 * @returns The refresh summary.
 */
export async function runRefreshInProcess(input: NexusRefreshInput): Promise<NexusRefreshSummary> {
  const { summary } = await runNexusAnalysis({
    projectRoot: input.projectRoot,
    repoPath: input.repoPath,
    ...(input.includedRepositories ? { includedRepositories: input.includedRepositories } : {}),
    parserLimits: { signal: AbortSignal.timeout(input.budgetMs) },
  });
  return { mode: summary.mode, reason: summary.reason };
}

/** What the refresh child sends back: its summary, or why it failed. */
export type NexusRefreshReply =
  | { ok: true; summary: NexusRefreshSummary }
  | { ok: false; message: string };

/**
 * Run an inline refresh in a child process with its own heap limit (T13537 ·
 * T13548).
 *
 * Even an incremental run re-resolves the whole graph (Leiden included), so
 * the CLI's own heap is never used: a refresh that outgrows its limit kills
 * only the child. The child is the runtime's owned parser process (process
 * group, teardown, cgroup sizing), so ending it — on its result, its budget
 * plus a margin, or a crash — releases every SQLite handle and lock it held.
 *
 * @param input - The refresh to run.
 * @param options - Child entry, heap limit and process port; default to
 *   `refresh-child.js` beside this module, this process's own V8 heap limit (so
 *   a refresh that fit in-process still fits) and the runtime's parser port.
 * @returns The refresh summary.
 */
export async function runRefreshInChild(
  input: NexusRefreshInput,
  options: { entry?: URL; heapMb?: number; port?: ParserExecutionPort } = {},
): Promise<NexusRefreshSummary> {
  const entry = fileURLToPath(options.entry ?? new URL('./refresh-child.js', import.meta.url));
  // Running from TypeScript source (no built child beside it) has no bounded
  // runner; refreshing in-process would reintroduce the heap-cap abort.
  if (!existsSync(entry)) throw new Error(`no bounded refresh process at ${entry}`);
  const heapMb =
    options.heapMb ??
    Math.min(
      PARSER_WORKER_HEAP_MAX_MB,
      Math.max(64, Math.floor(getHeapStatistics().heap_size_limit / 2 ** 20)),
    );
  // T13539: ends a stall the phase-boundary abort cannot reach.
  const killAfterMs = Math.round(input.budgetMs + Math.max(1_000, input.budgetMs / 10));
  const deadline = AbortSignal.timeout(killAfterMs);
  const port =
    options.port ?? (await import('../resources/spawn-wrapper.js')).createParserExecutionPort();
  const handle = port.spawn(entry, { workerHeapMb: heapMb, signal: deadline });
  // V8's out-of-memory banner precedes ~9 KB of native stack, past the port's
  // bounded stderr tail, so watch for it as it streams (carrying a chunk seam).
  let outOfMemory = false;
  let seam = '';
  handle.child.stderr?.on('data', (chunk: Buffer | string) => {
    const text = seam + String(chunk);
    if (/heap out of memory/i.test(text)) outOfMemory = true;
    seam = text.slice(-32);
  });
  try {
    return await new Promise<NexusRefreshSummary>((resolve, reject) => {
      handle.child.once('message', (reply: NexusRefreshReply) => {
        if (reply.ok) resolve(reply.summary);
        else reject(new Error(reply.message));
      });
      // 'close', not 'exit': stderr has been read to its end by then.
      handle.child.once('close', (code, signal) => {
        reject(
          new Error(
            deadline.aborted
              ? `the refresh did not finish within ${killAfterMs} ms; run ${NEXUS_REFRESH_COMMAND}`
              : outOfMemory
                ? `the refresh exceeded its ${heapMb} MB heap bound; run ${NEXUS_REFRESH_COMMAND}`
                : `the refresh process exited with ${signal ?? `code ${code}`} and no result`,
          ),
        );
      });
      handle.child.send(input);
    });
  } finally {
    // T13539: the result is published once sent; nothing the child left open holds the query.
    await handle.stop();
  }
}

/** Cooldown after an inline refresh fails or is aborted (T14014). */
export const INLINE_REFRESH_COOLDOWN_MS = 30 * 60_000;

/** A refresh parsing more than this many files (or 30% of them) needs `cleo run` admission. */
const ADMISSION_FREE_PARSE_FILES = 25;

/** Share of files above which a refresh needs `cleo run` admission. */
const ADMISSION_FREE_PARSE_RATIO = 0.3;

/** Lock file under `.cleo/`: one inline refresh at a time per project. */
export const INLINE_REFRESH_LOCK_FILE = 'nexus-inline-refresh.lock';

/** Admits a heavy inline refresh without waiting; `null` when refused (T14014). */
export type NexusRefreshAdmitter = (
  projectRoot: string,
) => Promise<{ release(): Promise<void> } | { refused: string }>;

/** The production admitter: one non-waiting `cleo run` admission pass, class build. */
const admitRefresh: NexusRefreshAdmitter = async (projectRoot) => {
  const { admit, footprintForClass } = await import('../resources/admission-ledger.js');
  const outcome = await admit(
    {
      label: 'nexus:inline-refresh',
      footprintBytes: footprintForClass('scoped-build'),
      cwd: projectRoot,
      footprintReason: 'inline NEXUS refresh beyond a small incremental set (T14014)',
    },
    { wait: false, timeoutMs: 0 },
  );
  return outcome.admitted ? outcome.grant : { refused: outcome.refusal.reason };
};

/**
 * Assess freshness and, when the refresh is affordable, refresh the index
 * inline before the caller answers from it.
 *
 * A refresh runs when the recorded cost, scaled to the repository and to the
 * files it must parse (T14014), fits `budgetMs`. It is guarded so a stale
 * index never turns every query into another heavy run:
 * - one inline refresh at a time per project (a pid lock; a concurrent query
 *   answers from the stale index);
 * - a refresh beyond a small incremental set needs a non-waiting `cleo run`
 *   admission, and is skipped when the machine is busy;
 * - a refresh that fails or is aborted sets a cooldown: no inline refresh for
 *   {@link INLINE_REFRESH_COOLDOWN_MS}, or until an analysis publishes a new
 *   generation. The cooldown is reported as `refreshCooldownUntil`.
 * The budget also cancels a run at its next check, and publication is atomic,
 * so an abandoned refresh leaves the previous graph intact. Every decision is
 * disclosed in `autoRefresh`.
 *
 * @param projectRoot - Project whose graph is about to be queried.
 * @param policy - Explicit policy; read from config when omitted.
 * @param runRefresh - Runs the refresh; a heap-bounded worker unless supplied (T13537).
 * @param admitter - Admits a heavy refresh; `cleo run` admission unless supplied.
 * @returns Freshness of the index as it stands after any refresh, with its stale set.
 */
export async function ensureNexusIndexFresh(
  projectRoot: string,
  policy?: NexusAutoRefreshPolicy,
  runRefresh: NexusRefreshRunner = runRefreshInChild,
  admitter: NexusRefreshAdmitter = admitRefresh,
): Promise<NexusFreshnessAssessment> {
  const initial = await assessWithStaleSet(projectRoot);
  const before = initial.freshness;
  if (before.status !== 'stale') return initial;
  const effective = policy ?? (await readNexusAutoRefreshPolicy(projectRoot));
  const skip = (reason: string, cooldownUntil?: string): NexusFreshnessAssessment => ({
    staleFiles: initial.staleFiles,
    ...(initial.refreshPlan ? { refreshPlan: initial.refreshPlan } : {}),
    freshness: {
      ...before,
      ...(cooldownUntil ? { refreshCooldownUntil: cooldownUntil } : {}),
      autoRefresh: { refreshed: false, staleFiles: before.staleFileCount, durationMs: 0, reason },
    },
  });
  if (!effective.enabled)
    return skip(
      `auto-refresh is disabled (${effective.disabledBy ?? 'nexus.autoRefresh.enabled = false'}); answered from the stale index`,
    );
  const db = await getNexusDb(projectRoot);
  const cooldown = readActiveRefreshCooldown(db);
  if (cooldown)
    return skip(
      `a recent inline refresh did not finish (${cooldown.reason}); no inline refresh until ${cooldown.until} or the next ${NEXUS_REFRESH_COMMAND}; answered from the stale index`,
      cooldown.until,
    );
  const plan = initial.refreshPlan;
  const estimate = plan?.estimateMs ?? null;
  // T13523: with no comparable recorded cost there is no bound on the run, so
  // do not start one.
  if (estimate === null)
    return skip(
      `no previous analysis cost recorded (or the repository has grown more than ${MAX_COST_SCALE}x since), so the refresh cannot be bounded; answered from the stale index (run ${NEXUS_REFRESH_COMMAND} to refresh and record one)`,
    );
  if (estimate > effective.budgetMs)
    return skip(
      `estimated refresh ${Math.round(estimate / 1000)}s exceeds nexus.autoRefresh.budgetMs = ` +
        `${effective.budgetMs}; answered from the stale index`,
    );

  const cleoDir = getCleoDirAbsolute(projectRoot);
  mkdirSync(cleoDir, { recursive: true });
  const lockPath = join(cleoDir, INLINE_REFRESH_LOCK_FILE);
  const holder = takePidLock(lockPath);
  if (holder !== null)
    return skip(
      `an inline refresh is already running${holder > 0 ? ` (pid ${holder})` : ''}; answered from the stale index`,
    );
  let grant: { release(): Promise<void> } | null = null;
  try {
    const toParse = plan?.toParse ?? before.staleFileCount;
    const heavy =
      toParse > ADMISSION_FREE_PARSE_FILES ||
      (before.fileCount > 0 && toParse / before.fileCount > ADMISSION_FREE_PARSE_RATIO);
    if (heavy) {
      const admitted = await admitter(projectRoot);
      if ('refused' in admitted)
        return skip(
          `a refresh parsing ~${toParse} file(s) needs cleo run admission and the machine is busy (${admitted.refused}); answered from the stale index`,
        );
      grant = admitted;
    }
    const manifest = readFileManifest(db, projectRoot);
    const started = performance.now();
    const generation = db.values(
      sql`SELECT value FROM main._nexus_meta WHERE key = 'graph_generation'`,
    )[0]?.[0];
    try {
      const summary = await runRefresh({
        projectRoot,
        repoPath: manifest?.sourceRoot ?? projectRoot,
        ...(manifest ? { includedRepositories: manifest.includedRepositories } : {}),
        budgetMs: effective.budgetMs,
      });
      const after = await assessWithStaleSet(projectRoot);
      return {
        staleFiles: after.staleFiles,
        ...(after.refreshPlan ? { refreshPlan: after.refreshPlan } : {}),
        freshness: {
          ...after.freshness,
          autoRefresh: {
            refreshed: summary.mode !== 'unchanged',
            staleFiles: before.staleFileCount,
            durationMs: Math.round(performance.now() - started),
            reason: `${summary.mode}: ${summary.reason}`,
          },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // T14014: an aborted or failed refresh records no cost, so without a
      // cooldown every query would start another one.
      const until = new Date(Date.now() + INLINE_REFRESH_COOLDOWN_MS).toISOString();
      writeRefreshCooldown(db, {
        until,
        generation: typeof generation === 'string' ? generation : null,
        reason: message.slice(0, 300),
      });
      return {
        staleFiles: initial.staleFiles,
        ...(initial.refreshPlan ? { refreshPlan: initial.refreshPlan } : {}),
        freshness: {
          ...before,
          refreshCooldownUntil: until,
          autoRefresh: {
            refreshed: false,
            staleFiles: before.staleFileCount,
            durationMs: Math.round(performance.now() - started),
            reason: `refresh failed, previous graph retained: ${message}; inline refresh paused until ${until}`,
          },
        },
      };
    }
  } finally {
    await grant?.release();
    releasePidLock(lockPath);
  }
}

/**
 * Collect the source files a graph query answer is about.
 *
 * Graph node ids are `<file>::<symbol>`, so a target id names its file; an
 * explicit `filePath` is used when present. Only the answer's own target (or,
 * for symbol lookups, each matched symbol) is considered — callers listed in
 * the answer are not "the queried symbol".
 *
 * @param data - A query operation's result payload.
 * @returns Repository-relative files of the queried symbol(s); empty when none are identifiable.
 */
export function querySymbolFiles(data: unknown): string[] {
  const files = new Set<string>();
  const fromId = (id: unknown): void => {
    if (typeof id === 'string' && id.includes('::')) files.add(id.slice(0, id.indexOf('::')));
  };
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (typeof record['filePath'] === 'string') files.add(record['filePath']);
    fromId(record['targetNodeId']);
    fromId(record['nodeId']);
    fromId(record['symbolId']);
  };
  visit(data);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    for (const key of ['target', 'symbol', 'node']) visit(record[key]);
    // Symbol lookups (e.g. `context`) answer with one entry per matched symbol;
    // each entry's own identity counts, never the callers nested inside it.
    for (const key of ['results', 'matches']) {
      const entries = record[key];
      if (Array.isArray(entries)) for (const entry of entries) visit(entry);
    }
  }
  return [...files];
}

/** `--no-refresh` (T13523): answer from the index as it stands. */
const NO_REFRESH_POLICY: NexusAutoRefreshPolicy = {
  enabled: false,
  maxFiles: 0,
  budgetMs: DEFAULT_AUTO_REFRESH_BUDGET_MS,
  disabledBy: '--no-refresh',
};

/**
 * Assess (and when small, repair) index freshness before a graph query.
 *
 * Never throws: a failed assessment is returned as `status: 'unknown'` with its
 * reason, so it neither blocks the query nor is ever mistaken for fresh.
 *
 * @param projectRoot - Project whose graph is about to be queried.
 * @param options - `refresh: false` (`--no-refresh`) skips any inline refresh.
 * @returns The assessment to judge the answer against.
 */
export async function assessNexusFreshnessForQuery(
  projectRoot: string,
  options: { refresh?: boolean } = {},
): Promise<NexusFreshnessAssessment> {
  try {
    return await ensureNexusIndexFresh(
      projectRoot,
      options.refresh === false ? NO_REFRESH_POLICY : undefined,
    );
  } catch (error) {
    return {
      staleFiles: new Set(),
      freshness: {
        indexed: false,
        status: 'unknown',
        lastIndexedAt: null,
        fileCount: 0,
        staleFileCount: -1,
        stalePaths: [],
        refreshCommand: NEXUS_REFRESH_COMMAND,
        refreshEstimate: 'unknown',
        checkMs: 0,
        reason: `freshness could not be assessed: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

/**
 * Disclose a non-fresh index as an envelope warning
 * (`W_NEXUS_INDEX_STALE` / `W_NEXUS_INDEX_FRESHNESS_UNKNOWN`), and an inline
 * refresh that just happened as `W_NEXUS_INDEX_REFRESHED` (info). Warnings
 * reach `meta.warnings` through the active collector — never stderr, which
 * would break the one-envelope stream contract (T9775).
 *
 * @param subject - What answered, e.g. `nexus impact`.
 * @param freshness - Freshness of the index the answer came from.
 */
export function discloseNexusFreshness(subject: string, freshness: GraphIndexFreshness): void {
  const refresh = freshness.autoRefresh;
  if (refresh?.refreshed) {
    pushWarning({
      code: 'W_NEXUS_INDEX_REFRESHED',
      severity: 'info',
      message: `Refreshed the index inline before answering (${refresh.staleFiles} stale file(s), ${refresh.durationMs}ms): ${refresh.reason}`,
    });
  }
  if (freshness.status === 'fresh') return;
  const symbol =
    freshness.symbolFileStale === true
      ? ` The queried symbol's own file (${freshness.symbolFile}) is among them.`
      : '';
  const message =
    freshness.status === 'stale'
      ? `${subject} answered from an index ${freshness.staleFileCount} file(s) behind the working tree ` +
        `(indexed ${freshness.lastIndexedAt ?? 'at an unknown time'}; e.g. ${freshness.stalePaths.slice(0, 3).join(', ')}).${symbol} ` +
        `Refresh: ${freshness.refreshCommand} — ${freshness.refreshEstimate}.` +
        (refresh && !refresh.refreshed ? ` Not refreshed inline: ${refresh.reason}.` : '')
      : `${subject} could not establish index freshness: ${freshness.reason ?? 'unknown reason'}.`;
  pushWarning({
    code: freshness.status === 'stale' ? 'W_NEXUS_INDEX_STALE' : 'W_NEXUS_INDEX_FRESHNESS_UNKNOWN',
    severity: 'warn',
    message,
  });
}

/**
 * Merge a freshness verdict into envelope extensions' `_nexus` block.
 * @param extensions - Envelope extensions, possibly already carrying `_nexus`.
 * @param freshness - Freshness of the index the answer came from.
 * @returns New extensions with `_nexus.indexFreshness` and `_nexus.freshness` set.
 */
export function withNexusFreshnessMeta(
  extensions: Record<string, unknown>,
  freshness: GraphIndexFreshness,
): Record<string, unknown> {
  const current = extensions['_nexus'];
  const nexusMeta = current && typeof current === 'object' ? current : {};
  return {
    ...extensions,
    _nexus: { ...nexusMeta, indexFreshness: freshness.status, freshness },
  };
}
