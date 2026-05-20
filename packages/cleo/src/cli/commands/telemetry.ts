/**
 * CLI command group: `cleo telemetry` — anonymous skills-usage telemetry.
 *
 * SG-CLEO-SKILLS Sphere A owner-CI top-N council pipeline (T9572 / T9666)
 * needs an anonymous loadCount signal from operator machines to rank which
 * skills the council reviews each week. The contract:
 *
 *   - **Default-on** for new installs (set by the setup wizard, T9673).
 *   - **Single opt-out**: `cleo telemetry disable` flips one boolean.
 *   - **Anonymous**: an `installId` (UUID) is generated locally; no user,
 *     session, path, or skill content ever leaves the machine.
 *   - **Payload schema (LOCKED)**:
 *       { installId: string, period: ISO date, skills: { canonicalSkillName, loadCount }[] }
 *   - **Transport**: scrubbed PR diff against `docs/skills/telemetry-aggregate.json`
 *     on the cleocode repo (no HTTPS endpoint, see ADR-074).
 *
 * Subcommands:
 *   cleo telemetry enable    — set telemetry.enabled = true
 *   cleo telemetry disable   — set telemetry.enabled = false
 *   cleo telemetry status    — print current { enabled, period, installId }
 *
 * Config keys (all global, in the user-scope config file):
 *   - telemetry.enabled    — boolean
 *   - telemetry.period     — string, currently always 'monthly'
 *   - telemetry.installId  — anonymous UUID, generated on first enable
 *
 * @task T9666
 * @epic T9572
 * @see .cleo/adrs/ADR-074-skills-telemetry-pr-diff-transport.md
 * @see docs/architecture/SG-CLEO-SKILLS-architecture-v3.md §5
 */

import { randomUUID } from 'node:crypto';
import { getConfigValue, setConfigValue } from '@cleocode/core';
import { defineCommand } from 'citty';
import { isSubCommandDispatch } from '../lib/subcommand-guard.js';
import { cliOutput } from '../renderers/index.js';

/**
 * Default reporting period for the telemetry payload.
 *
 * Locked to `monthly` in T9666; future periods (weekly, on-demand) MUST be
 * added as a discriminated union here rather than as free-form strings so
 * the type-checker can enforce the contract on every consumer.
 */
export type TelemetryPeriod = 'monthly';

/**
 * Persisted shape of the `telemetry` config key tree.
 *
 * Stored under the global config so the opt-out / installId survive
 * `cleo init` invocations in new project roots — the install identity is a
 * property of the machine, not the project.
 */
export interface TelemetryConfig {
  /** Operator opted-in to anonymous skills-usage telemetry. */
  enabled: boolean;
  /** Reporting cadence — locked to `monthly` in T9666. */
  period: TelemetryPeriod;
  /** Anonymous install identifier (UUID v4). Created on first enable. */
  installId?: string;
}

/**
 * Read the resolved {@link TelemetryConfig}, populating defaults for any
 * missing keys so callers never need to branch on `undefined`.
 *
 * Defaults: `{ enabled: false, period: 'monthly' }`. The wizard step
 * (T9673) writes `enabled: true` on first-run so most operators see
 * `enabled: true` here; the `false` default applies to upgrades that
 * pre-date the wizard step landing.
 *
 * @returns Current telemetry config bag.
 */
async function readTelemetryConfig(): Promise<TelemetryConfig> {
  const enabledResolved = await getConfigValue<boolean>('telemetry.enabled');
  const periodResolved = await getConfigValue<TelemetryPeriod>('telemetry.period');
  const installIdResolved = await getConfigValue<string>('telemetry.installId');

  const enabled = enabledResolved.value === true;
  const period: TelemetryPeriod = periodResolved.value === 'monthly' ? 'monthly' : 'monthly';
  const installId =
    typeof installIdResolved.value === 'string' ? installIdResolved.value : undefined;

  return { enabled, period, installId };
}

/**
 * Generate an anonymous install identifier if none is present in the
 * global config. The ID is a UUID v4 — no PII, no system info.
 *
 * Subsequent enable/disable invocations preserve the existing ID so the
 * owner CI can deduplicate periodic submissions without learning who
 * the operator is.
 *
 * @returns The install ID (existing or freshly generated).
 */
async function ensureInstallId(): Promise<string> {
  const existing = await getConfigValue<string>('telemetry.installId');
  if (typeof existing.value === 'string' && existing.value.length > 0) {
    return existing.value;
  }
  const newId = randomUUID();
  await setConfigValue('telemetry.installId', newId, undefined, { global: true });
  return newId;
}

/** `cleo telemetry enable` — opt-in to anonymous skills-usage telemetry. */
const enableSub = defineCommand({
  meta: {
    name: 'enable',
    description: 'Enable anonymous skills-usage telemetry (default-on for new installs)',
  },
  async run() {
    await setConfigValue('telemetry.enabled', true, undefined, { global: true });
    await setConfigValue('telemetry.period', 'monthly', undefined, { global: true });
    const installId = await ensureInstallId();
    const config = await readTelemetryConfig();
    cliOutput(
      { ...config, installId },
      {
        command: 'telemetry',
        message: `Telemetry enabled (installId=${installId}, period=${config.period}).`,
        operation: 'telemetry.enable',
      },
    );
  },
});

/** `cleo telemetry disable` — opt-out of anonymous skills-usage telemetry. */
const disableSub = defineCommand({
  meta: {
    name: 'disable',
    description: 'Disable anonymous skills-usage telemetry',
  },
  async run() {
    await setConfigValue('telemetry.enabled', false, undefined, { global: true });
    const config = await readTelemetryConfig();
    cliOutput(config, {
      command: 'telemetry',
      message: 'Telemetry disabled.',
      operation: 'telemetry.disable',
    });
  },
});

/** `cleo telemetry status` — print the current telemetry config bag. */
const statusSub = defineCommand({
  meta: {
    name: 'status',
    description: 'Print current telemetry configuration',
  },
  async run() {
    const config = await readTelemetryConfig();
    cliOutput(config, {
      command: 'telemetry',
      message: `Telemetry is ${config.enabled ? 'enabled' : 'disabled'} (period=${config.period}).`,
      operation: 'telemetry.status',
    });
  },
});

/**
 * `cleo telemetry` — anonymous skills-usage telemetry control surface.
 *
 * Top-level group; dispatches to enable/disable/status. Default action
 * (no subcommand) is equivalent to `cleo telemetry status`.
 */
export const telemetryCommand = defineCommand({
  meta: {
    name: 'telemetry',
    description: 'Manage anonymous skills-usage telemetry (enable/disable/status)',
  },
  subCommands: {
    enable: enableSub,
    disable: disableSub,
    status: statusSub,
  },
  async run({ cmd, rawArgs }) {
    // Parent run() fires after the subcommand per citty@0.2.x — skip the
    // default status print so `cleo telemetry enable` doesn't double-output.
    if (isSubCommandDispatch(rawArgs, cmd.subCommands)) return;
    // No subcommand → default to status.
    const config = await readTelemetryConfig();
    cliOutput(config, {
      command: 'telemetry',
      message: `Telemetry is ${config.enabled ? 'enabled' : 'disabled'} (period=${config.period}).`,
      operation: 'telemetry.status',
    });
  },
});
