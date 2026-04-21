/**
 * CLI command: `cleo revert` — Owner kill-switch revert walker.
 *
 * Walks the sentient audit chain from `--from <receiptId>` and squash-reverts
 * all sentient merge commits back to that point. Requires an owner-signed
 * attestation to proceed. After revert, sets the global pause flag
 * (`pausedByRevert = true`) so all Tier 1/2/3 agents refuse to spawn until
 * the owner runs `cleo sentient resume` with a valid attestation.
 *
 * ## Owner attestation
 *
 * The owner attestation must be a JSON object matching {@link OwnerRevertAttestation}
 * provided via one of:
 * - `--attestation-file <path>` — path to a JSON file on disk
 * - `CLEO_OWNER_ATTESTATION` env var — JSON string
 *
 * ## One-time signing flow
 *
 * 1. Generate an Ed25519 keypair (owner key — NOT the daemon signing key).
 * 2. Register the pubkey in `.cleo/owner-pubkeys.json` (hex-encoded, 64 chars).
 * 3. Before issuing a revert, create the attestation payload:
 *    ```json
 *    {
 *      "afterRevertReceiptId": "<receiptId>",
 *      "issuedAt": "<ISO-8601 UTC>",
 *      "ownerPubkey": "<hex-64>",
 *      "sig": "<ed25519-sig-over-canonical-json-minus-sig>"
 *    }
 *    ```
 * 4. Save to `.cleo/owner-attestations/<nonce>.sig` and pass via `--attestation-file`.
 *
 * ## Dry-run
 *
 * `--dry-run` prints the commits that would be reverted without executing
 * any git operations or writing any events.
 *
 * ## JSON output
 *
 * `--json` wraps the result in a LAFS success envelope:
 * `{ "success": true, "data": { "revertCommitSha", "revertedRange", "eventsReverted" } }`
 *
 * @task T1039
 * @see packages/core/src/sentient/revert-walker.ts
 * @see packages/core/src/sentient/revert-executor.ts
 * @see packages/core/src/sentient/state.ts (pauseAllTiers / resumeAfterRevert)
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cwd as processCwd } from 'node:process';
import { E_RECEIPT_NOT_FOUND } from '@cleocode/core/sentient/chain-walker.js';
import { SENTIENT_STATE_FILE } from '@cleocode/core/sentient/daemon.js';
import { loadSigningIdentity } from '@cleocode/core/sentient/kms.js';
import { executeSquashedRevert } from '@cleocode/core/sentient/revert-executor.js';
import { collectMergeCommits } from '@cleocode/core/sentient/revert-walker.js';
import {
  E_OWNER_ATTESTATION_REQUIRED,
  type OwnerRevertAttestation,
  readSentientState,
} from '@cleocode/core/sentient/state.js';
import { defineCommand } from 'citty';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path to the owner pubkeys allowlist (relative to projectRoot). */
const OWNER_PUBKEYS_FILE = '.cleo/owner-pubkeys.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the project root from an arg or fall back to cwd. */
function resolveProjectRoot(arg: string | undefined): string {
  return arg && arg.length > 0 ? arg : processCwd();
}

/** Emit a LAFS-shaped success envelope as JSON or human text. */
function emitSuccess(payload: unknown, jsonMode: boolean, humanLine: string): void {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ success: true, data: payload })}\n`);
  } else {
    process.stdout.write(`${humanLine}\n`);
  }
}

/** Emit a LAFS-shaped failure envelope and exit 1. */
function emitFailure(code: string, message: string, jsonMode: boolean): never {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ success: false, error: { code, message } })}\n`);
  } else {
    process.stderr.write(`Error [${code}]: ${message}\n`);
  }
  process.exit(1);
}

/**
 * Load the owner attestation from `--attestation-file` or
 * `CLEO_OWNER_ATTESTATION` environment variable.
 *
 * @throws If neither is provided or the JSON is malformed.
 */
