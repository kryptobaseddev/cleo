/**
 * `cleo doctor nexus-residency` — do the nexus tables live where nexus assumes?
 *
 * Nexus ATTACHes the global `cleo.db` onto the project handle so its registry
 * tables resolve by bare name through SQLite's fall-through. That works only
 * while each bare name exists in exactly one of the two schemas — a table
 * present in both is answered by `main` with no error and no cue.
 *
 * It is already half-false: ADR-090/T11538 moved the four code-graph tables to
 * the project scope and T11539 removed them from the global schema source, but
 * no migration drops them from a database that already has them. Nexus is
 * correct today by resolution order, not by the invariant it documents.
 *
 * Read-only. It reports; it drops nothing — see the module docblock for why a
 * populated orphan is a migration question rather than a cleanup.
 *
 * @task T12158
 */

import { getCleoHome, getProjectRoot } from '@cleocode/core';
import { scanNexusSchemaResidency } from '@cleocode/core/doctor/nexus-schema-residency.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor nexus-residency` subcommand.
 *
 * Exits non-zero when any finding exists, so it can gate a cleanup step. A
 * correct install exits 0 with an empty list.
 *
 * @task T12158
 */
export const doctorNexusResidencyCommand = defineCommand({
  meta: {
    name: 'nexus-residency',
    description:
      'Report nexus tables resident in the wrong store — graph tables orphaned in the global ' +
      'cleo.db, or a bare-name registry table that resolves in both schemas. Read-only.',
  },
  args: {
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run() {
    const result = scanNexusSchemaResidency(getProjectRoot(), getCleoHome());

    cliOutput(result, {
      command: 'doctor',
      operation: 'doctor.nexus-residency.run',
    });

    if (result.findings.length > 0 && (process.exitCode === undefined || process.exitCode === 0)) {
      process.exitCode = 1;
    }
  },
});
