/**
 * Standing release authorization (T14141 · owner decision D11215): a grant the
 * owner signs with the enrolled owner key so a non-interactive
 * `cleo release cut --yes` (an agent) may tag without a typed terminal
 * confirmation.
 *
 * @task T14141
 */

/**
 * What a grant covers: `canary` (`-canary.N` versions), `prerelease` (any
 * `-suffix`), `stable` (no suffix), or one exact `v`-prefixed version.
 */
export type ReleaseAuthorizationScope = 'canary' | 'prerelease' | 'stable' | `v${string}`;

/** One owner-signed standing release authorization. */
export interface ReleaseAuthorizationGrant {
  /** Grant id (`ra-<hex>`), named in the cut audit row and the tag message. */
  id: string;
  /** Versions the grant covers. */
  scope: ReleaseAuthorizationScope;
  /** Why the owner granted it. */
  reason: string;
  /** ISO time the grant was issued. */
  issuedAt: string;
  /** ISO time it stops counting (at most 30 days after issue). */
  expiresAt: string;
  /** Optional cap on cuts it may allow; null = no limit (D11215). */
  uses: number | null;
  /** The owner decision recorded for the grant (BRAIN decision id). */
  decisionId: string;
  /** Enrolled owner public key (hex) that signed it. */
  ownerPubkey: string;
  /** Ed25519 signature (hex) over the grant's fields. */
  sig: string;
}

/** A grant as `cleo release authorize --list` reports it. */
export interface ReleaseAuthorizationStatus extends ReleaseAuthorizationGrant {
  /** Whether it currently allows a cut, and if not why. */
  state: 'active' | 'expired' | 'used-up' | 'revoked' | 'tampered';
  /** Cuts it has allowed (audit rows and tags naming it). */
  used: number;
  /** Why it is tampered, when it is. */
  why?: string;
}
