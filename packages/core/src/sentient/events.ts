/**
 * Sentient Event Schema — Merkle-chained audit log for Tier-3 operations.
 *
 * Defines the `SentientEvent` TypeScript discriminated union covering all
 * 8 event kinds emitted during a Tier-3 governed execution pipeline run.
 * Provides {@link appendSentientEvent} (signs + appends) and
 * {@link querySentientEvents} (filters the log by kind / experimentId / time).
 *
 * ## Storage
 *
 * Events are stored as newline-delimited JSON (NDJSON) in
 * `<projectRoot>/.cleo/audit/sentient-events.jsonl`.
 * Each event carries a `parentHash` linking back to the previous event,
 * forming a Merkle chain that makes insertion / deletion detectable.
 *
 * ## Signing
 *
 * `appendSentientEvent` calls {@link loadSigningIdentity} and signs the
 * canonical JSON bytes (all fields except `sig`) with the daemon's Ed25519
 * private key before persisting. Callers supply an `AgentIdentity` directly
 * to keep key-loading outside the hot path.
 *
 * ## Event kinds
 *
 * | Kind | Written by | Purpose |
 * |------|-----------|---------|
 * | `baseline` | Daemon (pre-worktree) | Anchors metric snapshot before experiment starts |
 * | `sandbox.spawn` | Daemon | Records container start parameters |
 * | `patch.proposed` | Agent (via CLI inside container) | Patch summary from experiment agent |
 * | `verify` | Daemon | Per-gate evidence atom verification result |
 * | `sign` | Daemon | Final sign-off: all gates passed |
 * | `merge` | Daemon | FF-only merge committed to main |
 * | `abort` | Daemon | Experiment aborted (kill-switch or FF failure) |
 * | `revert` | Daemon (owner-triggered) | Squashed revert of prior merges |
 *
 * @see DESIGN.md §3 — Event Chain
 * @task T1022
 */

import crypto from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentIdentity } from 'llmtxt/identity';
import { assertProjectInitialized } from '../paths.js';

// ---------------------------------------------------------------------------
// Event kind discriminants
// ---------------------------------------------------------------------------

/** All valid sentient event kind strings. */
export type SentientEventKind =
  | 'baseline'
  | 'sandbox.spawn'
  | 'patch.proposed'
  | 'verify'
  | 'sign'
  | 'merge'
  | 'abort'
  | 'revert'
  | 'tsa_anchor';

// ---------------------------------------------------------------------------
// Per-kind payload types
// ---------------------------------------------------------------------------

/**
 * Payload for a `baseline` event.
 *
 * Written by the daemon before the experiment worktree is created.
 * `worktreeNotCreatedYet: true` is a structural assertion that the daemon
 * has not yet called `git worktree add` — preventing baseline-gaming where
 * the agent writes a slow baseline after the experiment is already underway.
 */
export interface BaselinePayload {
  /** The git commit SHA used as the baseline. */
  commitSha: string;
  /** SHA-256 of the canonical baseline JSON (hex). */
  baselineHash: string;
  /** Serialised metrics snapshot from `cleo bench --json` or similar. */
  metricsJson: string;
  /** Structural assertion: worktree has NOT been created yet. */
  worktreeNotCreatedYet: true;
}

/**
 * Payload for a `sandbox.spawn` event.
 *
 * Written by the daemon when it starts the `sentient-agent` container.
 */
export interface SandboxSpawnPayload {
  /** UUIDv4 identifying this experiment run. */
  experimentId: string;
  /** Docker image tag used for the container. */
  dockerImage: string;
  /** Absolute path to the git worktree the container operates on. */
  worktreePath: string;
  /** Classification of the experiment (e.g. `"code-patch"`, `"refactor"`). */
  experimentType: string;
}

/**
 * Payload for a `patch.proposed` event.
 *
 * Written by the experiment agent (inside the container) via `cleo sentient
 * sign` or equivalent CLI call. The daemon verifies this event came from a
 * trusted agent before proceeding to the merge ritual.
 */
export interface PatchProposedPayload {
  /** The CLEO task ID driving this experiment. */
  taskId: string;
  /** List of relative file paths modified by the patch. */
  patchFiles: string[];
  /** Human-readable summary of the patch (≤ 500 chars). */
  patchSummary: string;
}

/**
 * Payload for a `verify` event.
 *
 * Written once per acceptance gate. `passed: false` aborts the experiment.
 */
export interface VerifyPayload {
  /** The gate name (e.g. `"implemented"`, `"testsPassed"`, `"qaPassed"`). */
  gate: string;
  /** Evidence atom strings supplied to `cleo verify`. */
  evidenceAtoms: string[];
  /** Whether this gate passed verification. */
  passed: boolean;
}

