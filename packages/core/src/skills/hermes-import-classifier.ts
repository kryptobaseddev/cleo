/**
 * Hermes import classifier — assigns trust + provenance to Hermes records
 * during `cleo skill import-hermes` (T9691).
 *
 * Runs AFTER the base mapping in {@link bulkImportFromHermes}, augmenting
 * each row's `sourceType`, `lifecycleState`, and `needsReview` based on:
 *
 *   1. {@link TRUSTED_REPOS_FOR_IMPORT} — Hermes-aligned allow-list.
 *      Records whose URL matches one of these auto-promote to
 *      `sourceType='canonical'` AND register the URL with the federation
 *      index as `trust='verified'` if not already present.
 *
 *   2. `is_agent_created=true` — preserve `sourceType='agent-created'` so
 *      Hermes provenance survives the round-trip.
 *
 *   3. Unknown URLs — default to `sourceType='community'` AND enter
 *      quarantine (`needsReview=true`) so the operator must re-approve
 *      before the skill activates. Mirrors the T9730 quarantine contract.
 *
 * ## Idempotency
 *
 * Re-running classification on the same record produces identical output
 * — federation index writes use {@link addFederationPeer}'s upsert
 * semantics so repeat imports don't accumulate duplicate peers.
 *
 * @task T9733
 * @epic T9564
 * @architecture .cleo/adrs/ADR-075-skills-federation-trust-ladder.md
 */

import { addFederationPeer } from './federation-store.js';
import { TRUSTED_REPOS } from './skills-guard.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Provenance tier assigned to an imported skill.
 *
 * Aligns with the `source_type` column on the `skills` table:
 *   - `canonical`     — official / trusted source (openai/skills, etc.).
 *   - `community`     — unknown URL — quarantined pending review.
 *   - `agent-created` — produced by Hermes `skill_manage` (auto-improver).
 */
export type ImportedSkillSourceType = 'canonical' | 'community' | 'agent-created';

/**
 * Output of {@link classifyHermesRecord}.
 */
export interface HermesClassification {
  /** Assigned source type — used to populate `skills.source_type`. */
  readonly sourceType: ImportedSkillSourceType;
  /** Whether the skill should enter quarantine (`needs_review=true`). */
  readonly needsReview: boolean;
  /** Human-readable rationale (for audit logging). */
  readonly reason: string;
  /** Federation URL that was auto-registered, if any. */
  readonly registeredFederationUrl: string | null;
}

/**
 * Subset of Hermes record fields we inspect during classification.
 *
 * Other fields (`installPath`, `version`, etc.) are pass-through — the
 * classifier doesn't read them.
 */
export interface HermesRecordInput {
  /** Skill name. */
  readonly name: string;
  /** Optional source URL (GitHub, federation, etc.). */
  readonly sourceUrl?: string | null;
  /** Whether Hermes flagged this skill as agent-created. */
  readonly isAgentCreated?: boolean;
}

/**
 * Options accepted by {@link classifyHermesRecord}.
 *
 * `federationIndexPath` is a test hook — production callers should leave
 * it unset to use the canonical `~/.cleo/federation.json` location.
 */
