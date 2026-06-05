/**
 * `cleo doctor exodus` — read-only exodus health report (T11837).
 *
 * The fleet pre-check the owner flow opens with. Reports, per scope, the
 * migration state (sealed / migrated-unsealed / needs-migration / no-cleo-data),
 * legacy DB presence + sizes (flagging ≥500 MB DBs), completion-marker state,
 * stranded residue, disk headroom, and the `CLEO_DISABLE_EXODUS_ON_OPEN`
 * kill-switch — with actionable next-step recommendations. Never writes; never
 * runs the heavy verify digest.
 *
 * @task T11837 (EP-EXODUS-FLEET-HARDENING)
 * @epic T11833
 * @saga T11242 (SG-DB-SUBSTRATE-V2)
 * @see packages/core/src/store/exodus/health.ts — the assembled report
 */

import { buildExodusHealth } from '@cleocode/core/store/exodus/index.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput, humanInfo } from '../renderers/index.js';

/** Human-readable byte formatter (B / KB / MB / GB). */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * `cleo doctor exodus` subcommand.
 *
 * @task T11837
 */
export const doctorExodusCommand = defineCommand({
  meta: {
    name: 'exodus-health',
    description:
      'Read-only exodus health report: per-scope migration state, legacy DB sizes, completion ' +
      'markers, disk headroom, and the kill-switch — with recommended next steps.',
  },
  run() {
    const health = buildExodusHealth(process.cwd());

    for (const sc of [health.project, health.global]) {
      humanInfo(
        `  [${sc.scope}] state=${sc.state}  consolidated=${sc.consolidatedExists ? 'yes' : 'no'}  marker=${sc.markerPresent ? 'yes' : 'no'}`,
      );
      for (const s of sc.legacySources) {
        humanInfo(
          `      ${s.present ? '✓' : '·'} ${s.name.padEnd(18)} ${
            s.present ? fmtBytes(s.bytes) : '-'
          }${s.large ? '  ⚠ LARGE' : ''}`,
        );
      }
    }
    humanInfo(
      `  disk: ${fmtBytes(health.availableBytes)} free / ${fmtBytes(health.requiredBytes)} required — ${health.diskHeadroomOk ? 'OK' : 'LOW'}`,
    );
    humanInfo(
      `  kill-switch (CLEO_DISABLE_EXODUS_ON_OPEN): ${health.killSwitchSet ? 'SET' : 'off'}`,
    );
    if (health.recommendations.length > 0) {
      humanInfo('  recommendations:');
      for (const r of health.recommendations) humanInfo(`    • ${r}`);
    }

    cliOutput(
      { kind: 'generic', ...health },
      {
        command: 'doctor exodus',
        message: `exodus health: project=${health.project.state}, global=${health.global.state}${
          health.dataParityOk ? '' : `, ${health.dataDeficits} DEFICIT(S)`
        }.`,
      },
    );
  },
});