/**
 * Payload for a `sign` event.
 *
 * Written by the daemon after all acceptance gates pass. This is the
 * point-of-no-return before the merge.
 */
export interface SignPayload {
  /** List of gate names that were verified. */
  gates: string[];
  /** True when every gate in `gates` passed. */
  allPassed: boolean;
}

/**
 * Payload for a `merge` event.
 *
 * Written by the daemon after `git merge --ff-only` succeeds.
 */
export interface MergePayload {
  /** The new HEAD commit SHA after the merge. */
  commitSha: string;
  /** Merge strategy used — always `"ff-only"` in Tier 3. */
  mergeStrategy: 'ff-only';
  /** The previous HEAD SHA before the merge. */
  prevHeadSha: string;
}

/**
 * Payload for an `abort` event.
 *
 * Written when the experiment is aborted — either because the kill-switch
 * fired or because `git merge --ff-only` failed.
 */
export interface AbortPayload {
  /** Reason the experiment was aborted. */
  abortReason: 'kill_switch' | 'ff_failed' | 'gate_failed' | 'error';
  /** Merge ritual step number at which the abort occurred (1–10). */
  abortAtStep: number;
  /** Whether the git worktree was successfully cleaned up. */
  worktreeCleaned: boolean;
}

/**
 * Payload for a `revert` event.
 *
 * Written by the daemon when the owner issues `cleo revert --from <receiptId>`.
 * After this event, `globalPauseSet: true` blocks all Tier 1/2/3 ticks.
 */
