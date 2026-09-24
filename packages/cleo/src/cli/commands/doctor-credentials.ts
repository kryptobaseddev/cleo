/**
 * `cleo doctor credentials` — are this project's stored credentials still
 * bound to the project PATH?
 *
 * Before T12326 project credentials were encrypted under
 * `HMAC(machine-key, projectPath)`, so moving or renaming the project directory
 * made them undecryptable. They are now keyed by the project's identity
 * (`projectId` in `.cleo/project-info.json`). This command reports which stored
 * credentials still use the old path-bound key and, with `--fix`, re-keys them
 * in place. `cleo upgrade` runs the same migration.
 *
 * It also audits agent registry keys (T12352). Before that fix
 * `agent_registry_agents.api_key_encrypted` stored a derived HMAC and discarded
 * the real key, so those rows cannot be migrated. They are listed with the
 * command that re-registers the key, and `--fix` flags them
 * `requires_reauth = 1`.
 *
 * Read-only by default. `--fix` is idempotent and never deletes: a credential no
 * candidate key opens is left untouched and listed with the one command that
 * re-enters it.
 *
 * @task T12326
 * @task T12352
 */

import { join } from 'node:path';
import { getCleoHome, getProjectRoot } from '@cleocode/core/paths.js';
import {
  auditAgentRegistryKeys,
  migrateProjectCredentialsAtRoot,
} from '@cleocode/core/store/credential-transfer.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor credentials` subcommand.
 *
 * Exits non-zero while a credential is unrecoverable, or (without `--fix`)
 * while one still needs re-keying, so a script can gate on it.
 *
 * @task T12326
 */
export const doctorCredentialsCommand = defineCommand({
  meta: {
    name: 'credentials',
    description:
      "Report project credentials still encrypted under the legacy path-bound key (moving the project would strand them) and agent registry keys that are not recoverable. --fix re-keys project credentials to the project's identity in place and flags unrecoverable agent keys requires_reauth. Idempotent; never deletes. Unrecoverable credentials are listed with their re-entry command.",
  },
  args: {
    fix: {
      type: 'boolean',
      description: 'Re-key path-bound credentials in place (default: report only).',
    },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    const dryRun = args.fix !== true;
    const result = await migrateProjectCredentialsAtRoot(getProjectRoot(), { dryRun });
    const agents = await auditAgentRegistryKeys(join(getCleoHome(), 'cleo.db'), { dryRun });

    cliOutput(
      {
        projectDbPath: result.projectDbPath,
        projectId: result.projectId,
        applied: !result.dryRun,
        [result.dryRun ? 'wouldMigrate' : 'migrated']: result.migrated,
        current: result.current,
        requiresReentry: result.reentry,
        agentRegistry: {
          globalDbPath: agents.globalDbPath,
          current: agents.current,
          requiresReentry: agents.reentry,
          flaggedRequiresReauth: agents.flagged,
        },
      },
      { command: 'doctor', operation: 'doctor.credentials.run' },
    );

    const pending = result.dryRun && result.migrated.length > 0;
    const unrecoverable = result.reentry.length + agents.reentry.length;
    if ((pending || unrecoverable > 0) && (process.exitCode ?? 0) === 0) {
      process.exitCode = 1;
    }
  },
});
