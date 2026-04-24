/**
 * Registry-backed agent resolver with 5-tier precedence.
 *
 * Lookup order (highest wins):
 *   1. `project`   — rows in global `signaldock.db:agents` tagged
 *                    `tier='project'` (attached from
 *                    `<projectRoot>/.cleo/cant/agents/`).
 *   2. `global`    — rows tagged `tier='global'` installed from
 *                    `~/.local/share/cleo/cant/agents/`.
 *   3. `packaged`  — rows tagged `tier='packaged'` installed from the
 *                    bundled `@cleocode/agents/seed-agents/` tree.
 *   4. `fallback`  — no row exists; a synthetic `ResolvedAgent` is
 *                    synthesized on-the-fly from the bundled
 *                    `seed-agents/<id>.cant` file if one is on disk.
 *   5. `universal` — tiers 1-4 all missed; a synthetic `ResolvedAgent`
 *                    is synthesized from the universal protocol base at
 *                    `@cleocode/agents/cleo-subagent.cant`. Added in
 *                    v2026.4.111 (T1241 / D035) so classifier output can
 *                    never trigger `E_AGENT_NOT_FOUND` when the universal
 *                    base file is reachable. Emits a WARN log when taken.
 *
 * The GLOBAL `signaldock.db:agents` row is the single source of truth for
 * tier-aware metadata. The `agents.agent_id` column is UNIQUE across the
 * whole table (see `signaldock-sqlite.ts` schema), so a single row exists
 * per agent — `tier` records which directory holds the canonical `.cant`.
 *
 * Orphan-row detection (doctor D-002): if the row's `cant_path` points at
 * a file that no longer exists, the row is skipped and resolution falls
 * through to the next tier instead of failing hard. This preserves spawn
 * availability when operators delete a tier's `.cant` directory without
 * running `cleo agent doctor`.
 *
 * Registry DB is always the SSoT for metadata; filesystem is secondary.
 *
 * @module agent-resolver
 * @task T889 / T898 / T899 / W2-4 / T1241
 * @epic T889 / T1232
 */

import { createHash } from 'node:crypto';
import { accessSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { AgentTier, ResolvedAgent } from '@cleocode/contracts';
import { rowToResolvedAgent } from './agent-registry-accessor.js';

// ---------------------------------------------------------------------------
// node:sqlite interop (createRequire for ESM / Vitest compat)
// ---------------------------------------------------------------------------

const _resolverRequire = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync: _DatabaseSync } = _resolverRequire('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => _DatabaseSyncType;
};
// Referenced only for type narrowing; runtime handles come from callers.
void _DatabaseSync;

// ---------------------------------------------------------------------------
// Tier constants
// ---------------------------------------------------------------------------

/**
 * Canonical tier identifier for the universal-base fallback (5th tier).
 *
 * Exported so dispatch-layer code can compare against a single source of
 * truth rather than string-literal the value in multiple places.
 *
 * @task T1241 / D035
 */
export const AGENT_TIER_UNIVERSAL: AgentTier = 'universal';

/**
 * Canonical agentId of the universal protocol base shipped by
 * `@cleocode/agents`. Used exclusively by the 5th-tier universal fallback
 * path in {@link resolveAgent}.
 *
 * @task T1241 / D035
 */
export const AGENT_UNIVERSAL_BASE_ID = 'cleo-subagent';

// ---------------------------------------------------------------------------
// Deprecated alias table
// ---------------------------------------------------------------------------

/**
 * Deprecated agent IDs that should be rewritten to their replacement.
 *
 * Reserved as an extension point for future clean-forward migrations. Empty
 * by default — CLEO does not ship backward-compatibility aliases for agent
 * IDs. Agent renames must be propagated to every call site before release.
 *
 * When an alias is applied, `ResolvedAgent.aliasApplied` is set to `true`
 * and `aliasTarget` is populated with the effective canonical id so callers
 * can emit a deprecation warning at the UI layer.
 *
 * @task T889 / W2-4 · T1257 (emptied per clean-forward directive)
 */
export const DEPRECATED_ALIASES: Readonly<Record<string, string>> = Object.freeze({});

// ---------------------------------------------------------------------------
// Error contract
// ---------------------------------------------------------------------------

/**
 * Thrown when every tier in `resolveAgent` fails to produce a record.
 *
 * Exit code `65` is reserved for agent-resolution misses by the CLI dispatch
 * layer. The attached `triedTiers` list records the lookup order actually
 * walked so operators can see which tiers were exhausted.
 *
 * @task T889 / W2-4
 */
