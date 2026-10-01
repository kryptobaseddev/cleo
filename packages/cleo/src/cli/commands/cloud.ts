/**
 * `cleo cloud` — read-only Cleo Nexus reads with this machine's device
 * credential (cleo-nexus device contract §4.4, D6). `cleo nexus` stays the
 * local code graph; `cleo login nexus` and `cleo project link` stay as they are.
 *
 * - `cleo cloud status [--project <id>]` — the agent's single verification
 *   call (E3): `{ verdict, summary, local, remote, warnings }`.
 * - `cleo cloud whoami` — E2.
 * - `cleo cloud devices [--state <s>]` — E5, following cursors.
 * - `cleo cloud projects [--org <id>]` — E13, following cursors.
 * - `cleo cloud projects show [<id>]` — E14 (default: the current project).
 *
 * Every request these commands make is a GET. Getting the device credential
 * can still write, as every device-credential command does (contract §3.4,
 * §3.5): a 9.24 session is upgraded once through E1, and unsettled logouts are
 * retried through E9/E10. Thin handlers: the flows live in
 * `@cleocode/core/cloud/nexus-cloud.js` and `nexus-cloud-status.js`.
 *
 * @module cli/commands/cloud
 * @task T12871
 */

import { NEXUS_DEVICE_LIST_STATES } from '@cleocode/contracts';
import { defineCommand } from '../lib/define-cli-command.js';
import { NEXUS_API_URL_ARG } from '../lib/nexus-account-cli.js';
import {
  runCloudDevices,
  runCloudProjects,
  runCloudStatus,
  runCloudWhoami,
} from '../lib/nexus-cloud-cli.js';

const JSON_ARG = { type: 'boolean', description: 'Output as JSON envelope' } as const;

const statusSubCommand = defineCommand({
  meta: {
    name: 'status',
    description:
      'Verify this machine against Cleo Nexus in one call: device, credential, project link, replica and stream. Returns { verdict, summary, local, remote, warnings }; verdict is ok, attention, not-linked, not-registered or not-signed-in. Reads only (GET; never binds a replica), except that getting the credential may upgrade a 9.24 session (E1) and retry unsettled logouts (E9/E10).',
  },
  args: {
    project: {
      type: 'string',
      description: 'Project id to check (default: the current project).',
    },
    'api-url': NEXUS_API_URL_ARG,
    json: JSON_ARG,
  },
  async run({ args }) {
    await runCloudStatus(args as Record<string, unknown>);
  },
});

const whoamiSubCommand = defineCommand({
  meta: {
    name: 'whoami',
    description: 'Show the Cleo Nexus user, organizations, credential and device for this machine.',
  },
  args: { 'api-url': NEXUS_API_URL_ARG, json: JSON_ARG },
  async run({ args }) {
    await runCloudWhoami(args as Record<string, unknown>);
  },
});

const devicesSubCommand = defineCommand({
  meta: {
    name: 'devices',
    description:
      "List the account's devices (newest first), following every page; reports truncation.",
  },
  args: {
    state: {
      type: 'string',
      description: `Filter: ${NEXUS_DEVICE_LIST_STATES.join(', ')} (default: active).`,
    },
    'api-url': NEXUS_API_URL_ARG,
    json: JSON_ARG,
  },
  async run({ args }) {
    await runCloudDevices(args as Record<string, unknown>);
  },
});

const projectsSubCommand = defineCommand({
  meta: {
    name: 'projects',
    description:
      'List visible Cleo Nexus projects, following every page (cleo cloud projects [--org <id>]), or show one with its replicas and device counts (cleo cloud projects show [<id>], default: the current project).',
  },
  args: {
    action: {
      type: 'positional',
      description: "'list' (default) or 'show'.",
      required: false,
    },
    id: {
      type: 'positional',
      description: 'Project id for show (default: the current project).',
      required: false,
    },
    org: { type: 'string', description: 'Only this organization id (list).' },
    'api-url': NEXUS_API_URL_ARG,
    json: JSON_ARG,
  },
  async run({ args }) {
    await runCloudProjects(args as Record<string, unknown>);
  },
});

/**
 * `cleo cloud` — read-only Cleo Nexus reads.
 *
 * @task T12871
 */
export const cloudCommand = defineCommand({
  meta: {
    name: 'cloud',
    description:
      'Cleo Nexus reads with the device credential (GET only; getting the credential may upgrade a 9.24 session or retry unsettled logouts): status (one-call verification), whoami, devices, projects [show].',
  },
  subCommands: {
    status: statusSubCommand,
    whoami: whoamiSubCommand,
    devices: devicesSubCommand,
    projects: projectsSubCommand,
  },
});
