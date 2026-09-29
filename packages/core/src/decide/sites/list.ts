/**
 * `cleo decide sites` — list every registered decision site with its rung,
 * ladder, fallback, owner-escalation rule, configured and effective mode,
 * go-live evidence and last-7-day audit activity (spec
 * `system-one-integration` §3.4).
 *
 * Read-only. The effective mode follows the rule `resolveDecisionSiteSettings`
 * applies at the call sites: a site that uses System One (as its primary rung
 * or on its ladder) is `off` while no provider is configured.
 *
 * @task T12662
 * @epic T12486
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DecisionRung,
  DecisionSiteActivity,
  DecisionSiteDefinition,
  DecisionSiteModeValue,
  DecisionSiteSummary,
  DecisionSitesListResult,
} from '@cleocode/contracts';
import { DECISION_AUDIT_FILE, DEFAULT_DECISION_AUDIT_KEEP } from '../audit.js';
import { isDecisionSiteMode } from '../site.js';
import { DECISION_SITES } from './registry.js';

/** Window for {@link DecisionSiteSummary.last7d}, ms. */
export const DECISION_SITE_ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Filters and injectable dependencies for {@link listDecisionSites}. */
export interface ListDecisionSitesOptions {
  /** Only sites whose primary rung is this. */
  readonly rung?: DecisionRung;
  /** Only sites whose effective mode is this. */
  readonly mode?: DecisionSiteModeValue;
  /** Only the site with this id. */
  readonly id?: string;
  /** Only sites that have recorded go-live evidence. */
  readonly evidenceOnly?: boolean;
  /** Project root (config and audit). Default: the resolved CLEO project root. */
  readonly projectRoot?: string;
  /** Whether a System One provider is configured. Default: the stored connection. */
  readonly providerConfigured?: boolean;
  /** Config reader. Default: the config registry. */
  readonly readConfig?: (key: string, projectRoot: string) => Promise<unknown>;
  /** Registry to list. Default: {@link DECISION_SITES}. */
  readonly sites?: readonly DecisionSiteDefinition[];
  /** Clock for the activity window. Default: now. */
  readonly now?: Date;
}

/** Whether a site asks System One at all (primary rung or ladder). */
function usesSystemOne(site: DecisionSiteDefinition): boolean {
  return site.primaryRung === 'system-one' || site.ladder.includes('system-one');
}

/** One parsed audit line, as far as the activity counts need it. */
interface AuditLine {
  readonly timestamp?: unknown;
  readonly site?: unknown;
  readonly source?: unknown;
  readonly escalatedFrom?: unknown;
  readonly shadow?: { readonly agree?: unknown };
}

/**
 * Audit lines from the live `decisions.jsonl` and its rotated generations,
 * newest generation first. Rotation only moves older lines down, so once a
 * whole generation predates `since`, every older one does too and reading
 * stops there. Unreadable files and malformed lines are skipped.
 *
 * @param projectRoot - Project root.
 * @param since - Start of the window, epoch ms.
 * @returns Parsed lines from the generations that can reach the window.
 */
function readAuditLines(projectRoot: string, since: number): AuditLine[] {
  const live = join(projectRoot, DECISION_AUDIT_FILE);
  const files = [live];
  for (let n = 1; n <= DEFAULT_DECISION_AUDIT_KEEP; n++) files.push(`${live}.${n}`);
  const lines: AuditLine[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    let newest = Number.NEGATIVE_INFINITY;
    const parsedLines: AuditLine[] = [];
    for (const raw of text.split('\n')) {
      if (raw.trim() === '') continue;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') continue;
        const line = parsed as AuditLine;
        parsedLines.push(line);
        const at = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : Number.NaN;
        if (!Number.isNaN(at) && at > newest) newest = at;
      } catch {
        // malformed line
      }
    }
    if (parsedLines.length > 0 && newest < since) break;
    lines.push(...parsedLines);
  }
  return lines;
}

/**
 * Per-site activity over the window ending at `now`.
 *
 * @param lines - Parsed audit lines.
 * @param now - End of the window.
 * @returns Site id → counts.
 */