export class AgentNotFoundError extends Error {
  readonly code = 'E_AGENT_NOT_FOUND';
  readonly exitCode = 65;
  constructor(
    readonly agentId: string,
    readonly triedTiers: AgentTier[],
  ) {
    super(
      `E_AGENT_NOT_FOUND: agent '${agentId}' not found in any tier (${triedTiers.join(', ')}). ` +
        `Install with: cleo agent install <path-to-cant> --global`,
    );
    this.name = 'AgentNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Public options / helpers
// ---------------------------------------------------------------------------

/**
 * Optional configuration for {@link resolveAgent}.
 *
 * @task T889 / W2-4
 */
export interface ResolveAgentOptions {
  /**
   * Absolute path to the project root. Present in the envelope for callers
   * that want to display where the resolved project-tier `.cant` lives, but
   * the resolver does NOT perform its own filesystem walk inside the project
   * — the global `signaldock.db` is consulted regardless of tier.
   */
  projectRoot?: string;
  /**
   * Preferred tier to try first. When supplied, the tier is moved to the
   * head of the lookup order; the remaining tiers follow in the default
   * sequence `project → global → packaged → fallback`.
   */
  preferTier?: AgentTier;
  /**
   * When `true`, skip the {@link DEPRECATED_ALIASES} remap. Reserved for the
   * doctor walk, which needs to inspect the literal id on disk.
   */
  skipAliasCheck?: boolean;
  /**
   * Absolute path to the bundled `seed-agents/` directory used by the
   * `fallback` tier. When unset the resolver derives a default that climbs
   * out of `packages/core/dist` into `packages/agents/seed-agents/`. Tests
   * can pin this to an isolated fixture directory.
   */
  packagedSeedDir?: string;
  /**
   * Absolute path to the universal protocol base `.cant` file used by the
   * `universal` (5th) tier. When unset the resolver derives a default that
   * climbs out of `packages/core/dist` into
   * `packages/agents/cleo-subagent.cant`. Tests can pin this to an
   * isolated fixture file; passing a path that does not exist is equivalent
   * to disabling the tier and causes the resolver to throw
   * {@link AgentNotFoundError} when all four prior tiers miss.
   *
   * @task T1241 / D035
   */
  universalBasePath?: string;
}

// ---------------------------------------------------------------------------
// Minimal `agents` row shape (local copy to avoid circular imports)
// ---------------------------------------------------------------------------

/**
 * Row projection consumed by {@link rowToResolvedAgent}. Kept narrow and local
 * to preserve the public contract of `agent-registry-accessor.ts` (which does
 * not re-export the extended row interface).
 *
 * @task T889 / W2-4
 */
interface ResolverAgentRow {
  id: string;
  agent_id: string;
  name: string;
  description: string | null;
  class: string;
  privacy_tier: string;
  capabilities: string;
  skills: string;
  transport_type: string;
  api_key_encrypted: string | null;
  api_base_url: string;
  classification: string | null;
  transport_config: string;
  is_active: number;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
  tier?: string;
  can_spawn?: number;
  orch_level?: number;
  reports_to?: string | null;
  cant_path?: string | null;
  cant_sha256?: string | null;
  installed_from?: string | null;
  installed_at?: string | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a single agent using the 5-tier registry precedence.
 *
 * Tiers walked in order: `project` → `global` → `packaged` → `fallback` →
 * `universal`. The 5th (`universal`) tier was added in v2026.4.111 (T1241)
 * and synthesises an envelope from `@cleocode/agents/cleo-subagent.cant`
 * when every prior tier misses. As long as the universal-base file is
 * reachable on disk, this function no longer throws
 * {@link AgentNotFoundError} — the error becomes genuinely exceptional
 * (catastrophic missing base file) rather than a routine resolution miss.
 *
 * @param db      - Open handle to global `signaldock.db`. Caller owns lifecycle.
 * @param agentId - Business identifier of the agent to resolve.
 * @param options - Optional lookup overrides (see {@link ResolveAgentOptions}).
 * @returns The highest-precedence {@link ResolvedAgent} envelope.
 * @throws {AgentNotFoundError} When every tier — including the universal
 *                               base fallback — misses. Surfaces only when
 *                               `@cleocode/agents/cleo-subagent.cant` is
 *                               unreachable.
 * @task T889 / W2-4 / T1241
 */
export function resolveAgent(
  db: DatabaseSync,
  agentId: string,
  options: ResolveAgentOptions = {},
): ResolvedAgent {
  // 1. DEPRECATED_ALIASES remap
  let effectiveId = agentId;
  let aliasApplied = false;
  let aliasTarget: string | undefined;
  if (!options.skipAliasCheck && agentId in DEPRECATED_ALIASES) {
    const target = DEPRECATED_ALIASES[agentId];
    if (target) {
      effectiveId = target;
      aliasApplied = true;
      aliasTarget = target;
    }
  }

  const tiersToTry = orderTiers(options.preferTier);
  const triedTiers: AgentTier[] = [];

  for (const tier of tiersToTry) {
    triedTiers.push(tier);
    const resolved = tryResolveAtTier(db, effectiveId, tier, options);
    if (resolved) {
      // Universal tier self-reports aliasApplied/aliasTarget to signal that
      // the caller received the base persona — do NOT overwrite with the
      // DEPRECATED_ALIASES target because the universal envelope's
      // aliasTarget is describing the synthetic base, not a deprecation
      // redirect. For every other tier we propagate the alias state.
      if (aliasApplied && resolved.tier !== 'universal') {
        resolved.aliasApplied = true;
        resolved.aliasTarget = aliasTarget;
      }

      // T1325: emit dispatch-trace BRAIN observation (fire-and-forget).
      // Called after resolverWarning is set (T1324) so the full envelope is
      // available. Uses dynamic import to avoid hoisting side-effects on the
      // node:sqlite interop block above (keeps the resolver synchronous-safe in
      // Vitest). Errors are swallowed to preserve the synchronous return path.
      const projectRoot = options.projectRoot ?? process.cwd();
      const fallbackUsed = resolved.tier === AGENT_TIER_UNIVERSAL;
      import('../memory/dispatch-trace.js')
        .then(({ emitDispatchTrace }) =>
          emitDispatchTrace(projectRoot, {
            taskId: '',
            predictedAgentId: agentId,
            confidence: 0,
            reason: fallbackUsed
              ? `universal-base fallback engaged after tiers: ${triedTiers.slice(0, -1).join(', ')}`
              : `resolved at tier '${resolved.tier}'`,
            registryHit: !fallbackUsed && resolved.tier !== 'fallback',
            fallbackUsed,
            resolverWarning: resolved.resolverWarning,
            resolvedAt: new Date().toISOString(),
          }),
        )
        .catch(() => undefined);

      return resolved;
    }
  }

  throw new AgentNotFoundError(agentId, triedTiers);
}

/**
 * Resolve a batch of agent ids, collecting misses as
 * {@link AgentNotFoundError} entries in the result map instead of throwing.
 *
 * Any unexpected error from {@link resolveAgent} propagates. Only the
 * structured "not found" envelope is collected as a per-id value.
 *
 * @param db       - Open handle to global `signaldock.db`.
 * @param agentIds - Business ids to resolve.
 * @param options  - Shared lookup options applied to every id.
 * @returns Map keyed by agentId with the envelope or the not-found error.
 * @task T889 / W2-4
 */
export function resolveAgentsBatch(
  db: DatabaseSync,
  agentIds: string[],
  options: ResolveAgentOptions = {},
): Map<string, ResolvedAgent | AgentNotFoundError> {
  const result = new Map<string, ResolvedAgent | AgentNotFoundError>();
  for (const id of agentIds) {
    try {
      const resolved = resolveAgent(db, id, options);
      result.set(id, resolved);
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        result.set(id, err);
      } else {
        throw err;
      }
    }
  }
  return result;
}

/**
 * Read the skill slugs attached to an agent via the `agent_skills` junction.
 *
 * The junction is the source of truth for skill bindings (see
 * `agent-registry-accessor.ts`). Skills JSON on `agents.skills` is a
 * materialised cache — this helper reads junction rows directly so callers
 * always see post-install state.
 *
 * Lookup: `agents.agent_id = ?` → `agents.id` → junction `agent_skills` →
 * `skills.slug`. Ordered by `attached_at DESC` (most-recent attachment first).
 *
 * @param db      - Open handle to global `signaldock.db`.
 * @param agentId - Business id of the agent whose skills to read.
 * @returns Skill slugs, deduplicated. Returns `[]` when none attached.
 * @task T889 / W2-4
 */
export function getAgentSkills(db: DatabaseSync, agentId: string): string[] {
  const agentRow = db.prepare('SELECT id FROM agents WHERE agent_id = ?').get(agentId) as
    | { id: string }
    | undefined;
  if (!agentRow) return [];
  const rows = db
    .prepare(
      `SELECT skills.slug AS slug
         FROM agent_skills
         JOIN skills ON skills.id = agent_skills.skill_id
        WHERE agent_skills.agent_id = ?
        ORDER BY agent_skills.attached_at DESC`,
    )
    .all(agentRow.id) as Array<{ slug: string }>;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    if (!seen.has(row.slug)) {
      seen.add(row.slug);
      out.push(row.slug);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the tier lookup order, placing {@link ResolveAgentOptions.preferTier}
 * (when supplied) at the head.
 *
 * @param preferred - Tier to prioritise, or `undefined` for the default order.
 * @returns Lookup sequence.
 * @task T889 / W2-4
 */
function orderTiers(preferred: AgentTier | undefined): AgentTier[] {
  const defaultOrder: AgentTier[] = ['project', 'global', 'packaged', 'fallback', 'universal'];
  if (!preferred) return defaultOrder;
  const remaining = defaultOrder.filter((tier) => tier !== preferred);
  return [preferred, ...remaining];
}

/**
 * Attempt to resolve `agentId` at the given tier.
 *
 * `project`, `global`, `packaged` — load the global `signaldock.db:agents`
 * row with `tier = ?`, validate `.cant` still exists on disk, then delegate
 * to {@link rowToResolvedAgent}. Missing file (orphan row, D-002) returns
 * `null` so the caller can cascade.
 *
 * `fallback` — synthesise an envelope when `seed-agents/<id>.cant` exists
 * on disk but no DB row has been written.
 *
 * @param db      - Open handle to global `signaldock.db`.
 * @param agentId - Business id of the agent.
 * @param tier    - Tier to attempt.
 * @param options - Shared lookup options.
 * @returns Envelope or `null` when the tier misses.
 * @task T889 / W2-4
 */
function tryResolveAtTier(
  db: DatabaseSync,
  agentId: string,
  tier: AgentTier,
  options: ResolveAgentOptions,
): ResolvedAgent | null {
  if (tier === 'fallback') {
    return tryResolveFallback(agentId, options);
  }

  if (tier === 'universal') {
    return tryResolveUniversalBase(agentId, options);
  }

  const row = db
    .prepare('SELECT * FROM agents WHERE agent_id = ? AND tier = ? LIMIT 1')
    .get(agentId, tier) as ResolverAgentRow | undefined;
  if (!row) return null;

  const envelope = rowToResolvedAgent(row);
  if (!envelope) return null;

  // Verify the .cant file still exists on disk (orphan row → cascade).
  if (envelope.cantPath && !fileExists(envelope.cantPath)) {
    console.warn(
      `[agent-resolver] WARN: orphan row for agent_id='${agentId}' at tier='${tier}': ` +
        `cant_path='${envelope.cantPath}' no longer exists. Skipping to next tier. ` +
        `Run 'cleo agent doctor' to repair.`,
    );
    return null;
  }

  // Populate skills from the junction (SSoT). If the junction has zero rows
  // the cached JSON on `agents.skills` stays authoritative for display.
  const junctionSkills = getAgentSkills(db, agentId);
  if (junctionSkills.length > 0) {
    envelope.skills = junctionSkills;
  }

  envelope.source = tier;
  envelope.tier = tier;
  return envelope;
}

/**
 * Synthesise a `fallback`-tier envelope from a bundled seed `.cant` file.
 *
 * Used when no row exists at any registry tier AND the caller still wants a
 * spawnable agent envelope. Matches the design-doc contract: `canSpawn=false`,
 * `orchLevel=2`, `reportsTo=null`, `skills=[]`. The envelope is labelled
 * `tier='fallback'` regardless of the file's origin so callers can emit a
 * "running from packaged defaults" notice in the UI.
 *
 * @param agentId - Business id of the agent to synthesise.
 * @param options - Options with optional `packagedSeedDir` override.
 * @returns Fallback envelope, or `null` when no seed file exists.
 * @task T889 / W2-4
 */
function tryResolveFallback(agentId: string, options: ResolveAgentOptions): ResolvedAgent | null {
  const seedDir = options.packagedSeedDir ?? resolveDefaultSeedDir();
  const path = join(seedDir, `${agentId}.cant`);
  if (!fileExists(path)) return null;
  const bytes = readFileSync(path);
  const hash = createHash('sha256').update(bytes).digest('hex');
  return {
    agentId,
    tier: 'fallback',
    cantPath: path,
    cantSha256: hash,
    canSpawn: false,
    orchLevel: 2,
    reportsTo: null,
    skills: [],
    source: 'fallback',
    aliasApplied: false,
  };
}

/**
 * Compute the default directory used by the `fallback` tier.
 *
 * Climbs out of the compiled `packages/core/dist/store/` location and into
 * the sibling `packages/agents/seed-agents/` directory shipped with the
 * workspace. Tests that need isolation should pass `packagedSeedDir`
 * explicitly rather than relying on this default.
 *
 * @returns Absolute path to the default seed directory.
 * @task T889 / W2-4
 */
function resolveDefaultSeedDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/core/src/store/agent-resolver.ts (or dist/store/agent-resolver.js)
  // → climb to packages/, then into packages/agents/seed-agents/.
  return resolve(here, '..', '..', '..', 'agents', 'seed-agents');
}

/**
 * Compute the default path to the universal-base `.cant` file.
 *
 * Walks a short set of candidates covering the workspace (`src/`) and
 * compiled (`dist/`) layouts, and the installed-package layout inside
 * `node_modules`. The first path that exists on disk wins.
 *
 * @returns Absolute path to `cleo-subagent.cant`, or `null` when unresolved.
 * @task T1241 / D035
 */
function resolveDefaultUniversalBasePath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // packages/core/src/store/ → packages/agents/cleo-subagent.cant
    resolve(here, '..', '..', '..', 'agents', 'cleo-subagent.cant'),
    // packages/core/dist/store/ → packages/agents/cleo-subagent.cant
    resolve(here, '..', '..', '..', '..', 'agents', 'cleo-subagent.cant'),
    // node_modules/@cleocode/core/dist/store/ → @cleocode/agents/cleo-subagent.cant
    resolve(here, '..', '..', '..', '..', '..', 'agents', 'cleo-subagent.cant'),
  ];
  return candidates.find((p) => fileExists(p)) ?? null;
}

/**
 * Synthesise a `universal`-tier envelope from the universal protocol base.
 *
 * Used when every preceding tier (project / global / packaged / fallback)
 * missed for the requested agentId. The universal base lives at
 * `@cleocode/agents/cleo-subagent.cant` (per D035) and acts as the final
 * safety net: its presence on disk guarantees that classifier output never
 * triggers `E_AGENT_NOT_FOUND` during orchestration.
 *
 * The synthetic envelope is labelled:
 *
 *  - `tier='universal'`, `source='universal'`
 *  - `aliasApplied=true`, `aliasTarget='cleo-subagent'` so callers can emit
 *    a deprecation/fallback notice and trace the actual persona the caller
 *    receives.
 *  - `canSpawn=false`, `orchLevel=2`, `reportsTo=null`, `skills=[]` — the
 *    same minimal shape as the 4th-tier `fallback` envelope.
 *
 * A WARN log is emitted exactly once per call describing the requested
 * agentId, so operators can see that the universal base was engaged.
 *
 * @param agentId - Business id of the agent the caller originally asked for.
 *                   Preserved in the envelope's `agentId` field so spawn
 *                   diagnostics remain traceable to the classifier output.
 * @param options - Options with optional `universalBasePath` override.
 * @returns Universal-base envelope, or `null` when the base file is missing.
 * @task T1241 / D035
 */
function tryResolveUniversalBase(
  agentId: string,
  options: ResolveAgentOptions,
): ResolvedAgent | null {
  const basePath = options.universalBasePath ?? resolveDefaultUniversalBasePath();
  if (basePath === null || !fileExists(basePath)) return null;

  const bytes = readFileSync(basePath);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const resolverWarning =
    `[agent-resolver] agent '${agentId}' not found in project/global/packaged/fallback tiers — ` +
    `falling back to universal base '${AGENT_UNIVERSAL_BASE_ID}' at '${basePath}'. ` +
    `Run 'cleo agent install --global <path>' to register a concrete persona.`;
  return {
    agentId,
    tier: 'universal',
    cantPath: basePath,
    cantSha256: hash,
    canSpawn: false,
    orchLevel: 2,
    reportsTo: null,
    skills: [],
    source: 'universal',
    aliasApplied: true,
    aliasTarget: AGENT_UNIVERSAL_BASE_ID,
    resolverWarning,
  };
}

/**
 * Test whether a path exists on disk without throwing.
 *
 * @param path - Absolute path to check.
 * @returns `true` when the path is reachable, `false` otherwise.
 * @task T889 / W2-4
 */
function fileExists(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}
