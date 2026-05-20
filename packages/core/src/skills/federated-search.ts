/**
 * Federated skill search — query local, canonical, and federation sources
 * in parallel then rank by `trustLevel × textMatch × usage`.
 *
 * Default behaviour is OPT-IN: callers MUST pass `includeFederated=true`
 * to fan out to federation peers (per `~/.cleo/federation.json`). Without
 * that flag the search only hits the local filesystem + the optional
 * `localMarketplaceSearch` callback (typically the canonical marketplace
 * client from caamp).
 *
 * Network failures on individual federation peers DO NOT fail the whole
 * query — the search degrades gracefully and surfaces a per-peer warning
 * in the returned `warnings` array.
 *
 * @task T9731
 * @epic T9564
 * @saga T9560
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getTopUsed } from '../store/skills-store.js';
import { type FederationEntry, listFederationPeers } from './federation-store.js';
import type { SkillTrustLevel } from './skills-guard.js';

// ---------------------------------------------------------------------------
// Result + ranking types
// ---------------------------------------------------------------------------

/**
 * One result from {@link federatedSearch}.
 *
 * `source` identifies origin tier:
 *   - `'local'`           — found in `~/.cleo/skills/` or `~/.agents/skills/`
 *   - `'canonical'`       — found via the supplied marketplace callback
 *   - `'federation:<url>'`— found via one of the federation peers
 *
 * `usage` is populated from `skill_usage` rollups when available — used by
 * the ranker but never required.
 */
export interface FederatedSearchResult {
  /** Skill name (basename / scoped). */
  readonly name: string;
  /** Origin tier label. */
  readonly source: string;
  /** Trust level resolved from the origin. */
  readonly trustLevel: SkillTrustLevel;
  /** Raw text-match score before trust + usage weighting. */
  readonly textMatchScore: number;
  /** Final ranked score (deterministic for given inputs). */
  readonly score: number;
  /** Optional description (rendered in CLI). */
  readonly description?: string;
  /** Optional usage count (number of `skill_usage` rows). */
  readonly usage?: number;
}

/**
 * Options accepted by {@link federatedSearch}.
 *
 * `localMarketplaceSearch` is a callback to keep the canonical marketplace
 * client (which lives in caamp) out of the core dep graph. Pass `undefined`
 * to skip canonical lookup entirely.
 */
export interface FederatedSearchOptions {
  /** Search query — case-insensitive substring match. */
  readonly query: string;
  /** OPT-IN flag: when `true`, fan out to federation peers. */
  readonly includeFederated?: boolean;
  /** Maximum results per source (NOT total). */
  readonly perSourceLimit?: number;
  /** Optional override for the federation index path (test hook). */
  readonly federationIndexPath?: string;
  /** Optional local-skills root override (defaults to `~/.cleo/skills`). */
  readonly localSkillsRoot?: string;
  /** Optional callback to query the canonical marketplace. */
  readonly localMarketplaceSearch?: (
    q: string,
  ) => Promise<ReadonlyArray<{ name: string; description?: string; scopedName?: string }>>;
  /** Optional callback to query a federation peer URL. */
  readonly fetchPeer?: (
    peer: FederationEntry,
    q: string,
  ) => Promise<ReadonlyArray<{ name: string; description?: string }>>;
}

/**
 * Composite shape returned by {@link federatedSearch}.
 */
