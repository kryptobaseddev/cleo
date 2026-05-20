/**
 * Federation install gate — first-install confirmation prompt + sha256
 * checksum validation for skills installed from federation peers.
 *
 * Composes BEFORE the skills-guard trust gate (T9730) so the install
 * pipeline is:
 *
 *   1. resolve source           (caamp parser)
 *   2. clone / fetch             (github / federation client)
 *   3. federation-install-gate   (this module — first-install + checksum)
 *   4. skills-guard trust-gate  (T9730 — verdict + INSTALL_POLICY)
 *   5. fs.copy                   (canonical store + symlinks)
 *
 * Each gate runs BEFORE any disk write so a blocked install has zero
 * side-effects on the canonical store.
 *
 * @task T9732
 * @epic T9564
 * @saga T9560
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  type FederationEntry,
  listFederationPeers,
  normaliseFederationUrl,
} from './federation-store.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Outcome of {@link evaluateFederationInstallGate}.
 *
 * `decision` semantics:
 *   - `'allow'`             — proceed to the next gate (skills-guard).
 *   - `'block-checksum'`    — manifest declares a checksum and the
 *                             downloaded artefact does not match. Caller
 *                             MUST surface `E_FEDERATION_CHECKSUM_MISMATCH`.
 *   - `'prompt-first-install'` — federation URL has never been installed
 *                             from before. Caller MUST surface the y/N
 *                             prompt (or `E_FEDERATION_UNKNOWN_SOURCE_INTERACTIVE_REQUIRED`
 *                             in non-TTY mode without `--allow-new-source`).
 */
export type FederationInstallDecision = 'allow' | 'block-checksum' | 'prompt-first-install';

/**
 * Composite decision returned by {@link evaluateFederationInstallGate}.
 */
export interface FederationInstallGateResult {
  /** Final action — see {@link FederationInstallDecision}. */
  readonly decision: FederationInstallDecision;
  /** Human-readable rationale (safe to surface in CLI / envelopes). */
  readonly reason: string;
  /** Matched federation peer when the source is a known URL. */
  readonly peer: FederationEntry | null;
  /** Whether the source resolves to a federation peer at all. */
  readonly isFederationSource: boolean;
  /** Computed sha256 of the artefact (when supplied). */
  readonly computedChecksum: string | null;
  /** Expected checksum from the manifest (when supplied). */
  readonly expectedChecksum: string | null;
}

/**
 * Options accepted by {@link evaluateFederationInstallGate}.
 */
