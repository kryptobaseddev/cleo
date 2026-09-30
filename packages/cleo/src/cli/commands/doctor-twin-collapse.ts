/**
 * `cleo doctor twin-collapse` — report, and with `--retry` re-run, the twin
 * collapses that keep `tasks_schema_meta` and `brain_sticky_tags` in step
 * with their bare legacy tables (T12535).
 *
 * The collapse runs inside every open of the project store. When it fails
 * (no space for its snapshot, an unusable `.cleo/backups/sqlite`, a merge
 * error), reads keep working and every mutating command is refused with
 * `E_TWIN_COLLAPSE_FAILED`. This command reads the store without binding a
 * domain: it names the cause, the snapshot path and the space needed, and
 * `--retry` runs the collapse once after the cause is cleared. The restore path is documented in
 * `packages/core/src/doctor/twin-collapse.ts`.
 *
 * @task T12535
 */

import {
  inspectProjectTwinCollapse,
  recoverTwinCollapse,
  releaseProjectTwinCollapseSnapshot,
  retryTwinCollapse,
  rollbackTwinCollapse,
} from '@cleocode/core/doctor/twin-collapse.js';
import { CleoError } from '@cleocode/core/errors';
import { getProjectRoot } from '@cleocode/core/paths.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliError, cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor twin-collapse` subcommand. Exits non-zero when a collapse
 * failed or a pending one cannot write its snapshot.
 *
 * @task T12535
 */
export const doctorTwinCollapseCommand = defineCommand({
  meta: {
    name: 'twin-collapse',
    description:
      'Report the twin collapses (bare schema_meta / sticky_tags kept in step with their prefixed ' +
      'twins): state, last failure, snapshot path and space needed. --retry re-runs them; ' +
      '--recover restores what 2026.9.21 dropped; --release-snapshot lets a checked snapshot rotate.',
  },
  args: {
    retry: {
      type: 'boolean',
      description: 'Run the collapse once now (after clearing the reported cause)',
    },
    recover: {
      type: 'boolean',
      description:
        'Restore twin values a 2026.9.21 collapse dropped or replaced, from its pinned ' +
        'pre-collapse snapshot, into twin_collapse_archive:* (T12727). Combine with --dry-run',
    },
    'dry-run': {
      type: 'boolean',
      description: 'With --recover: print the plan, write nothing',
    },
    'pin-snapshot': {
      type: 'boolean',
      description:
        'With --recover: pin an unpinned pre-collapse snapshot (its .meta.json sidecar only) before applying',
    },
    rollback: {
      type: 'string',
      description:
        'Undo one --recover apply by its receipt id (twin_collapse_recovery:<recoveredAt>)',
    },
    'release-snapshot': {
      type: 'string',
      description:
        'Release a pre-collapse snapshot (backup id, e.g. migration-20260928-153200) after a verified ' +
        'recovery or a no-recovery-needed check, so it rotates normally. Needs --confirm; --dry-run shows the bytes reclaimed',
    },
    confirm: {
      type: 'boolean',
      description:
        "With --release-snapshot: the owner's decision to release (obtained by the calling agent; the CLI never prompts)",
    },
    'confirm-owner-store': {
      type: 'boolean',
      description:
        "From a git worktree: allow --recover, --rollback or --retry to write the owning project's live store",
    },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    const projectRoot = getProjectRoot();
    // T12708: the invocation directory; core never falls back to it.
    const guard = { cwd: process.cwd(), confirmOwnerStore: args['confirm-owner-store'] === true };
    try {
      if (typeof args.rollback === 'string' && args.rollback.length > 0) {
        const result = await rollbackTwinCollapse(projectRoot, args.rollback, guard);
        cliOutput(
          { kind: 'generic', ...result },
          { command: 'doctor', operation: 'doctor.twin-collapse.rollback' },
        );
        return;
      }
      if (typeof args['release-snapshot'] === 'string' && args['release-snapshot'].length > 0) {
        const result = await releaseProjectTwinCollapseSnapshot(
          projectRoot,
          args['release-snapshot'],
          {
            ...guard,
            dryRun: args['dry-run'] === true,
            confirm: args.confirm === true,
          },
        );
        cliOutput(
          { kind: 'generic', ...result },
          { command: 'doctor', operation: 'doctor.twin-collapse.release-snapshot' },
        );
        return;
      }
      if (args.recover === true) {
        const result = await recoverTwinCollapse(projectRoot, {
          ...guard,
          dryRun: args['dry-run'] === true,
          pinSnapshot: args['pin-snapshot'] === true,
        });
        cliOutput(
          { kind: 'generic', ...result },
          { command: 'doctor', operation: 'doctor.twin-collapse.recover' },
        );
        return;
      }
      if (args.retry === true) {
        const receipts = await retryTwinCollapse(projectRoot, guard);
        cliOutput(
          { kind: 'generic', receipts },
          { command: 'doctor', operation: 'doctor.twin-collapse.retry' },
        );
        return;
      }
    } catch (error) {
      reportTwinCollapseError(error, args.retry === true);
      return;
    }
    const report = inspectProjectTwinCollapse(projectRoot);
    cliOutput(report, { command: 'doctor', operation: 'doctor.twin-collapse.run' });
    const failed = report.pairs.some((p) => p.state === 'failed') || report.preflight?.ok === false;
    if (failed && (process.exitCode === undefined || process.exitCode === 0)) {
      process.exitCode = 1;
    }
  },
});

/**
 * Render a failed `--recover` / `--rollback` / `--retry`: the error code the
 * message names (`E_…:` prefix), else `E_TWIN_COLLAPSE_FAILED` for `--retry`
 * and `E_TWIN_COLLAPSE_RECOVER` otherwise.
 */
function reportTwinCollapseError(error: unknown, retry: boolean): void {
  if (retry && !(error instanceof CleoError)) throw error;
  const message = error instanceof Error ? error.message : String(error);
  const named = /^(E_[A-Z_]+):/.exec(message)?.[1];
  const code = named ?? (retry ? 'E_TWIN_COLLAPSE_FAILED' : 'E_TWIN_COLLAPSE_RECOVER');
  cliError(message, code, {
    name: error instanceof CleoError ? 'CleoError' : 'Error',
    fix: error instanceof CleoError ? error.fix : undefined,
    details: error instanceof CleoError ? error.details : undefined,
  });
  process.exitCode = error instanceof CleoError ? error.code : 1;
}