export interface FederatedSearchResponse {
  /** Ranked results across every searched source. */
  readonly results: readonly FederatedSearchResult[];
  /** Per-source warnings (network failures, parse errors). */
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Ranking algorithm
// ---------------------------------------------------------------------------

const TRUST_WEIGHTS: Readonly<Record<SkillTrustLevel, number>> = {
  builtin: 4,
  trusted: 3,
  community: 2,
  'agent-created': 1,
};

/**
 * Compute the final score for a candidate.
 *
 * Formula: `trustWeight × textMatchScore × (1 + log(1 + usage))`.
 *
 * The log term means a skill used 100 times scores ~3× higher than the
 * unused one — but a never-used skill still scores `1× trust × match`
 * rather than zero, so brand-new federation skills remain discoverable.
 *
 * @param trustLevel - Resolved trust tier.
 * @param textMatchScore - Raw text match (1.0 = exact name hit, 0.5 = description).
 * @param usage - Optional usage count (defaults to 0).
 * @returns Numeric score — higher is better.
 *
 * @task T9731
 */
export function computeScore(
  trustLevel: SkillTrustLevel,
  textMatchScore: number,
  usage: number = 0,
): number {
  const usageFactor = 1 + Math.log1p(Math.max(0, usage));
  return TRUST_WEIGHTS[trustLevel] * textMatchScore * usageFactor;
}

// ---------------------------------------------------------------------------
// Local filesystem search
// ---------------------------------------------------------------------------

function defaultLocalSkillsRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  return join(home, '.cleo', 'skills');
}

/**
 * Compute the user-level `~/.agents/skills/` path for the current process'
 * `$HOME` (or `$USERPROFILE` on Windows).
 *
 * @remarks
 * Despite the historical naming, this helper resolves the bridge mount
 * (`~/.agents/skills/`), NOT the XDG legacy root
 * (`~/.local/share/agents/skills/`). Kept as a helper rather than inlining
 * the SSoT export {@link AGENTS_SKILLS_BRIDGE_PATH} because the test suite
 * monkey-patches `process.env.HOME` between runs — using the SSoT const
 * (which is bound at module-load time) would break those tests. T9745
 * removes only the duplicated path resolvers that DO recompute on each
 * call; this helper was renamed away from its previous misleading name
 * (which suggested the XDG legacy location) to reflect that it actually
 * computes the bridge mount.
 *
 * @returns Absolute path to `<HOME>/.agents/skills/`.
 *
 * @internal
 */
function bridgeAgentsSkillsRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  return join(home, '.agents', 'skills');
}

