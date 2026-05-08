/**
 * CLI bug command — shorthand for creating bug-report tasks with severity mapping.
 *
 * Maps P0–P3 severity levels to task priority and labels, then dispatches
 * to `tasks.add` via the CLI adapter.
 *
 *   cleo bug <title> --severity P1 [--epic <id>] [--description <desc>] [--dry-run]
 *
 * ## Signed severity attestation (T947 / ADR-054 draft, T9071)
 *
 * When `--severity` is explicitly set (i.e. the caller is asserting a bug
 * priority), the command delegates to the system-wide
 * {@link appendSignedSeverityAttestation} helper from `@cleocode/core`. The
 * signed line is appended to `.cleo/audit/severity-attestation.jsonl`.
 *
 * If `.cleo/config.json` declares an `ownerPubkeys` allowlist, only
 * identities whose public key is in that allowlist may assert a severity.
 * Signers outside the allowlist receive an `E_OWNER_ONLY` error. When the
 * allowlist is empty or missing, any identity may sign (opt-in policy).
 *
 * NOTE: This command is a transitional consumer. The local attestation
 * helpers (BugSeverityAttestation, appendSignedBugSeverity, etc.) have been
 * moved to `@cleocode/core` and will be removed from this file in T9075.
 *
 * @task T4913
 * @task T947
 * @task T9071
 * @epic T4454
 */

import { appendSignedSeverityAttestation } from '@cleocode/core';
import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { cliError } from '../renderers/index.js';

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
 * `cleo bug` — create a bug-report task with automatic severity mapping.
 *
 * Dispatches to `tasks.add` with priority and labels derived from the
 * --severity flag (P0 = critical … P3 = low). When `--severity` is set,
 * additionally appends a signed attestation to
 * `.cleo/audit/severity-attestation.jsonl` via the core helper (T947 / T9071).
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
      cliError(
        `Invalid severity "${severity}". Must be one of: ${VALID_SEVERITIES.join(', ')}`,
        1,
        { name: 'E_VALIDATION', fix: `Use one of: ${VALID_SEVERITIES.join(', ')}` },
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

    // T947 / T9071: delegate to the system-wide severity attestation helper so
    // the signed line goes to .cleo/audit/severity-attestation.jsonl (renamed
    // from the earlier bug-severity.jsonl path).  Skip for --dry-run and when
    // the caller is operating outside a CLEO project.
    if (!args['dry-run']) {
      try {
        await appendSignedSeverityAttestation({
          timestamp: new Date().toISOString(),
          title: args.title,
          severity,
          ...(args.epic !== undefined ? { epic: args.epic } : {}),
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'E_OWNER_ONLY') {
          cliError((err as Error).message, 72, { name: 'E_OWNER_ONLY' });
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
