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
 * - `cleo cloud restore <name>` — a project onto this machine by name, label
 *   or id (T13102).
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

import { NEXUS_DEVICE_LIST_STATES } from '@cleocode/contracts/nexus-cloud.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { NEXUS_API_URL_ARG } from '../lib/nexus-account-cli.js';
import {
  runCloudDevices,
  runCloudProjects,
  runCloudStatus,
  runCloudWhoami,
} from '../lib/nexus-cloud-cli.js';
import {
  runCloudActivity,
  runCloudLease,
  runCloudPull,
  runCloudPush,
  runCloudRestore,
  runCloudVault,
  runCloudVerify,
} from '../lib/nexus-vault-cli.js';

const JSON_ARG = { type: 'boolean', description: 'Output as JSON envelope' } as const;

const SCOPE_ARG = {
  type: 'string',
  description:
    "Which store: 'project' (the current project, default) or 'global' (this account's global store: the main brain).",
} as const;

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

const pushSubCommand = defineCommand({
  meta: {
    name: 'push',
    description:
      'Back up this store to Cleo Nexus as an encrypted snapshot; the key is escrowed on Cleo Nexus (released only to your approved devices), so this is encrypted at rest, not zero-knowledge. The server also stores per-table row counts and keyed hashes in plaintext. Refused when another device holds the write lease or pushed since this machine last synced (pull first); --force takes the lease and pushes anyway as a labelled fork. The lease is released when the push ends unless --hold.',
  },
  args: {
    scope: SCOPE_ARG,
    force: {
      type: 'boolean',
      description:
        'Take the lease from another device / push over a newer snapshot (a labelled fork).',
    },
    hold: {
      type: 'boolean',
      description:
        'Keep the write lease after the push (another device cannot push until it expires or `cleo cloud lease release`).',
    },
    'api-url': NEXUS_API_URL_ARG,
    json: JSON_ARG,
  },
  async run({ args }) {
    await runCloudPush(args as Record<string, unknown>);
  },
});

const pullSubCommand = defineCommand({
  meta: {
    name: 'pull',
    description:
      "Bring this store to the cloud's newest snapshot, verified by per-table count and hash before anything is replaced; this machine's local-only state is kept. Refuses to overwrite local changes made since the last sync unless --force (a safety backup is taken first).",
  },
  args: {
    scope: SCOPE_ARG,
    force: { type: 'boolean', description: 'Overwrite local changes (after a safety backup).' },
    'api-url': NEXUS_API_URL_ARG,
    json: JSON_ARG,
  },
  async run({ args }) {
    await runCloudPull(args as Record<string, unknown>);
  },
});

const restoreSubCommand = defineCommand({
  meta: {
    name: 'restore',
    description:
      'Restore a snapshot: the newest, or --checkpoint <id> (point in time); or a project this machine does not have yet by name, label or id: cleo cloud restore <name> [--into <dir>] (then it is linked to this device). A name several projects share lists them. Verified by count and hash before activation; a safety backup of existing data is taken first.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Project to restore onto this machine: its name, label or id (see `cleo cloud projects`; the same as --project).',
      required: false,
    },
    scope: SCOPE_ARG,
    checkpoint: { type: 'string', description: 'Snapshot id to restore (see `cleo cloud vault`).' },
    project: {
      type: 'string',
      description:
        'Project to restore onto this machine: its name, label or server id (see `cleo cloud projects`).',
    },
    into: {
      type: 'string',
      description: 'Directory for --project (default: the current directory).',
    },
    force: { type: 'boolean', description: 'Overwrite local changes (after a safety backup).' },
    'api-url': NEXUS_API_URL_ARG,
    json: JSON_ARG,
  },
  async run({ args }) {
    await runCloudRestore(args as Record<string, unknown>);
  },
});

const verifyVaultSubCommand = defineCommand({
  meta: {
    name: 'verify',
    description:
      "Integrity check across machines: SQLite integrity of this store, its per-table counts and keyed hashes against the cloud's newest snapshot, and every device's newest snapshot against it. Verdict: match, ahead, behind, diverged, empty, or untrusted (the newest snapshot's signature does not verify).",
  },
  args: { scope: SCOPE_ARG, 'api-url': NEXUS_API_URL_ARG, json: JSON_ARG },
  async run({ args }) {
    await runCloudVerify(args as Record<string, unknown>);
  },
});

const vaultSubCommand = defineCommand({
  meta: {
    name: 'vault',
    description:
      "The store's cloud vault: snapshot lineage (newest first), the last push of each device, tables changed since this machine's last sync, and who holds the write lease until when.",
  },
  args: { scope: SCOPE_ARG, 'api-url': NEXUS_API_URL_ARG, json: JSON_ARG },
  async run({ args }) {
    await runCloudVault(args as Record<string, unknown>);
  },
});

const leaseSubCommand = defineCommand({
  meta: {
    name: 'lease',
    description: 'Hand the write lease back so another device can push: cleo cloud lease release.',
  },
  args: {
    action: { type: 'positional', description: "'release'.", required: false },
    scope: SCOPE_ARG,
    'api-url': NEXUS_API_URL_ARG,
    json: JSON_ARG,
  },
  async run({ args }) {
    await runCloudLease(args as Record<string, unknown>);
  },
});

const activitySubCommand = defineCommand({
  meta: {
    name: 'activity',
    description:
      "What this account's devices did on Cleo Nexus and when (snapshots pushed or refused, leases taken, forced or released, projects linked, devices enrolled), newest first.",
  },
  args: {
    limit: { type: 'string', description: 'Events to show (1-200, default 50).' },
    before: { type: 'string', description: 'Older page: the nextBefore of a previous call.' },
    project: { type: 'string', description: 'Only events about this server project id.' },
    device: {
      type: 'string',
      description: 'Only events by this device id (see `cleo cloud devices`).',
    },
    'api-url': NEXUS_API_URL_ARG,
    json: JSON_ARG,
  },
  async run({ args }) {
    await runCloudActivity(args as Record<string, unknown>);
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
      'Cleo Nexus with the device credential: status (one-call verification), whoami, devices, projects [show], activity; the encrypted vault: push, pull, restore, verify, vault, lease release.',
  },
  subCommands: {
    status: statusSubCommand,
    whoami: whoamiSubCommand,
    devices: devicesSubCommand,
    projects: projectsSubCommand,
    activity: activitySubCommand,
    push: pushSubCommand,
    pull: pullSubCommand,
    restore: restoreSubCommand,
    verify: verifyVaultSubCommand,
    vault: vaultSubCommand,
    lease: leaseSubCommand,
  },
});
