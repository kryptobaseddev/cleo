/**
 * Dispatch identity contracts.
 *
 * Canonical home for the three primitive identity types every dispatch
 * operation is keyed on:
 *
 *   - {@link Gateway}          — CQRS read vs write classification
 *   - {@link Tier}             — progressive-disclosure tier (0/1/2)
 *   - {@link CanonicalDomain}  — the closed set of dispatch domains
 *
 * Promoted to `@cleocode/contracts` in Phase 0b of the SG-ARCH-SOLID
 * Saga (T9831 · E-CONTRACTS-FOUNDATION T9832 · T9954) alongside
 * {@link OperationDef} / {@link Resolution}. Originally defined in
 * `packages/cleo/src/dispatch/types.ts` (lines 16, 27, 58, 86). The
 * `packages/cleo` definition is now a re-export shim — every consumer
 * continues to compile unchanged.
 *
 * `CANONICAL_DOMAINS` remains the runtime SSoT — adding/removing a
 * domain still requires editing the array here exactly as before.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9954 (Phase 0b)
 */

// ── Gateway ──────────────────────────────────────────────────────────

/**
 * CQRS gateway: read-only queries vs state-modifying mutations.
 *
 * Originally defined in `packages/cleo/src/dispatch/types.ts:16`.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9954 (Phase 0b)
 */
export type Gateway = 'query' | 'mutate';

// ── Tier ─────────────────────────────────────────────────────────────

/**
 * Progressive disclosure tier.
 *
 * - `0` — tasks + session (~80% of agents)
 * - `1` — + memory + check (~15% of agents)
 * - `2` — + pipeline + orchestrate + tools + admin + nexus (~5%)
 *
 * Originally defined in `packages/cleo/src/dispatch/types.ts:27`.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9954 (Phase 0b)
 */
export type Tier = 0 | 1 | 2;

// ── CanonicalDomain ──────────────────────────────────────────────────

/**
 * The closed set of dispatch canonical-domain names.
 *
 * T964: `conduit` promoted to first-class domain (supersedes ADR-042 Decision 1).
 * CONDUIT is agent-to-agent messaging and is semantically disjoint from
 * ORCHESTRATE (wave planning + spawn-prompt generation). The original
 * "exactly 10 canonical domains" invariant that justified folding CONDUIT
 * under ORCHESTRATE has been broken multiple times (intelligence, diagnostics,
 * docs, playbook); promoting CONDUIT aligns registry with wire-format, CLI,
 * and core module structure at zero behavior cost.
 *
 * T1726: `sentient` and `release` promoted to first-class domains. Both were
 * reachable via the CLI and had registered DomainHandlers but were absent from
 * CANONICAL_DOMAINS, making them invisible to SDK consumers via OPERATIONS.
 *
 * Originally defined in `packages/cleo/src/dispatch/types.ts:58`.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9954 (Phase 0b)
 */
export const CANONICAL_DOMAINS = [
  'tasks',
  'session',
  'memory',
  'check',
  'pipeline',
  'orchestrate',
  'tools',
  'admin',
  'nexus',
  'sticky',
  'intelligence',
  'diagnostics',
  'docs',
  'playbook',
  'conduit',
  'sentient',
  'release',
  'llm',
  // T9528: provenance-graph maintenance verbs (backfill, verify, repair).
  'provenance',
  // T9536: `cleo upgrade workflows` — re-render release-pipeline workflow
  // templates + 3-way merge with `.workflow-overrides.yml`.
  'upgrade',
  // T9546/T9547: 'cleo worktree list/prune/force-unlock' — worktree lifecycle.
  'worktree',
  // T9973: 'cleo focus <id>' — single-envelope task orientation (8 calls → 1).
  'focus',
  // T11373: 'cleo attention add|show|list' (alias 'jot') — Tier-2 scope-keyed
  // working-memory buffer (Epic T11288 · Saga T11283).
  'attention',
] as const;

/**
 * One of the canonical dispatch domain names.
 *
 * Derived as a string-literal union from {@link CANONICAL_DOMAINS} so
 * adding/removing a domain in the array automatically updates the type.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9954 (Phase 0b)
 */
export type CanonicalDomain = (typeof CANONICAL_DOMAINS)[number];
