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

import { performance } from 'node:perf_hooks';
import type { GraphIndexFreshness } from '@cleocode/contracts';
import type { KnownFileFingerprint } from '@cleocode/nexus/pipeline';
import { getConfigValue } from '../config/registry.js';
import { pushWarning } from '../output.js';
import { getNexusDb } from '../store/nexus-sqlite.js';
import { runNexusAnalysis } from './analyze-orchestrator.js';
import { type GraphRunCost, readFileManifest, readRunCost } from './graph-manifest.js';

/** Command that refreshes the index; incremental by default since T12315. */
export const NEXUS_REFRESH_COMMAND = 'cleo nexus analyze';

/** Default number of stale files an index query may refresh inline. */
export const DEFAULT_AUTO_REFRESH_MAX_FILES = 25;

/** Default wall-clock budget for an inline refresh. */
export const DEFAULT_AUTO_REFRESH_BUDGET_MS = 60_000;

/** Share of changed files above which analysis rebuilds fully (mirrors the pipeline). */
const FULL_REBUILD_RATIO = 0.3;

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
  /** Most stale files a query refreshes inline. @defaultValue 25 */
  maxFiles: number;
  /** Wall-clock budget; a refresh estimated to exceed it is not started. @defaultValue 60000 */
  budgetMs: number;
}

/** Estimate a refresh from the last recorded run, or `null` when nothing is recorded. */
function estimateRefreshMs(
  cost: GraphRunCost | null,
  staleFiles: number,
  fileCount: number,
): number | null {
  if (!cost) return null;
  const parseMs = cost.summary.phaseMs['parse'] ?? 0;
  const parsed = cost.summary.parsedFiles;
  const fixedMs = Math.max(0, cost.durationMs - parseMs);
  const perFileMs = parsed > 0 ? parseMs / parsed : 0;
  const full = fileCount > 0 && staleFiles / fileCount > FULL_REBUILD_RATIO;
  const reparsed = full ? Math.max(parsed, cost.summary.resolvedFiles) : staleFiles;
  return Math.round(fixedMs + reparsed * perFileMs);
}

/** Render an estimate for humans and agents alike. */
function describeEstimate(ms: number | null, staleFiles: number, fileCount: number): string {
  if (staleFiles === 0) return 'none needed';
  const kind =
    fileCount > 0 && staleFiles / fileCount > FULL_REBUILD_RATIO
      ? 'full rebuild'
      : `incremental, re-parses ~${staleFiles} file(s)`;
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
    manifest = readFileManifest(db);
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
  const current = await walkRepositoryPaths(
    manifest.sourceRoot,
    undefined,
    (report) => {
      if (report.status === 'failed') unreadable.push(report.path);
    },
    manifest.includedRepositories,
    { knownFiles: known },
  );

  const stale = new Set<string>(unreadable);
  const seen = new Set<string>();
  for (const file of current) {
    seen.add(file.path);
    if (known.get(file.path)?.contentHash !== file.contentHash) stale.add(file.path);
  }
  for (const path of known.keys()) if (!seen.has(path)) stale.add(path);

  const fileCount = manifest.files.length;
  const estimate = estimateRefreshMs(readRunCost(db), stale.size, fileCount);
  const freshness: GraphIndexFreshness = {
    ...base,
    indexed: true,
    status: stale.size === 0 ? 'fresh' : 'stale',
    lastIndexedAt: manifest.assessedAt,
    fileCount,
    staleFileCount: stale.size,
    stalePaths: [...stale].sort().slice(0, sampleLimit),
    refreshEstimate: describeEstimate(estimate, stale.size, fileCount),
    checkMs: Math.round(performance.now() - started),
  };
  return { freshness, staleFiles: stale };
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

/**
 * Assess freshness and, when only a few files are stale, refresh the index
 * inline before the caller answers from it.
 *
 * A refresh runs only when `0 < stale ≤ maxFiles` and the recorded cost
 * estimate fits `budgetMs`; the budget also cancels the run at its next phase
 * boundary, and publication is atomic, so an abandoned refresh leaves the
 * previous graph intact. Every decision — refreshed, skipped or failed — is
 * disclosed in `autoRefresh`, and the returned freshness describes the index
 * the caller is about to read.
 *
 * @param projectRoot - Project whose graph is about to be queried.
 * @param policy - Explicit policy; read from config when omitted.
 * @returns Freshness of the index as it stands after any refresh, with its stale set.
 */
export async function ensureNexusIndexFresh(
  projectRoot: string,
  policy?: NexusAutoRefreshPolicy,
): Promise<NexusFreshnessAssessment> {
  const initial = await assessWithStaleSet(projectRoot);
  const before = initial.freshness;
  if (before.status !== 'stale') return initial;
  const effective = policy ?? (await readNexusAutoRefreshPolicy(projectRoot));
  const skip = (reason: string): NexusFreshnessAssessment => ({
    staleFiles: initial.staleFiles,
    freshness: {
      ...before,
      autoRefresh: { refreshed: false, staleFiles: before.staleFileCount, durationMs: 0, reason },
    },
  });
  if (!effective.enabled)
    return skip('auto-refresh is disabled (nexus.autoRefresh.enabled = false)');
  if (before.staleFileCount > effective.maxFiles)
    return skip(
      `${before.staleFileCount} stale files exceed nexus.autoRefresh.maxFiles = ${effective.maxFiles}; ` +
        'answered from the stale index',
    );
  const db = await getNexusDb(projectRoot);
  const estimate = estimateRefreshMs(readRunCost(db), before.staleFileCount, before.fileCount);
  if (estimate !== null && estimate > effective.budgetMs)
    return skip(
      `estimated refresh ${Math.round(estimate / 1000)}s exceeds nexus.autoRefresh.budgetMs = ` +
        `${effective.budgetMs}; answered from the stale index`,
    );

  const manifest = readFileManifest(db);
  const started = performance.now();
  try {
    const result = await runNexusAnalysis({
      projectRoot,
      repoPath: manifest?.sourceRoot ?? projectRoot,
      ...(manifest ? { includedRepositories: manifest.includedRepositories } : {}),
      parserLimits: { signal: AbortSignal.timeout(effective.budgetMs) },
    });
    const after = await assessWithStaleSet(projectRoot);
    return {
      staleFiles: after.staleFiles,
      freshness: {
        ...after.freshness,
        autoRefresh: {
          refreshed: result.summary.mode !== 'unchanged',
          staleFiles: before.staleFileCount,
          durationMs: Math.round(performance.now() - started),
          reason: `${result.summary.mode}: ${result.summary.reason}`,
        },
      },
    };
  } catch (error) {
    return {
      staleFiles: initial.staleFiles,
      freshness: {
        ...before,
        autoRefresh: {
          refreshed: false,
          staleFiles: before.staleFileCount,
          durationMs: Math.round(performance.now() - started),
          reason: `refresh failed, previous graph retained: ${error instanceof Error ? error.message : String(error)}`,
        },
      },
    };
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

/**
 * Assess (and when small, repair) index freshness before a graph query.
 *
 * Never throws: a failed assessment is returned as `status: 'unknown'` with its
 * reason, so it neither blocks the query nor is ever mistaken for fresh.
 *
 * @param projectRoot - Project whose graph is about to be queried.
 * @returns The assessment to judge the answer against.
 */
export async function assessNexusFreshnessForQuery(
  projectRoot: string,
): Promise<NexusFreshnessAssessment> {
  try {
    return await ensureNexusIndexFresh(projectRoot);
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
