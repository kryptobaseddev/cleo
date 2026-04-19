/**
 * CLI bug command — shorthand for creating bug-report tasks with severity mapping.
 *
 * Maps P0–P3 severity levels to task priority and labels, then dispatches
 * to `tasks.add` via the CLI adapter.
 *
 *   cleo bug <title> --severity P1 [--epic <id>] [--description <desc>] [--dry-run]
 *
 * ## Signed severity attestation (T947 / ADR-054 draft)
 *
 * When `--severity` is explicitly set (i.e. the caller is asserting a bug
 * priority), the command produces a signed attestation that is appended to
 * `.cleo/audit/bug-severity.jsonl`. The attestation is signed with the
 * project's CLEO identity (see `@cleocode/core/identity`).
 *
 * If `.cleo/config.json` declares an `ownerPubkeys` allowlist, only
 * identities whose public key is in that allowlist may assert a severity.
 * Signers outside the allowlist receive an `E_OWNER_ONLY` error. When the
 * allowlist is empty or missing, any identity may sign (opt-in policy).
 *
 * @task T4913
 * @task T947
 * @epic T4454
 */

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getCleoDirAbsolute, getCleoIdentity, getConfigPath, signAuditLine } from '@cleocode/core';
import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Severity mapping configuration.
 * Maps P0–P3 severity levels to task priority and label arrays.
 */
const SEVERITY_MAP: Record<string, { priority: string; labels: string[] }> = {
  P0: { priority: 'critical', labels: ['bug', 'p0'] },
  P1: { priority: 'high', labels: ['bug', 'p1'] },
  P2: { priority: 'medium', labels: ['bug', 'p2'] },
  P3: { priority: 'low', labels: ['bug', 'p3'] },
};

/**
 * Valid severity level keys for validation error messages.
 */
const VALID_SEVERITIES = Object.keys(SEVERITY_MAP);

/**
 * Shape of the `.cleo/audit/bug-severity.jsonl` line appended per severity
 * attestation. Mirrors the gate-audit schema: stable, sorted keys, signed
 * with `_sig`.
 *
 * @task T947
 */
interface BugSeverityAttestation {
  /** ISO 8601 timestamp of the attestation. */
  timestamp: string;
  /** Bug report title. */
  title: string;
  /** Severity asserted by the signer (P0–P3). */
  severity: string;
  /** Optional epic the bug is filed under. */
  epic?: string;
  /** Optional pre-assigned task ID (if known at attestation time). */
  taskId?: string;
  /** Signer's Ed25519 public key (hex). */
  signerPub: string;
}

/**
 * Load the owner-pubkey allowlist from `.cleo/config.json`. Returns an empty
 * array when the file is missing, malformed, or does not declare the field.
 *
 * @internal
 */
async function loadOwnerPubkeys(): Promise<string[]> {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return [];
  }
  try {
    const raw = await readFile(configPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return [];
    }
    const list = (parsed as { ownerPubkeys?: unknown }).ownerPubkeys;
    if (!Array.isArray(list)) {
      return [];
    }
    return list.filter((v): v is string => typeof v === 'string' && v.length === 64);
  } catch {
    return [];
  }
}

/**
 * Produce a stable JSON serialisation of the attestation (sorted keys) so
 * the bytes passed to the signer match what a verifier re-serialises.
 *
 * @internal
 */
function canonicalAttestationJson(record: BugSeverityAttestation): string {
  const sortedKeys = Object.keys(record).sort();
  const ordered: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    ordered[key] = record[key as keyof BugSeverityAttestation];
  }
  return JSON.stringify(ordered);
}

/**
 * Append a signed severity attestation to `.cleo/audit/bug-severity.jsonl`.
 *
 * Throws a shaped error with `code: 'E_OWNER_ONLY'` when the signer's pubkey
 * is not in the configured `ownerPubkeys` allowlist.
 *
 * @internal
 */
async function appendSignedBugSeverity(
  record: Omit<BugSeverityAttestation, 'signerPub'>,
): Promise<void> {
  const id = await getCleoIdentity();
  const owners = await loadOwnerPubkeys();
  if (owners.length > 0 && !owners.includes(id.pubkeyHex)) {
    const err = new Error(
      `E_OWNER_ONLY: severity attestation requires an owner-allowlisted identity (pub=${id.pubkeyHex.slice(0, 8)}…). Add your public key to .cleo/config.json "ownerPubkeys" array to authorise.`,
    );
    (err as Error & { code?: string }).code = 'E_OWNER_ONLY';
    throw err;
  }

  const full: BugSeverityAttestation = { ...record, signerPub: id.pubkeyHex };
  const canonical = canonicalAttestationJson(full);
  const sig = await signAuditLine(id, canonical);

  const line = `${JSON.stringify({ ...full, _sig: sig })}\n`;
  const auditPath = join(getCleoDirAbsolute(), 'audit', 'bug-severity.jsonl');
  await mkdir(dirname(auditPath), { recursive: true });
  await appendFile(auditPath, line, { encoding: 'utf-8' });
}

/**
 * `cleo bug` — create a bug-report task with automatic severity mapping.
 *
 * Dispatches to `tasks.add` with priority and labels derived from the
 * --severity flag (P0 = critical … P3 = low). When `--severity` is set,
 * additionally appends a signed attestation to
 * `.cleo/audit/bug-severity.jsonl` (T947 / ADR-054 draft).
 */
export const bugCommand = defineCommand({
  meta: {
    name: 'bug',
    description: 'Create a bug report task with severity mapping (requires active session)',
  },
  args: {
    title: {
      type: 'positional',
      description: 'Bug report title',
      required: true,
    },
    severity: {
      type: 'string',
      description: 'Severity level (P0, P1, P2, P3)',
      alias: 's',
      default: 'P2',
    },
    epic: {
      type: 'string',
      description: 'Epic ID to link as parent (optional)',
      alias: 'e',
    },
    description: {
      type: 'string',
      description: 'Bug description',
      alias: 'd',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Show what would be created without making changes',
      default: false,
    },
  },
  async run({ args }) {
    const severity = args.severity ?? 'P2';

    if (!VALID_SEVERITIES.includes(severity)) {
      console.error(
        `Error: Invalid severity "${severity}". Must be one of: ${VALID_SEVERITIES.join(', ')}`,
      );
      process.exit(1);
    }

    const mapping = SEVERITY_MAP[severity];

    const params: Record<string, unknown> = {
      title: args.title,
      type: 'task',
      priority: mapping.priority,
      labels: mapping.labels,
      origin: 'bug-report',
      description: args.description ?? args.title,
    };

    if (args.epic !== undefined) {
      params['parent'] = args.epic;
    }

    if (args['dry-run']) {
      params['dryRun'] = true;
    }

    // T947: sign the severity attestation before dispatching the task so the
    // E_OWNER_ONLY rejection short-circuits the write.  Skip for --dry-run
    // and when the caller is operating outside a CLEO project.
    if (!args['dry-run']) {
      try {
        await appendSignedBugSeverity({
          timestamp: new Date().toISOString(),
          title: args.title,
          severity,
          ...(args.epic !== undefined ? { epic: args.epic } : {}),
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'E_OWNER_ONLY') {
          console.error((err as Error).message);
          process.exit(72); // NEXUS_PERMISSION_DENIED — shared "forbidden" exit
        }
        // Any other failure (e.g. not inside a CLEO project) is non-fatal —
        // fall through to the task-creation dispatch so `cleo bug` still works
        // outside of CLEO projects for non-severity users.
      }
    }

    await dispatchFromCli('mutate', 'tasks', 'add', params, { command: 'bug' });
  },
});
