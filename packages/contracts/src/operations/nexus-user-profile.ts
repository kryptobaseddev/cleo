/**
 * Wire-format contracts for the NEXUS user_profile SDK operations.
 *
 * These types describe the parameter and result shapes for the five
 * user-profile SDK functions shipped in T1078 (PSYCHE Wave 1).  They follow
 * the same contract pattern as the rest of @cleocode/contracts/operations/.
 *
 * Operations:
 *   nexus.profile.view       — query  — list all traits (with optional confidence filter)
 *   nexus.profile.get        — query  — fetch a single trait by key
 *   nexus.profile.import     — mutate — import from user_profile.json
 *   nexus.profile.export     — mutate — export to user_profile.json
 *   nexus.profile.reinforce  — mutate — increment reinforcement for a trait
 *   nexus.profile.upsert     — mutate — create-or-update a single trait
 *   nexus.profile.supersede  — mutate — mark one trait as superseded by another
 *
 * @task T1078
 * @task T1079
 * @task T1080
 * @epic T1076
 */

// ============================================================================
// Shared domain types
// ============================================================================

/**
 * A single user-profile trait record.
 *
 * This is the canonical in-memory / wire shape for all profile operations.
 * The corresponding SQLite row type is `UserProfileRow` in
 * `packages/core/src/store/nexus-schema.ts`.
 */
export interface UserProfileTrait {
  /** Stable semantic key, e.g. "prefers-zero-deps" or "verbose-git-logs". */
  traitKey: string;
  /** JSON-encoded value (string, number, boolean, or serialised object). */
  traitValue: string;
  /** Bayesian confidence in [0.0, 1.0]. */
  confidence: number;
  /**
   * Origin of this observation.  Convention:
   *   "dialectic:<sessionId>"    — derived by the Dialectic Evaluator (Wave 3)
   *   "import:user_profile.json" — loaded from a portable profile export
   *   "manual"                   — set directly via CLI reinforce command
   */
  source: string;
  /**
   * Soft FK to a future session_messages.id.
   * Null until Wave 5 (T1145) ships the session_messages table.
   */
  derivedFromMessageId: string | null;
  /** ISO 8601 string when the trait was first observed. */
  firstObservedAt: string;
  /** ISO 8601 string of the most recent reinforcement event. */
  lastReinforcedAt: string;
  /** Number of times this trait has been confirmed (starts at 1). */
  reinforcementCount: number;
  /**
   * traitKey of the superseding trait, or null if still active.
   * Set by `supersedeTrait` (T1139 supersession graph prep).
   */
  supersededBy: string | null;
}

// ============================================================================
// Query: nexus.profile.view
// ============================================================================

/** Parameters for `nexus.profile.view`. */
export interface NexusProfileViewParams {
  /** Only return traits with confidence >= this value. Default: 0.0 (all). */
  minConfidence?: number;
  /**
   * When true, include traits whose `validUntil` has elapsed (superseded entries).
   * Default `false` — view returns only currently-valid traits.
   *
   * @task T1080
   */
  includeSuperseded?: boolean;
}

/** Result of `nexus.profile.view`. */
export interface NexusProfileViewResult {
  /** All matching traits, ordered by confidence desc, then traitKey asc. */
  traits: UserProfileTrait[];
  /** Total count of traits returned. */
  count: number;
}

// ============================================================================
// Query: nexus.profile.get
// ============================================================================

/** Parameters for `nexus.profile.get`. */
export interface NexusProfileGetParams {
  /** Trait key to retrieve (required). */
  traitKey: string;
}

/** Result of `nexus.profile.get`. */
export interface NexusProfileGetResult {
  /** The trait, or null when not found. */
  trait: UserProfileTrait | null;
}

// ============================================================================
// Mutate: nexus.profile.import
// ============================================================================

/** Parameters for `nexus.profile.import`. */
export interface NexusProfileImportParams {
  /**
   * Absolute path to the JSON file to import.
   * Defaults to `~/.cleo/user_profile.json` when omitted.
   */
  path?: string;
}

/** Result of `nexus.profile.import`. */
export interface NexusProfileImportResult {
  /** Number of traits successfully upserted. */
  imported: number;
  /** Number of traits skipped due to conflict resolution (lower confidence). */
  skipped: number;
  /** Number of traits where the incoming entry superseded the existing one. */
  superseded: number;
}

// ============================================================================
// Mutate: nexus.profile.export
// ============================================================================

/** Parameters for `nexus.profile.export`. */
export interface NexusProfileExportParams {
  /**
   * Absolute path for the output JSON file.
   * Defaults to `~/.cleo/user_profile.json` when omitted.
   */
  path?: string;
}

/** Result of `nexus.profile.export`. */
export interface NexusProfileExportResult {
  /** Absolute path the file was written to. */
  path: string;
  /** Number of traits written. */
  count: number;
}

// ============================================================================
// Mutate: nexus.profile.reinforce
// ============================================================================

/** Parameters for `nexus.profile.reinforce`. */
export interface NexusProfileReinforceParams {
  /** Key of the trait to reinforce (required). */
  traitKey: string;
  /**
   * Source identifier for this reinforcement event.
   * Defaults to "manual" when called from the CLI.
   */
  source?: string;
}

/** Result of `nexus.profile.reinforce`. */
export interface NexusProfileReinforceResult {
  /** New reinforcement count after this event. */
  reinforcementCount: number;
  /** Updated confidence after this event. */
  confidence: number;
}

// ============================================================================
// Mutate: nexus.profile.upsert
// ============================================================================

/** Parameters for `nexus.profile.upsert`. */
export interface NexusProfileUpsertParams {
  /** Trait to create or update (required). */
  trait: Pick<
    UserProfileTrait,
    'traitKey' | 'traitValue' | 'confidence' | 'source' | 'derivedFromMessageId'
  >;
}

/** Result of `nexus.profile.upsert`. */
export interface NexusProfileUpsertResult {
  /** Whether a new row was created (true) or an existing row was updated (false). */
  created: boolean;
}

// ============================================================================
// Mutate: nexus.profile.supersede
// ============================================================================

/** Parameters for `nexus.profile.supersede`. */
export interface NexusProfileSupersedeParams {
  /** The trait key that is being deprecated. */
  oldKey: string;
  /** The trait key that replaces it. */
  newKey: string;
}

/** Result of `nexus.profile.supersede`. */
export interface NexusProfileSupersedeResult {
  /** Old trait key (now has supersededBy set). */
  oldKey: string;
  /** New trait key (the superseding trait). */
  newKey: string;
}