function readSkillName(skillDir: string): string | null {
  try {
    const skillMd = join(skillDir, 'SKILL.md');
    if (!existsSync(skillMd)) return null;
    const text = readFileSync(skillMd, 'utf8').slice(0, 4096);
    const nameMatch = /^name:\s*["']?([\w\-./@]+)["']?/m.exec(text);
    if (nameMatch?.[1]) return nameMatch[1];
    return skillDir.split('/').filter(Boolean).pop() ?? null;
  } catch {
    return null;
  }
}

function readSkillDescription(skillDir: string): string | undefined {
  try {
    const skillMd = join(skillDir, 'SKILL.md');
    if (!existsSync(skillMd)) return undefined;
    const text = readFileSync(skillMd, 'utf8').slice(0, 4096);
    const m = /^description:\s*["']?([^"'\n]+)["']?/m.exec(text);
    return m?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function textMatch(query: string, name: string, description?: string): number {
  const q = query.toLowerCase();
  if (!q) return 0;
  const n = name.toLowerCase();
  if (n === q) return 1.0;
  if (n.startsWith(q)) return 0.8;
  if (n.includes(q)) return 0.6;
  if (description?.toLowerCase().includes(q)) return 0.4;
  return 0;
}

function searchLocalRoot(
  root: string,
  query: string,
  sourceLabel: string,
): FederatedSearchResult[] {
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: FederatedSearchResult[] = [];
  for (const entry of entries) {
    const full = join(root, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const name = readSkillName(full);
    if (!name) continue;
    const description = readSkillDescription(full);
    const score = textMatch(query, name, description);
    if (score > 0) {
      out.push({
        name,
        source: sourceLabel,
        trustLevel: 'builtin',
        textMatchScore: score,
        score: 0, // filled by caller after usage merge
        description,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a federated skill search across every enabled source tier.
 *
 * Search order (each tier is a NO-OP when its source is empty / disabled):
 *   1. Local `~/.cleo/skills/` (always — `builtin` trust)
 *   2. Legacy `~/.agents/skills/` (always — `builtin` trust)
 *   3. Canonical marketplace via `localMarketplaceSearch` (always when supplied)
 *   4. Federation peers from `federation.json` (ONLY when `includeFederated=true`)
 *
 * Usage data merges via {@link getTopUsed} when the skills DB is available,
 * but a missing DB is non-fatal (search still works, just without
 * usage-weighted ranking).
 *
 * @param opts - Search options — see {@link FederatedSearchOptions}.
 * @returns Ranked results + warnings. Results sorted by `score DESC`.
 *
 * @task T9731
 */
export async function federatedSearch(
  opts: FederatedSearchOptions,
): Promise<FederatedSearchResponse> {
  const query = (opts.query ?? '').trim();
  const warnings: string[] = [];
  const all: FederatedSearchResult[] = [];

  // 1 + 2. Local filesystem roots.
  const localRoot = opts.localSkillsRoot ?? defaultLocalSkillsRoot();
  all.push(...searchLocalRoot(localRoot, query, 'local'));
  // Legacy ~/.agents/skills only when no explicit root override.
  if (!opts.localSkillsRoot) {
    all.push(...searchLocalRoot(bridgeAgentsSkillsRoot(), query, 'local'));
  }

  // 3. Canonical marketplace.
  if (opts.localMarketplaceSearch) {
    try {
      const rows = await opts.localMarketplaceSearch(query);
      for (const r of rows) {
        const score = textMatch(query, r.name, r.description);
        if (score > 0) {
          all.push({
            name: r.scopedName ?? r.name,
            source: 'canonical',
            trustLevel: 'trusted',
            textMatchScore: score,
            score: 0,
            description: r.description,
          });
        }
      }
    } catch (err) {
      warnings.push(
        `canonical marketplace lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 4. Federation peers (opt-in only).
  if (opts.includeFederated === true) {
    let peers: readonly FederationEntry[] = [];
    try {
      peers = listFederationPeers(opts.federationIndexPath);
    } catch (err) {
      warnings.push(
        `federation index unreadable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const tasks = peers
      .filter((p) => p.trust !== 'blocked')
      .map(async (peer) => {
        if (!opts.fetchPeer) return [] as FederatedSearchResult[];
        try {
          const rows = await opts.fetchPeer(peer, query);
          const trustLevel: SkillTrustLevel = peer.trust === 'verified' ? 'trusted' : 'community';
          const matched: FederatedSearchResult[] = [];
          for (const r of rows) {
            const score = textMatch(query, r.name, r.description);
            if (score <= 0) continue;
            matched.push({
              name: r.name,
              source: `federation:${peer.url}`,
              trustLevel,
              textMatchScore: score,
              score: 0,
              description: r.description,
            });
          }
          return matched;
        } catch (err) {
          warnings.push(
            `federation peer ${peer.url} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          return [];
        }
      });
    for (const r of await Promise.all(tasks)) all.push(...r);
  }

  // Merge usage rollup — best-effort, never fail the search on DB error.
  let usageRollup: Map<string, number> = new Map();
  try {
    const rows = await getTopUsed(500);
    usageRollup = new Map(rows.map((r) => [r.skillName, r.count]));
  } catch {
    // DB unavailable — usage stays at 0, ranker still works.
  }

  // Apply rank.
  const perSourceLimit = opts.perSourceLimit ?? 100;
  const limited = all.slice(0, perSourceLimit * 4);
  const ranked = limited.map((r) => {
    const usage = usageRollup.get(r.name) ?? 0;
    return {
      ...r,
      usage,
      score: computeScore(r.trustLevel, r.textMatchScore, usage),
    } satisfies FederatedSearchResult;
  });

  // Stable sort: score DESC then name ASC.
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });

  return { results: ranked, warnings };
}
