/**
 * Sentient Event Chain Walker — Merkle chain verification and traversal.
 *
 * Provides two utilities for working with the Merkle-chained sentient event
 * log written by {@link appendSentientEvent}:
 *
 * - {@link verifyEventChain} — scans the entire event log and validates that
 *   every `parentHash` matches the SHA-256 of the prior event's serialised
 *   line. Returns a summary with a count of broken links and the first
 *   broken event ID.
 *
 * - {@link walkChainFrom} — returns all events from a given `receiptId`
 *   forward to the end of the log, in chronological (append) order.
 *   Used by the revert ritual (T1012) to collect merge events since an anchor.
 *
 * ## Chain structure
 *
 * Each line in `.cleo/audit/sentient-events.jsonl` is a standalone JSON
 * object. The Merkle link is:
 *
 * ```
 * event[n].parentHash = sha256(rawLine[n-1])
 * ```
 *
 * where `rawLine[n-1]` is the exact UTF-8 bytes written by
 * `appendSentientEvent` (no trailing newline included in the hash input —
 * the hash is taken over the JSON token only).
 *
 * The genesis event carries `parentHash = "0".repeat(64)`.
 *
 * @see DESIGN.md §8 T1010-S5
 * @task T1025
 */

import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isOwnerSigner } from './allowlist.js';
import type { SentientEvent } from './events.js';
import { SENTIENT_EVENTS_FILE } from './events.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Genesis sentinel: 64 hex zeros — the `parentHash` of the first event. */
const GENESIS_HASH = '0'.repeat(64);

/** Error code thrown by {@link walkChainFrom} for unknown receipt IDs. */
export const E_RECEIPT_NOT_FOUND = 'E_RECEIPT_NOT_FOUND';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result returned by {@link verifyEventChain}.
 *
 * All counts refer to events in the log at the time of the call.
 */
export interface ChainVerifyResult {
  /** Total number of events in the log. */
  total: number;
  /** Number of events whose `parentHash` was correctly verified. */
  verified: number;
  /**
   * Number of events with an incorrect `parentHash`.
   *
   * A non-zero value indicates tampering, insertion, or deletion.
   */
  broken: number;
  /**
   * The `receiptId` of the first event whose `parentHash` does not match
   * the SHA-256 of the previous serialised event line.
   *
   * `undefined` when `broken === 0`.
   */
  firstBrokenAt?: string;
  /**
   * Number of events signed by a key that is NOT in the owner allowlist.
   *
   * A non-zero value indicates that an event was signed by an unrecognised
   * key. In non-strict mode this is logged as a warning; in strict mode
   * (`CLEO_STRICT_ALLOWLIST=1`) this is treated as a chain break.
   */
  signerNotInAllowlist: number;
  /**
   * The `receiptId` of the first event whose signer is not in the allowlist.
   *
   * `undefined` when `signerNotInAllowlist === 0`.
   */
  firstUnknownSignerAt?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify the Merkle chain of the entire sentient event log.
 *
 * Reads every line from `<projectRoot>/.cleo/audit/sentient-events.jsonl`
 * and recomputes each `parentHash`. A hash mismatch indicates that the log
 * was mutated after the fact (insertion, deletion, or content change).
 *
 * Returns `{ broken: 0 }` when the log is absent or empty — an empty chain
 * is trivially valid.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @returns A {@link ChainVerifyResult} describing chain integrity.
 *
 * @example
 * ```ts
 * import { verifyEventChain } from '@cleocode/core/sentient/chain-walker.js';
 *
 * const result = await verifyEventChain(projectRoot);
 * if (result.broken > 0) {
 *   console.error('Chain broken at:', result.firstBrokenAt);
 * }
 * ```
 */
export async function verifyEventChain(projectRoot: string): Promise<ChainVerifyResult> {
  const eventsPath = join(projectRoot, SENTIENT_EVENTS_FILE);

  let raw: string;
  try {
    raw = await readFile(eventsPath, 'utf-8');
  } catch {
    // File absent → empty chain, trivially valid.
    return { total: 0, verified: 0, broken: 0, signerNotInAllowlist: 0 };
  }

  // Split into non-empty lines. Each line is the raw JSON string as written.
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { total: 0, verified: 0, broken: 0, signerNotInAllowlist: 0 };
  }

  const strict = process.env['CLEO_STRICT_ALLOWLIST'] === '1';

  let verified = 0;
  let broken = 0;
  let firstBrokenAt: string | undefined;
  let signerNotInAllowlist = 0;
  let firstUnknownSignerAt: string | undefined;

