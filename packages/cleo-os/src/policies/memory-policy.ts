/**
 * CleoOS Memory Policy — governs what gets written to `brain.db`.
 *
 * Enforces owner learning L-fe4ba2dc: *"Chat logs are NOT memory. Real memory
 * is extracted artifacts — patterns, decisions, learnings. Raw conversation
 * history should never be stored directly in brain.db."*
 *
 * The default policy allows structured memory types (`observation`, `decision`,
 * `pattern`, `learning`) and rejects raw transcript types (`chatlog`,
 * `transcript`). The policy is configurable via `MemoryPolicyConfig` for
 * extension without adding feature toggles to the skeleton.
 *
 * @see ADR-050 — CleoOS Sovereign Harness: Distribution Binding Charter
 * @see D008 — 7-technique memory architecture (owner decision 2026-04-13)
 * @see L-fe4ba2dc — Chat logs are NOT memory
 * @task T640
 * @epic T636
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Discriminated union of memory item types recognised by the CleoOS memory gate.
 *
 * @remarks
 * The `chatlog` and `transcript` variants exist to allow callers to explicitly
 * pass raw conversation data through the policy — which will then be rejected
 * with a human-readable reason. This makes the rejection point observable
 * rather than silent.
 */
export type MemoryItemType =
  | 'observation'
  | 'decision'
  | 'pattern'
  | 'learning'
  | 'chatlog'
  | 'transcript';

/**
 * A candidate item for storage in `brain.db`.
 *
 * The `type` field is the primary discriminant used by `MemoryPolicy.shouldStore()`.
 * The `text` field is the raw content. `metadata` carries any supplementary
 * structured data (source, confidence, timestamps, etc.).
 */
export interface MemoryItem {
  /** Semantic classification of this memory item. */
  type: MemoryItemType;
  /** Raw text content of the memory item. */
  text: string;
  /**
   * Optional supplementary metadata.
   *
   * Callers may include fields such as `source`, `confidence`, `taskId`, or
   * `timestamp`. The policy does not inspect metadata when making its decision —
   * type and text alone are sufficient for the current skeleton.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Configuration object for `MemoryPolicy`.
 *
 * All fields are optional; the default values implement the owner-mandated
 * L-fe4ba2dc rule. Override only when a specific distribution profile needs
 * different behaviour (e.g. a development harness that stores transcripts for
 * debugging — explicitly opt-in, not on by default).
 */
export interface MemoryPolicyConfig {
  /**
   * Set of `MemoryItemType` values that are ALLOWED through the gate.
   *
   * Defaults to `['observation', 'decision', 'pattern', 'learning']`.
   * Items whose type is NOT in this set are rejected.
   */
  allowedTypes: ReadonlySet<MemoryItemType>;
  /**
   * Minimum character length for `item.text` to be stored.
   *
   * Items with text shorter than this threshold are rejected as likely noise.
   * Defaults to `10`.
   */
  minTextLength: number;
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

/**
 * Default memory policy configuration.
 *
 * @remarks
 * Implements owner learning L-fe4ba2dc: chat logs and transcripts are
 * categorically excluded from `brain.db`. Only extracted, typed memory
 * artifacts pass through.
 */
const DEFAULT_POLICY_CONFIG: MemoryPolicyConfig = {
  allowedTypes: new Set<MemoryItemType>(['observation', 'decision', 'pattern', 'learning']),
  minTextLength: 10,
};

// ---------------------------------------------------------------------------
// MemoryPolicy
// ---------------------------------------------------------------------------

/**
 * Gate that decides whether a memory item should be written to `brain.db`.
 *
 * @remarks
 * Owner learning L-fe4ba2dc (2026-04-13):
 * *"Chat logs are NOT memory. Real memory is extracted artifacts — patterns,
 * decisions, learnings. Raw conversation history should never be stored
 * directly in brain.db. The extraction pipeline (extraction→consolidation→
 * retrieval) must transform raw transcripts into structured knowledge before
 * storage."*
 *
 * The default configuration enforces this rule. Override via
 * `MemoryPolicyConfig` for specialised distribution profiles.
 *
 * @example
 * ```ts
 * const policy = new MemoryPolicy();
 *
 * const obs: MemoryItem = { type: 'observation', text: 'File walker now handles symlinks' };
 * policy.shouldStore(obs); // true
 *
 * const log: MemoryItem = { type: 'chatlog', text: 'User: how does this work?' };
 * policy.shouldStore(log); // false
 * policy.reason(log);      // "chatlog items are excluded: store extracted artifacts, not raw chat history"
 * ```
 */
export class MemoryPolicy {
  private readonly config: MemoryPolicyConfig;

  /**
   * Construct a `MemoryPolicy` with optional configuration overrides.
   *
   * @param config - Partial overrides merged with {@link DEFAULT_POLICY_CONFIG}.
   *   Omitted fields retain their defaults.
   */
  constructor(config?: Partial<MemoryPolicyConfig>) {
    this.config = {
      allowedTypes: config?.allowedTypes ?? DEFAULT_POLICY_CONFIG.allowedTypes,
      minTextLength: config?.minTextLength ?? DEFAULT_POLICY_CONFIG.minTextLength,
    };
  }

  /**
   * Return `true` if `item` should be stored in `brain.db`.
   *
   * Applies two checks in order:
   * 1. **Type gate** — item type must be in `config.allowedTypes`.
   * 2. **Length gate** — `item.text.length` must meet `config.minTextLength`.
   *
   * Both checks must pass for `shouldStore` to return `true`.
   *
   * @param item - Candidate memory item to evaluate.
   * @returns Whether the item passes the memory gate.
   */
  shouldStore(item: MemoryItem): boolean {
    if (!this.config.allowedTypes.has(item.type)) {
      return false;
    }
    if (item.text.length < this.config.minTextLength) {
      return false;
    }
    return true;
  }

  /**
   * Return a human-readable explanation of the policy decision for `item`.
   *
   * Always returns a string — callers can surface this in logs or diagnostic
   * output regardless of whether `shouldStore` returned `true` or `false`.
   *
   * @param item - Memory item to explain the policy decision for.
   * @returns Human-readable rationale string.
   */
  reason(item: MemoryItem): string {
    if (!this.config.allowedTypes.has(item.type)) {
      return (
        `${item.type} items are excluded: store extracted artifacts, not raw ` +
        `${item.type === 'chatlog' || item.type === 'transcript' ? 'chat history' : 'unstructured content'}`
      );
    }
    if (item.text.length < this.config.minTextLength) {
      return (
        `text too short (${item.text.length} chars < minimum ${this.config.minTextLength}): ` +
        `likely noise or empty observation`
      );
    }
    return `${item.type} item accepted (${item.text.length} chars)`;
  }
}