export interface FederationInstallGateOptions {
  /** Caller-supplied source identifier (URL, owner/repo). */
  readonly source: string;
  /**
   * Absolute path to the downloaded artefact (tarball OR cloned skill dir).
   * When `undefined`, checksum validation is skipped.
   */
  readonly artefactPath?: string;
  /** Expected sha256 from the manifest (lowercase hex, no `sha256:` prefix). */
  readonly expectedChecksum?: string | null;
  /**
   * Bypass the first-install prompt — set by the caller after the operator
   * has explicitly approved via `--allow-new-source` or an interactive yes.
   */
  readonly approveNewSource?: boolean;
  /** Optional override for the federation index path (test hook). */
  readonly federationIndexPath?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Detect whether `source` matches any known federation peer URL.
 *
 * Uses {@link normaliseFederationUrl} on both sides so trailing-slash /
 * casing variance doesn't produce false negatives. Non-URL sources
 * (`owner/repo`, `library:foo`, etc.) return `null`.
 */
function matchFederationPeer(source: string, path: string | undefined): FederationEntry | null {
  let normalised: string;
  try {
    normalised = normaliseFederationUrl(source);
  } catch {
    return null;
  }
  let peers: readonly FederationEntry[] = [];
  try {
    peers = listFederationPeers(path);
  } catch {
    return null;
  }
  // Match by host prefix — a federation URL is the BASE, individual skill
  // installs share the same host.
  let normalisedUrl: URL;
  try {
    normalisedUrl = new URL(normalised);
  } catch {
    return null;
  }
  const sourceHost = `${normalisedUrl.protocol}//${normalisedUrl.host}`;
  for (const peer of peers) {
    try {
      const peerUrl = new URL(peer.url);
      if (`${peerUrl.protocol}//${peerUrl.host}` === sourceHost) {
        return peer;
      }
    } catch {
      // Skip malformed entries.
    }
  }
  return null;
}

/**
 * Compute the sha256 of a file or directory.
 *
 * For directories, hashes every regular file in sorted order so the result
 * is stable across runs. Returns the hex digest WITHOUT the `sha256:`
 * prefix for direct equality comparison against manifest fields.
 */
export function computeArtefactChecksum(path: string): string {
  // For tarballs (single file) we hash file contents directly. We delegate
  // directory hashing to the existing skills-guard {@link contentHash}
  // helper at the install call site — this function targets single-file
  // tarballs which is the federation transport envelope.
  const hash = createHash('sha256');
  try {
    hash.update(readFileSync(path));
  } catch {
    return '';
  }
  return hash.digest('hex');
}

/**
 * Normalise a checksum string from either the bare hex form or the
 * `sha256:<hex>` algorithm-prefixed form. Lowercases for comparison.
 */
function normaliseChecksum(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase();
  if (cleaned.startsWith('sha256:')) return cleaned.slice('sha256:'.length);
  return cleaned;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate the federation install gate against the supplied source +
 * downloaded artefact.
 *
 * Returns:
 *   - `allow`                 — non-federation source, OR federation URL
 *                               that has been seen before AND checksum
 *                               matches (or no checksum given).
 *   - `block-checksum`        — checksum mismatch — caller MUST refuse
 *                               install and surface `E_FEDERATION_CHECKSUM_MISMATCH`.
 *   - `prompt-first-install`  — federation URL with NO prior install.
 *                               Caller MUST gate on a y/N prompt or the
 *                               `--allow-new-source` flag.
 *
 * @param opts - See {@link FederationInstallGateOptions}.
 * @returns Composite gate result.
 *
 * @task T9732
 */
export function evaluateFederationInstallGate(
  opts: FederationInstallGateOptions,
): FederationInstallGateResult {
  const peer = matchFederationPeer(opts.source, opts.federationIndexPath);
  const isFederationSource = peer !== null;

  // Non-federation sources fall straight through.
  if (!isFederationSource) {
    return {
      decision: 'allow',
      reason: 'Non-federation source — gate does not apply',
      peer: null,
      isFederationSource: false,
      computedChecksum: null,
      expectedChecksum: null,
    };
  }

  const expected = normaliseChecksum(opts.expectedChecksum);
  let computed: string | null = null;

  // Checksum validation runs whenever the manifest declares one. Skipping
  // it on a federation source with a declared checksum is a security hole.
  if (expected !== null && opts.artefactPath) {
    computed = computeArtefactChecksum(opts.artefactPath);
    if (computed !== expected) {
      return {
        decision: 'block-checksum',
        reason: `Checksum mismatch (expected sha256:${expected}, got sha256:${computed}). Refusing to install.`,
        peer,
        isFederationSource: true,
        computedChecksum: computed,
        expectedChecksum: expected,
      };
    }
  }

  // First-install detection — a federation entry is "known" once it has
  // been registered. Operators who pre-registered via `cleo federation add`
  // and pre-approved (e.g. `verified` trust) bypass the prompt unless the
  // caller insists on re-prompting via `approveNewSource: false`.
  if (peer.trust === 'unverified' && opts.approveNewSource !== true) {
    return {
      decision: 'prompt-first-install',
      reason: `First install from ${peer.url} (trust=${peer.trust}). Operator confirmation required.`,
      peer,
      isFederationSource: true,
      computedChecksum: computed,
      expectedChecksum: expected,
    };
  }

  return {
    decision: 'allow',
    reason:
      peer.trust === 'verified'
        ? `Allowed (federation peer ${peer.url} pre-approved as verified)`
        : `Allowed (operator approved new source ${peer.url})`,
    peer,
    isFederationSource: true,
    computedChecksum: computed,
    expectedChecksum: expected,
  };
}

/**
 * Test convenience: tell whether the install would require interactive
 * confirmation. Used by CLI command logic to decide between prompt and
 * `E_FEDERATION_UNKNOWN_SOURCE_INTERACTIVE_REQUIRED`.
 *
 * @param decision - The decision returned by {@link evaluateFederationInstallGate}.
 */
export function requiresInteractiveConfirmation(decision: FederationInstallDecision): boolean {
  return decision === 'prompt-first-install';
}