function activityBySite(lines: readonly AuditLine[], now: Date): Map<string, DecisionSiteActivity> {
  const since = now.getTime() - DECISION_SITE_ACTIVITY_WINDOW_MS;
  const acc = new Map<
    string,
    {
      asked: number;
      provider: number;
      cache: number;
      fallback: number;
      escalated: number;
      compared: number;
      agreed: number;
    }
  >();
  for (const line of lines) {
    if (typeof line.site !== 'string' || typeof line.timestamp !== 'string') continue;
    const at = Date.parse(line.timestamp);
    if (Number.isNaN(at) || at < since || at > now.getTime()) continue;
    const a = acc.get(line.site) ?? {
      asked: 0,
      provider: 0,
      cache: 0,
      fallback: 0,
      escalated: 0,
      compared: 0,
      agreed: 0,
    };
    a.asked++;
    if (line.source === 'provider') a.provider++;
    else if (line.source === 'cache') a.cache++;
    else if (line.source === 'fallback') a.fallback++;
    if (line.escalatedFrom !== undefined) a.escalated++;
    const agree = line.shadow?.agree;
    if (typeof agree === 'boolean') {
      a.compared++;
      if (agree) a.agreed++;
    }
    acc.set(line.site, a);
  }
  const out = new Map<string, DecisionSiteActivity>();
  for (const [site, a] of acc) {
    out.set(site, {
      asked: a.asked,
      provider: a.provider,
      cache: a.cache,
      fallback: a.fallback,
      escalated: a.escalated,
      ...(a.compared > 0 ? { agreement: a.agreed / a.compared } : {}),
    });
  }
  return out;
}

const NO_ACTIVITY: DecisionSiteActivity = {
  asked: 0,
  provider: 0,
  cache: 0,
  fallback: 0,
  escalated: 0,
};

/**
 * List the registered decision sites with their configured and effective
 * modes and recent activity. Never throws on unreadable config or audit.
 *
 * @param opts - Filters and injectable dependencies.
 * @returns Provider state, registry size and the matching sites.
 */
export async function listDecisionSites(
  opts: ListDecisionSitesOptions = {},
): Promise<DecisionSitesListResult> {
  const sites = opts.sites ?? DECISION_SITES;
  let projectRoot = opts.projectRoot;
  if (projectRoot === undefined) {
    const { getProjectRoot } = await import('../../paths.js');
    projectRoot = getProjectRoot();
  }
  let providerConfigured = opts.providerConfigured;
  if (providerConfigured === undefined) {
    try {
      const { loadDecideConnection } = await import('../credentials.js');
      providerConfigured = loadDecideConnection() !== null;
    } catch {
      providerConfigured = false;
    }
  }
  const readConfig =
    opts.readConfig ??
    (async (key: string, root: string): Promise<unknown> => {
      const { getConfigValue } = await import('../../config/registry.js');
      return getConfigValue(key, { projectRoot: root });
    });

  const now = opts.now ?? new Date();
  const activity = activityBySite(
    readAuditLines(projectRoot, now.getTime() - DECISION_SITE_ACTIVITY_WINDOW_MS),
    now,
  );
  const summaries: DecisionSiteSummary[] = [];
  for (const site of sites) {
    let configuredMode: DecisionSiteModeValue | undefined;
    if (site.modeKey !== undefined) {
      try {
        const value = await readConfig(site.modeKey, projectRoot);
        if (isDecisionSiteMode(value)) configuredMode = value;
      } catch {
        // unreadable config → default
      }
    }
    const effectiveMode: DecisionSiteModeValue =
      usesSystemOne(site) && !providerConfigured ? 'off' : (configuredMode ?? site.defaultMode);
    summaries.push({
      id: site.id,
      title: site.title,
      questionType: site.questionType,
      primaryRung: site.primaryRung,
      ladder: site.ladder,
      fallback: site.fallback,
      ownerEscalation: site.ownerEscalation,
      mode: site.defaultMode,
      ...(configuredMode !== undefined ? { configuredMode } : {}),
      effectiveMode,
      ...(site.modeKey !== undefined ? { modeKey: site.modeKey } : {}),
      ...(site.goLive !== undefined ? { goLive: site.goLive } : {}),
      task: site.task,
      last7d: activity.get(site.id) ?? NO_ACTIVITY,
    });
  }

  const matching = summaries.filter(
    (s) =>
      (opts.id === undefined || s.id === opts.id) &&
      (opts.rung === undefined || s.primaryRung === opts.rung) &&
      (opts.mode === undefined || s.effectiveMode === opts.mode) &&
      (opts.evidenceOnly !== true || s.goLive !== undefined),
  );
  return { providerConfigured, total: sites.length, sites: matching };
}