  // The expected parentHash for each line — starts at the genesis sentinel.
  let expectedParentHash = GENESIS_HASH;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Parse the event — skip malformed lines but treat them as broken.
    let event: SentientEvent;
    try {
      event = JSON.parse(line) as SentientEvent;
    } catch {
      // Unparseable line → chain is broken here.
      broken++;
      if (firstBrokenAt === undefined) {
        // We don't have a receiptId — use a position marker.
        firstBrokenAt = `<malformed-line-${i}>`;
      }
      // The next event's expectedParentHash cannot be derived; use the line hash
      // as a best-effort to continue checking the rest of the chain.
      expectedParentHash = sha256Hex(line);
      continue;
    }

    const actualParentHash = event.parentHash ?? '';

    if (actualParentHash === expectedParentHash) {
      verified++;
    } else {
      broken++;
      if (firstBrokenAt === undefined) {
        firstBrokenAt = event.receiptId;
      }
    }

    // Signer-allowlist check — non-blocking warning unless CLEO_STRICT_ALLOWLIST=1.
    if (event.pub) {
      const signerBytes = Buffer.from(event.pub, 'hex');
      const signerAllowed = await isOwnerSigner(projectRoot, signerBytes);
      if (!signerAllowed) {
        signerNotInAllowlist++;
        if (firstUnknownSignerAt === undefined) {
          firstUnknownSignerAt = event.receiptId;
        }
        if (strict) {
          // In strict mode, count the signer failure as a chain break.
          if (firstBrokenAt === undefined) {
            firstBrokenAt = event.receiptId;
          }
          broken++;
          // Do not increment verified for this event since we already
          // incremented it above for the hash check — correct the count.
          verified = Math.max(0, verified - 1);
        } else {
          process.stderr.write(
            `[chain-walker] Warning: signer-not-in-allowlist for event ${event.receiptId} (pub=${event.pub.slice(0, 16)}...)\n`,
          );
        }
      }
    }

    // The next event must reference the SHA-256 of this line.
    expectedParentHash = sha256Hex(line);
  }

  return {
    total: lines.length,
    verified,
    broken,
    firstBrokenAt,
    signerNotInAllowlist,
    firstUnknownSignerAt,
  };
}

/**
 * Walk the event chain forward from a given receipt ID.
 *
 * Returns all events from the event identified by `receiptId` (inclusive)
 * through to the last event in the log, in chronological (append) order.
 *
 * This is used by the revert ritual to collect all `merge` events that
 * occurred after a given anchor point — the caller can then build the
 * squashed-revert commit from that set.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param receiptId - The `receiptId` of the starting event (inclusive).
 * @returns Array of {@link SentientEvent} from `receiptId` to HEAD.
 * @throws `E_RECEIPT_NOT_FOUND` if no event with the given `receiptId`
 *   exists in the log.
 *
 * @example
 * ```ts
 * import { walkChainFrom } from '@cleocode/core/sentient/chain-walker.js';
 *
 * const mergeEvents = (await walkChainFrom(projectRoot, anchorReceiptId))
 *   .filter(e => e.kind === 'merge');
 * ```
 */
export async function walkChainFrom(
  projectRoot: string,
  receiptId: string,
): Promise<SentientEvent[]> {
  const eventsPath = join(projectRoot, SENTIENT_EVENTS_FILE);

  let raw: string;
  try {
    raw = await readFile(eventsPath, 'utf-8');
  } catch {
    // File absent → receiptId cannot exist.
    throw new Error(
      `${E_RECEIPT_NOT_FOUND}: event log does not exist at ${eventsPath}. ` +
        `receiptId "${receiptId}" was not found.`,
    );
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  // Find the index of the event with the given receiptId.
  let startIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    let event: SentientEvent;
    try {
      event = JSON.parse(lines[i]) as SentientEvent;
    } catch {
      continue;
    }
    if (event.receiptId === receiptId) {
      startIndex = i;
      break;
    }
  }

  if (startIndex === -1) {
    throw new Error(
      `${E_RECEIPT_NOT_FOUND}: no event with receiptId "${receiptId}" found in ` + `${eventsPath}.`,
    );
  }

  // Collect all events from startIndex onward.
  const result: SentientEvent[] = [];
  for (let i = startIndex; i < lines.length; i++) {
    let event: SentientEvent;
    try {
      event = JSON.parse(lines[i]) as SentientEvent;
    } catch {
      // Skip malformed lines silently.
      continue;
    }
    result.push(event);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 of a UTF-8 string, returning lowercase hex.
 *
 * @param input - The string to hash.
 * @returns 64-character lowercase hex digest.
 * @internal
 */
function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf-8').digest('hex');
}
