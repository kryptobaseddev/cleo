/**
 * Skill install security gate — wire shapes shared by core and CAAMP.
 *
 * The gate's functions are DEFINED in `@cleocode/core` (`skills/skills-guard.ts`,
 * `skills/federation-install-gate.ts`, `skills/skills-guard-audit.ts`) and
 * CALLED by CAAMP's install pipeline, which every skill install goes through
 * (T12384). CAAMP cannot import core's declarations — core depends on CAAMP,
 * and a core declaration in CAAMP's public types becomes an input to core's
 * own build (TS5055) — so the shapes both sides agree on live here.
 *
 * Each type is structurally identical to core's counterpart, so core's
 * functions are assignable to the signatures CAAMP declares against these
 * types.
 *
 * @task T12384
 */

/** Trust tier of a skill source (core `SkillTrustLevel`). */
export type SkillGateTrustLevel = 'builtin' | 'trusted' | 'community' | 'agent-created';

/** Overall scan verdict (core `ScanVerdict`). */
export type SkillGateVerdict = 'safe' | 'caution' | 'dangerous';

/** Severity of one finding (core `FindingSeverity`). */
export type SkillGateFindingSeverity = 'critical' | 'high' | 'medium' | 'low';

/** Threat category of one finding (core `FindingCategory`). */
export type SkillGateFindingCategory =
  | 'exfiltration'
  | 'injection'
  | 'destructive'
  | 'persistence'
  | 'network'
  | 'obfuscation'
  | 'execution'
  | 'traversal'
  | 'mining'
  | 'supply_chain'
  | 'privilege_escalation'
  | 'credential_exposure'
  | 'structural';

/** One scanner finding (core `Finding`). */
export interface SkillGateFinding {
  /** Stable identifier of the pattern or structural check. */
  readonly patternId: string;
  /** Severity of the hit. */
  readonly severity: SkillGateFindingSeverity;
  /** Threat category. */
  readonly category: SkillGateFindingCategory;
  /** Path relative to the scanned skill root. */
  readonly file: string;
  /** 1-based line number (`0` for directory-level findings). */
  readonly line: number;
  /** Matched content excerpt. */
  readonly match: string;
  /** Human-readable description. */
  readonly description: string;
}

/** Result of scanning a skill directory (core `ScanResult`). */
export interface SkillGateScanResult {
  /** Skill identifier (basename of the scanned path). */
  readonly skillName: string;
  /** Source identifier the trust level was resolved from. */
  readonly source: string;
  /** Resolved trust tier. */
  readonly trustLevel: SkillGateTrustLevel;
  /** Overall verdict. */
  readonly verdict: SkillGateVerdict;
  /** Every finding, in discovery order. */
  readonly findings: readonly SkillGateFinding[];
  /** ISO-8601 scan time. */
  readonly scannedAt: string;
  /** One-line summary. */
  readonly summary: string;
}

/** Install-policy action (core `InstallDecision`). */
export type SkillGatePolicyAction = 'allow' | 'block' | 'ask';

/** Install-policy decision over a scan (core `InstallGateDecision`). */
export interface SkillGatePolicyDecision {
  /** Final action. */
  readonly decision: SkillGatePolicyAction;
  /** Human-readable rationale. */
  readonly reason: string;
}

/** Operator trust assigned to a federation peer (core `FederationTrustLevel`). */
export type SkillGateFederationTrust = 'verified' | 'unverified' | 'blocked';

/** A registered federation peer (core `FederationEntry`). */
export interface SkillGateFederationPeer {
  /** Normalised peer URL. */
  readonly url: string;
  /** Operator-assigned trust. */
  readonly trust: SkillGateFederationTrust;
  /** ISO-8601 time the peer was added. */
  readonly addedAt: string;
}

/** Federation gate action (core `FederationInstallDecision`). */
export type SkillGateFederationAction = 'allow' | 'block-checksum' | 'prompt-first-install';

/** Input to the federation gate (core `FederationInstallGateOptions`). */
export interface SkillGateFederationInput {
  /** Source identifier (URL, owner/repo, `library:<name>`). */
  readonly source: string;
  /** Path of the fetched artefact; checksum validation needs it. */
  readonly artefactPath?: string;
  /** Expected sha256, when the source declares one. */
  readonly expectedChecksum?: string | null;
  /** Operator approval of a first install from an unverified peer. */
  readonly approveNewSource?: boolean;
  /** Federation index override (tests). */
  readonly federationIndexPath?: string;
}

/** Result of the federation gate (core `FederationInstallGateResult`). */
export interface SkillGateFederationResult {
  /** Final action. */
  readonly decision: SkillGateFederationAction;
  /** Human-readable rationale. */
  readonly reason: string;
  /** Matched peer, when the source is a known federation URL. */
  readonly peer: SkillGateFederationPeer | null;
  /** Whether the source resolves to a federation peer. */
  readonly isFederationSource: boolean;
  /** Computed sha256 of the artefact, when checked. */
  readonly computedChecksum: string | null;
  /** Expected sha256, when declared. */
  readonly expectedChecksum: string | null;
}