export interface RevertPayload {
  /** The `receiptId` of the event to revert back to. */
  fromReceiptId: string;
  /** The new squashed-revert commit SHA. */
  revertCommitSha: string;
  /** The range of commit SHAs that were reverted. */
  revertedRange: string[];
  /** Whether the global kill-switch was set after the revert. */
  globalPauseSet: true;
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

/** Base fields common to all sentient events. */
export interface SentientEventBase {
  /** Unique receipt identifier for this specific event (nanoid-style, 21 chars). */
  receiptId: string;
  /** UUIDv4 linking all events for one experiment run. Empty string for `baseline`. */
  experimentId: string;
  /** The Tier-2 accepted task driving this experiment. Empty for non-task events. */
  taskId: string;
  /** SHA-256 of the previous event's canonical JSON bytes (Merkle link). Genesis = 64 zeros. */
  parentHash: string;
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
  /**
   * Ed25519 signature over canonical JSON bytes of the event (all fields except `sig`).
   * Hex-encoded 64-byte signature (128 chars).
   */
  sig: string;
  /** Hex-encoded 32-byte Ed25519 public key (64 chars) of the signer. */
  pub: string;
}

/** Sentient event: baseline captured before worktree creation. */
export interface BaselineEvent extends SentientEventBase {
  kind: 'baseline';
  payload: BaselinePayload;
}

/** Sentient event: sandbox container spawned. */
export interface SandboxSpawnEvent extends SentientEventBase {
  kind: 'sandbox.spawn';
  payload: SandboxSpawnPayload;
}

/** Sentient event: patch proposed by the experiment agent. */
export interface PatchProposedEvent extends SentientEventBase {
  kind: 'patch.proposed';
  payload: PatchProposedPayload;
}

/** Sentient event: acceptance gate verification result. */
export interface VerifyEvent extends SentientEventBase {
  kind: 'verify';
  payload: VerifyPayload;
}

/** Sentient event: all gates signed off — ready to merge. */
export interface SignEvent extends SentientEventBase {
  kind: 'sign';
  payload: SignPayload;
}

/** Sentient event: FF-only merge succeeded. */
export interface MergeEvent extends SentientEventBase {
  kind: 'merge';
  payload: MergePayload;
}

/** Sentient event: experiment aborted. */
export interface AbortEvent extends SentientEventBase {
  kind: 'abort';
  payload: AbortPayload;
}

/** Sentient event: owner-triggered revert. */
export interface RevertEvent extends SentientEventBase {
  kind: 'revert';
  payload: RevertPayload;
}

/** Payload for `tsa_anchor` event — external RFC 3161 timestamp anchor. */
export interface TsaAnchorPayload {
  /** Receipt ID of the chain head at anchor time. */
  chainHeadReceiptId: string;
  /** SHA-256 of the chain-head event's canonical JSON (hex). */
  chainHeadHash: string;
  /** URL of the TSA queried. */
  tsaUrl: string;
  /** Base64-encoded TSA TimeStampToken response bytes. */
  tsaToken: string;
  /** ISO-8601 UTC timestamp of when the anchor was queried. */
  anchoredAt: string;
}

/** Sentient event: daily RFC 3161 external timestamp anchor. */
export interface TsaAnchorEvent extends SentientEventBase {
  kind: 'tsa_anchor';
  payload: TsaAnchorPayload;
}

/**
 * Discriminated union of all 8 sentient event kinds.
 *
 * Use the `kind` field to narrow to the specific event type.
 */
export type SentientEvent =
  | BaselineEvent
  | SandboxSpawnEvent
  | PatchProposedEvent
  | VerifyEvent
  | SignEvent
  | MergeEvent
  | AbortEvent
  | RevertEvent
  | TsaAnchorEvent;

// ---------------------------------------------------------------------------
// Append parameters
// ---------------------------------------------------------------------------

/**
 * Input to {@link appendSentientEvent}.
 *
 * All fields except `receiptId`, `parentHash`, `timestamp`, `sig`, and `pub`
 * are caller-supplied. Those five are derived automatically during append.
 */
export type SentientEventInput = Omit<
  SentientEvent,
  'receiptId' | 'parentHash' | 'timestamp' | 'sig' | 'pub'
>;

// ---------------------------------------------------------------------------
// Query filter
// ---------------------------------------------------------------------------

/**
 * Filter options for {@link querySentientEvents}.
 */
export interface SentientEventFilter {
  /** Only return events with this `kind`. */
  kind?: SentientEventKind;
  /** Only return events with this `experimentId`. */
  experimentId?: string;
  /** Only return events with `timestamp` after this ISO-8601 string. */
  after?: string;
  /** Maximum number of events to return (default: no limit). */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Storage path
// ---------------------------------------------------------------------------

/** Path to the NDJSON event log (relative to projectRoot). */
export const SENTIENT_EVENTS_FILE = '.cleo/audit/sentient-events.jsonl';

/** SHA-256 sentinel for the genesis event (no predecessor). */
const GENESIS_HASH = '0'.repeat(64);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a signed sentient event to the project's audit log.
 *
 * Steps performed:
 * 1. Derive `receiptId` (random 21-char ID).
 * 2. Read the current chain tail to compute `parentHash`.
 * 3. Set `timestamp` to current UTC ISO-8601.
 * 4. Compute `sig` = Ed25519 signature over canonical JSON bytes.
 * 5. Append single-line JSON to `<projectRoot>/.cleo/audit/sentient-events.jsonl`.
 * 6. Return the fully-constructed `SentientEvent`.
 *
 * The log is append-only; no existing entries are ever modified.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param identity - Signing identity. Obtain via {@link loadSigningIdentity}.
 * @param input - Event data (all fields except those derived automatically).
 * @returns The fully constructed and persisted `SentientEvent`.
 *
 * @example
 * ```ts
 * import { appendSentientEvent } from '@cleocode/core/sentient/events.js';
 * import { loadSigningIdentity } from '@cleocode/core/sentient/kms.js';
 *
 * const identity = await loadSigningIdentity(projectRoot);
 * const event = await appendSentientEvent(projectRoot, identity, {
 *   kind: 'baseline',
 *   experimentId: '',
 *   taskId: '',
 *   payload: { commitSha, baselineHash, metricsJson, worktreeNotCreatedYet: true },
 * });
 * ```
 */
export async function appendSentientEvent(
  projectRoot: string,
  identity: AgentIdentity,
  input: SentientEventInput,
): Promise<SentientEvent> {
  const eventsPath = join(projectRoot, SENTIENT_EVENTS_FILE);

  // Guard: refuse to create .cleo/ subdirectories in uninitialized roots
  // (e.g. git worktree paths that lack project-info.json). This prevents
  // workers from creating rogue empty .cleo/ audit directories that diverge
  // from the real project database. (T1864)
  assertProjectInitialized(projectRoot);
  // Ensure the audit directory exists.
  await mkdir(join(projectRoot, '.cleo', 'audit'), { recursive: true });

  // Read existing events to find the chain tail hash.
  const parentHash = await computeChainTailHash(eventsPath);

  // Generate a unique receipt ID (21 random chars, URL-safe base64ish).
  const receiptId = generateReceiptId();

  // Current timestamp.
  const timestamp = new Date().toISOString();

  // Build the signable payload — all fields except `sig`.
  const unsignedEvent: Omit<SentientEvent, 'sig'> = {
    ...input,
    receiptId,
    parentHash,
    timestamp,
    pub: identity.pubkeyHex,
  } as Omit<SentientEvent, 'sig'>;

  // Compute canonical JSON bytes for signing.
  const canonicalBytes = canonicalJsonBytes(unsignedEvent);

  // Sign with the daemon's private key.
  const signatureBytes = await identity.sign(canonicalBytes);
  const sig = bytesToHex(signatureBytes);

  // Assemble the full event.
  const event: SentientEvent = {
    ...unsignedEvent,
    sig,
  } as SentientEvent;

  // Append to the NDJSON log (single line, LF-terminated).
  await appendFile(eventsPath, `${JSON.stringify(event)}\n`, 'utf-8');

  return event;
}

/**
 * Query the sentient event log with optional filters.
 *
 * Reads the entire NDJSON log and returns matching events in chronological
 * order (the order they were appended). Malformed lines are silently skipped.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param filter - Optional filter to narrow results.
 * @returns Array of matching `SentientEvent` objects, oldest first.
 *
 * @example
 * ```ts
 * // Get all baseline events for an experiment.
 * const events = await querySentientEvents(projectRoot, {
 *   kind: 'baseline',
 *   experimentId: 'exp-001',
 * });
 *
 * // Get all events after a specific time.
 * const recent = await querySentientEvents(projectRoot, {
 *   after: '2026-04-20T00:00:00Z',
 * });
 * ```
 */
export async function querySentientEvents(
  projectRoot: string,
  filter?: SentientEventFilter,
): Promise<SentientEvent[]> {
  const eventsPath = join(projectRoot, SENTIENT_EVENTS_FILE);

  let raw: string;
  try {
    raw = await readFile(eventsPath, 'utf-8');
  } catch {
    // File doesn't exist yet — return empty array.
    return [];
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const events: SentientEvent[] = [];

  for (const line of lines) {
    let event: SentientEvent;
    try {
      event = JSON.parse(line) as SentientEvent;
    } catch {
      // Skip malformed lines.
      continue;
    }

    // Apply filters.
    if (filter?.kind !== undefined && event.kind !== filter.kind) continue;
    if (filter?.experimentId !== undefined && event.experimentId !== filter.experimentId) continue;
    if (filter?.after !== undefined && event.timestamp <= filter.after) continue;

    events.push(event);
  }

  // Apply limit.
  if (filter?.limit !== undefined && filter.limit > 0) {
    return events.slice(0, filter.limit);
  }

  return events;
}

/**
 * Verify the Ed25519 signature on a single sentient event.
 *
 * @param event - The event to verify.
 * @returns `true` if the signature is valid.
 */
export async function verifySentientEventSignature(event: SentientEvent): Promise<boolean> {
  const { verifySignature } = await import('llmtxt/identity');
  // Reconstruct the signable payload — same as at append time.
  const { sig, ...unsigned } = event;
  const canonicalBytes = canonicalJsonBytes(unsigned as Omit<SentientEvent, 'sig'>);
  return verifySignature(canonicalBytes, sig, event.pub);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read the last non-empty line of the events file and compute its SHA-256.
 *
 * Returns the genesis sentinel (64 zeros) if the file is absent or empty.
 *
 * @internal
 */
async function computeChainTailHash(eventsPath: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(eventsPath, 'utf-8');
  } catch {
    return GENESIS_HASH;
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return GENESIS_HASH;

  const lastLine = lines[lines.length - 1];
  const hash = crypto.createHash('sha256').update(lastLine, 'utf-8').digest('hex');
  return hash;
}

/**
 * Produce deterministic canonical JSON bytes for signing.
 *
 * Uses `JSON.stringify` with alphabetically sorted keys to ensure the same
 * bytes regardless of object construction order. The `sig` field is excluded.
 *
 * @internal
 */
function canonicalJsonBytes(obj: Record<string, unknown> | Omit<SentientEvent, 'sig'>): Uint8Array {
  const sorted = sortKeysDeep(obj as Record<string, unknown>);
  return Buffer.from(JSON.stringify(sorted), 'utf-8');
}

/**
 * Recursively sort object keys alphabetically for canonical serialisation.
 *
 * @internal
 */
function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeysDeep(obj[key]);
  }
  return sorted;
}

/**
 * Generate a URL-safe random receipt ID (21 characters).
 *
 * Uses `crypto.randomBytes` for cryptographic randomness.
 *
 * @internal
 */
function generateReceiptId(): string {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const bytes = crypto.randomBytes(21);
  let id = '';
  for (let i = 0; i < 21; i++) {
    id += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return id;
}

/**
 * Convert a `Uint8Array` to a lowercase hex string.
 *
 * @internal
 */
function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}