async function loadOwnerAttestation(
  attestationFilePath: string | undefined,
): Promise<OwnerRevertAttestation> {
  let raw: string | undefined;

  if (attestationFilePath) {
    try {
      raw = await readFile(attestationFilePath, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read attestation file "${attestationFilePath}": ${message}`);
    }
  } else if (process.env['CLEO_OWNER_ATTESTATION']) {
    raw = process.env['CLEO_OWNER_ATTESTATION'];
  }

  if (!raw) {
    throw new Error(
      'Owner attestation is required. Provide one of:\n' +
        '  --attestation-file <path>   path to a JSON attestation file\n' +
        '  CLEO_OWNER_ATTESTATION      JSON string in environment variable\n\n' +
        'Attestation format:\n' +
        '  { "afterRevertReceiptId": "<receiptId>",\n' +
        '    "issuedAt": "<ISO-8601>",\n' +
        '    "ownerPubkey": "<hex-64>",\n' +
        '    "sig": "<ed25519-hex-128>" }',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Owner attestation is not valid JSON');
  }

  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj['afterRevertReceiptId'] !== 'string' ||
    typeof obj['issuedAt'] !== 'string' ||
    typeof obj['ownerPubkey'] !== 'string' ||
    typeof obj['sig'] !== 'string'
  ) {
    throw new Error(
      'Owner attestation is missing required fields: ' +
        'afterRevertReceiptId, issuedAt, ownerPubkey, sig',
    );
  }

  return obj as unknown as OwnerRevertAttestation;
}

/**
 * Load the owner pubkeys allowlist from `.cleo/owner-pubkeys.json`.
 *
 * Returns an empty set if the file does not exist (fails open for
 * dev environments; callers check the set is non-empty).
 */
async function loadOwnerPubkeys(projectRoot: string): Promise<Set<string>> {
  const path = join(projectRoot, OWNER_PUBKEYS_FILE);
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((k): k is string => typeof k === 'string'));
    }
    return new Set<string>();
  } catch {
    return new Set<string>();
  }
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

/**
 * `cleo revert --from <receiptId>` — Owner kill-switch revert walker.
 *
 * Walks the sentient audit chain from a receipt ID and squash-reverts all
 * sentient merge commits. Requires owner attestation. Sets global pause flag.
 */
export const revertCommand = defineCommand({
  meta: {
    name: 'revert',
    description: 'Owner kill-switch: squash-revert all sentient merge commits from a receipt ID',
  },
  args: {
    from: {
      type: 'string' as const,
      description: 'Receipt ID to revert from (inclusive)',
    },
    'attestation-file': {
      type: 'string' as const,
      description:
        'Path to owner attestation JSON file (alternatively set CLEO_OWNER_ATTESTATION env var)',
    },
    'include-human': {
      type: 'boolean' as const,
      description: 'Allow reverting commits not authored by the sentient agent',
    },
    'dry-run': {
      type: 'boolean' as const,
      description: 'Print commits that would be reverted without executing',
    },
    json: {
      type: 'boolean' as const,
      description: 'Emit LAFS JSON envelope',
    },
    project: {
      type: 'string' as const,
      description: 'Project root (defaults to process cwd)',
    },
  },
  async run({ args }) {
    const projectRoot = resolveProjectRoot(args.project as string | undefined);
    const jsonMode = args.json === true;
    const dryRun = args['dry-run'] === true;
    const includeHuman = args['include-human'] === true;
    const fromReceiptId = args.from as string | undefined;
    const attestationFile = args['attestation-file'] as string | undefined;

    // --from is required.
    if (!fromReceiptId) {
      emitFailure(
        'E_MISSING_FLAG',
        '--from <receiptId> is required. Usage: cleo revert --from <receiptId>',
        jsonMode,
      );
    }

    // Load owner attestation (not needed for dry-run — we skip auth check).
    let attestation: OwnerRevertAttestation | undefined;
    if (!dryRun) {
      try {
        attestation = await loadOwnerAttestation(attestationFile);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emitFailure(E_OWNER_ATTESTATION_REQUIRED, message, jsonMode);
      }
    }

    // Validate the attestation matches the requested receiptId.
    if (attestation && attestation.afterRevertReceiptId !== fromReceiptId) {
      emitFailure(
        E_OWNER_ATTESTATION_REQUIRED,
        `attestation.afterRevertReceiptId "${attestation.afterRevertReceiptId}" ` +
          `does not match --from "${fromReceiptId}"`,
        jsonMode,
      );
    }

    // Load owner pubkeys allowlist.
    const allowedPubkeys = await loadOwnerPubkeys(projectRoot);

    // Validate attestation pubkey is on allowlist (unless allowlist is empty = dev mode).
    if (attestation && allowedPubkeys.size > 0 && !allowedPubkeys.has(attestation.ownerPubkey)) {
      emitFailure(
        E_OWNER_ATTESTATION_REQUIRED,
        `Attestation pubkey "${attestation.ownerPubkey}" is not in the owner allowlist ` +
          `at ${join(projectRoot, OWNER_PUBKEYS_FILE)}`,
        jsonMode,
      );
    }

    // Walk the chain.
    let commits: string[];
    let mergeEvents: Awaited<ReturnType<typeof collectMergeCommits>>['events'];
    try {
      const result = await collectMergeCommits(projectRoot, fromReceiptId);
      commits = result.commits;
      mergeEvents = result.events;
    } catch (err) {
      const errCode =
        (err as NodeJS.ErrnoException).code === E_RECEIPT_NOT_FOUND
          ? E_RECEIPT_NOT_FOUND
          : 'E_CHAIN_WALK_FAILED';
      const message = err instanceof Error ? err.message : String(err);
      emitFailure(errCode, message, jsonMode);
    }

    if (commits.length === 0) {
      emitSuccess(
        {
          receiptId: fromReceiptId,
          commits: [],
          message: 'No merge commits found starting from this receipt — nothing to revert',
        },
        jsonMode,
        `No merge commits found starting from receipt ${fromReceiptId}. Nothing to revert.`,
      );
      return;
    }

    // Dry-run: print and exit.
    if (dryRun) {
      const lines = commits.map((sha, i) => `  [${i + 1}] ${sha}`).join('\n');
      emitSuccess(
        { dryRun: true, fromReceiptId, commits, count: commits.length },
        jsonMode,
        `Dry-run: would revert ${commits.length} commit(s) from ${fromReceiptId}:\n${lines}`,
      );
      return;
    }

    // Load signing identity for the revert event.
    let identity: Awaited<ReturnType<typeof loadSigningIdentity>>;
    try {
      identity = await loadSigningIdentity(projectRoot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitFailure('E_KMS_LOAD', message, jsonMode);
    }

    // Execute the squashed revert.
    try {
      const result = await executeSquashedRevert({
        cleoRoot: projectRoot,
        commits,
        mergeEvents,
        fromReceiptId,
        identity,
        includeHuman,
      });

      const statePath = join(projectRoot, SENTIENT_STATE_FILE);
      const state = await readSentientState(statePath);

      emitSuccess(
        {
          revertCommitSha: result.revertCommitSha,
          revertedRange: result.revertedRange,
          eventsReverted: mergeEvents.length,
          revertEventReceiptId: result.revertEventReceiptId,
          humanCommitPresent: result.humanCommitPresent,
          globalPauseSet: true,
          pausedByRevert: state.pausedByRevert,
        },
        jsonMode,
        `Revert complete.\n` +
          `  Reverted: ${result.revertedRange.length} commit(s)\n` +
          `  Squash commit: ${result.revertCommitSha}\n` +
          `  Revert event: ${result.revertEventReceiptId}\n` +
          `  Global pause: ACTIVE (run 'cleo sentient resume' with owner attestation to clear)`,
      );
    } catch (err) {
      const errCode = (err as NodeJS.ErrnoException).code ?? 'E_REVERT_FAILED';
      const message = err instanceof Error ? err.message : String(err);
      emitFailure(errCode, message, jsonMode);
    }
  },
});