export interface ClassifyOptions {
  /** Override the federation index path (test hook). */
  readonly federationIndexPath?: string;
  /**
   * Allow-list of additional trusted repos (merged with {@link TRUSTED_REPOS}).
   *
   * Useful for testing — production callers should NEVER bypass the
   * Hermes-aligned canonical list.
   */
  readonly extraTrustedRepos?: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Hermes-aligned trusted-repo allow-list
// ---------------------------------------------------------------------------

/**
 * Trusted repos that auto-promote to `sourceType='canonical'` during import.
 *
 * Mirrors {@link TRUSTED_REPOS} from the skills-guard module — kept as a
 * re-export so callers reasoning about classification don't need to import
 * skills-guard directly.
 */
export const TRUSTED_REPOS_FOR_IMPORT: ReadonlySet<string> = TRUSTED_REPOS;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a stable origin identifier from a source URL or `owner/repo`
 * string. Returns:
 *   - `null` for unparseable / missing input
 *   - the lowercased GitHub `owner/repo` for github.com URLs
 *   - the URL host + path for everything else
 */
function extractOriginKey(sourceUrl: string | null | undefined): string | null {
  if (!sourceUrl) return null;
  const raw = sourceUrl.trim();
  if (!raw) return null;

  // `owner/repo` shorthand (no scheme) — keep verbatim, just lowercased.
  if (!raw.includes('://') && raw.includes('/')) {
    return raw.toLowerCase();
  }

  try {
    const url = new URL(raw);
    if (url.host === 'github.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) return `${parts[0]}/${parts[1]}`.toLowerCase();
    }
    return `${url.host}${url.pathname}`.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

function isTrustedOrigin(origin: string, extra: ReadonlySet<string> | undefined): boolean {
  if (TRUSTED_REPOS_FOR_IMPORT.has(origin)) return true;
  if (extra?.has(origin)) return true;
  // Tolerate `owner/repo/sub-path` strings — match by the first two
  // segments only.
  const parts = origin.split('/').filter(Boolean);
  if (parts.length >= 2) {
    const repo = `${parts[0]}/${parts[1]}`;
    if (TRUSTED_REPOS_FOR_IMPORT.has(repo)) return true;
    if (extra?.has(repo)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a single Hermes record for import.
 *
 * Side effect: when the record is auto-promoted to `canonical`, the
 * federation index is updated with a `verified` entry for the source's
 * host (so subsequent installs from the same domain skip the
 * first-install prompt). The federation index is NOT touched for
 * `agent-created` or `community` outcomes.
 *
 * @param record - The Hermes record (post-base-mapping).
 * @param opts   - Options — see {@link ClassifyOptions}.
 * @returns Classification verdict.
 *
 * @task T9733
 */
export function classifyHermesRecord(
  record: HermesRecordInput,
  opts: ClassifyOptions = {},
): HermesClassification {
  // Rule 2: agent-created provenance is preserved verbatim.
  if (record.isAgentCreated === true) {
    return {
      sourceType: 'agent-created',
      needsReview: false,
      reason: 'Hermes is_agent_created=true — agent-created provenance preserved',
      registeredFederationUrl: null,
    };
  }

  const origin = extractOriginKey(record.sourceUrl);

  // Rule 1: trusted-repo allow-list → canonical + federation register.
  if (origin && isTrustedOrigin(origin, opts.extraTrustedRepos)) {
    let registeredUrl: string | null = null;
    // Only register a federation peer when we can synthesise a URL.
    if (record.sourceUrl?.includes('://')) {
      try {
        const url = new URL(record.sourceUrl);
        const baseUrl = `${url.protocol}//${url.host}/`;
        const result = addFederationPeer(baseUrl, 'verified', opts.federationIndexPath);
        registeredUrl = result.entry.url;
      } catch {
        // Federation register failure is non-fatal — classification stays
        // canonical even if the peer registry write blows up.
      }
    }
    return {
      sourceType: 'canonical',
      needsReview: false,
      reason: `Trusted origin ${origin} — auto-promoted to canonical`,
      registeredFederationUrl: registeredUrl,
    };
  }

  // Rule 3: unknown URL → community + quarantine.
  return {
    sourceType: 'community',
    needsReview: true,
    reason: origin
      ? `Unknown origin ${origin} — quarantined pending review`
      : 'No source URL — quarantined pending review',
    registeredFederationUrl: null,
  };
}

/**
 * Classify a batch of Hermes records — convenience wrapper around
 * {@link classifyHermesRecord} that preserves input ordering.
 *
 * @param records - Records to classify (in import order).
 * @param opts    - Shared classification options.
 * @returns Parallel array of classifications.
 *
 * @task T9733
 */
export function classifyHermesBatch(
  records: readonly HermesRecordInput[],
  opts: ClassifyOptions = {},
): HermesClassification[] {
  return records.map((r) => classifyHermesRecord(r, opts));
}
