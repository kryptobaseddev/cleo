/**
 * Thin CLI glue for the read-only `cleo cloud` commands (cleo-nexus device
 * contract §4.4): read flags, call `@cleocode/core/cloud/nexus-cloud*.js`,
 * print warnings to stderr and emit the LAFS envelope (or one human line).
 *
 * No function here receives or prints a token.
 *
 * @task T12871
 */

import type {
  CloudDevicesResult,
  CloudProjectShowResult,
  CloudProjectsResult,
  CloudRetiredReplica,
  CloudStatusResult,
  CloudWarning,
  CloudWhoamiResult,
  NexusDeviceListState,
} from '@cleocode/contracts';
import {
  NEXUS_DEVICE_LIST_STATES,
  NEXUS_PRESENCE_FRESH_SECONDS,
} from '@cleocode/contracts/nexus-cloud.js';
import { emitNexusResult, failNexus, nexusApiUrlArg } from './nexus-account-cli.js';
import { terminalSafe } from './terminal-safe.js';

/** Parsed citty args. */
type Args = Readonly<Record<string, unknown>>;

/** A non-empty string flag, or `undefined`. */
export function stringArg(args: Args, name: string): string | undefined {
  const raw = args[name];
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

/** Print each warning to stderr (they also travel in `data.warnings`). */
function writeWarnings(warnings: readonly CloudWarning[]): void {
  for (const w of warnings)
    process.stderr.write(`warning: ${terminalSafe(w.message)} (${w.code})\n`);
}

/**
 * The `--state` flag of `cleo cloud devices`, validated.
 *
 * @param args - Parsed args.
 * @returns The state, or `undefined` for the server default.
 * @throws When the value is not a known state (exit 6 via `failNexus`).
 */
export function deviceStateArg(args: Args): NexusDeviceListState | undefined {
  const raw = stringArg(args, 'state');
  if (raw === undefined) return undefined;
  const known = NEXUS_DEVICE_LIST_STATES.find((s) => s === raw);
  if (known !== undefined) return known;
  throw Object.assign(new Error(`unknown --state '${raw}'`), {
    code: 'E_VALIDATION',
    fix: `use one of: ${NEXUS_DEVICE_LIST_STATES.join(', ')}`,
  });
}

/** A device holding a project, as the human summaries list it (T13290). */
interface HolderLine {
  deviceId: string;
  deviceName: string;
  presenceAt: string | null;
  thisDevice: boolean;
}

/** Presence within {@link NEXUS_PRESENCE_FRESH_SECONDS} reads as fresh. */
const FRESH_MS = NEXUS_PRESENCE_FRESH_SECONDS * 1000;

/**
 * One clause listing the devices holding a project (T13290), each with its
 * name, short id, this-machine marker and presence: ` Devices: laptop (0198abcd, this machine, presence fresh); desk (0199ef01, presence stale since 2026-10-01).`
 *
 * @param holders - One row per device (duplicates by device id are merged).
 * @param nowMs - The clock, for freshness.
 * @returns The clause, or `''` when there is none.
 */
export function devicesClause(holders: readonly HolderLine[], nowMs: number = Date.now()): string {
  const byDevice = new Map<string, HolderLine>();
  for (const h of holders) {
    const seen = byDevice.get(h.deviceId);
    // Keep the most recent presence when a device holds more than one replica.
    if (!seen || (h.presenceAt ?? '') > (seen.presenceAt ?? '')) byDevice.set(h.deviceId, h);
  }
  if (byDevice.size === 0) return '';
  const lines = [...byDevice.values()].map((h) => {
    const presence =
      h.presenceAt === null
        ? 'no presence yet'
        : nowMs - Date.parse(h.presenceAt) <= FRESH_MS
          ? 'presence fresh'
          : `presence stale since ${h.presenceAt.slice(0, 10)}`;
    const marks = [h.deviceId.slice(0, 8), ...(h.thisDevice ? ['this machine'] : []), presence];
    return `${terminalSafe(h.deviceName)} (${marks.join(', ')})`;
  });
  return ` Devices: ${lines.join('; ')}.`;
}

/** `<retired> → <successor>` for each replica this device retired (T13109). */
function retiredList(retired: readonly CloudRetiredReplica[]): string {
  return retired.map((x) => `${x.replicaId} retired → ${x.successor}`).join('; ');
}

/**
 * One human line for `cleo cloud status`.
 *
 * @param r - Status result.
 * @returns e.g. `Cloud status: ok. Device 0198… (device); project 0190… linked; replica attached; 2 device(s); head 7; 0 open conflict(s).`
 */
export function cloudStatusSummary(r: CloudStatusResult): string {
  if (r.verdict === 'not-signed-in') {
    return `Cloud status: not signed in to ${r.local.apiUrl}. Run \`cleo login nexus\`.${syncSummary(r)}`;
  }
  const s = r.summary;
  const parts = [`device ${r.local.nexusDeviceId ?? 'unknown'} (${s.profile ?? 'no profile'})`];
  if (r.local.projectId !== null) {
    parts.push(`project ${r.local.projectId} ${s.linked ? 'linked' : 'NOT linked'}`);
    parts.push(s.replicaAttached ? 'replica attached' : 'replica NOT attached');
    if (r.local.retiredReplicas.length > 0) {
      parts.push(`retired here: ${retiredList(r.local.retiredReplicas)}`);
    }
    parts.push(`${s.devices} device(s)`);
    if (s.headSeq !== null) parts.push(`head ${s.headSeq}`);
    if (s.openConflicts !== null) parts.push(`${s.openConflicts} open conflict(s)`);
  }
  return `Cloud status: ${r.verdict}. ${parts.join('; ')}.${devicesClause(r.holders ?? [])}${syncSummary(r)}`;
}

/**
 * The local sync journal of each store, one clause per store (T12998), e.g.
 * ` Sync (project): capture on; 3 unsealed; last sealed seq 41; server fields unknown until T12343/S4.`
 */
function syncSummary(r: CloudStatusResult): string {
  if (r.sync === undefined) return '';
  return r.sync.streams
    .map((st) => {
      const on = Object.entries(st.flags)
        .filter(([, v]) => v)
        .map(([k]) => k);
      const quarantined = Object.values(st.quarantined).reduce((n, c) => n + c, 0);
      const parts = [
        !st.journalInstalled
          ? 'journal not installed'
          : on.length > 0
            ? `${on.join(', ')} on`
            : 'all flags off',
        `${st.unsealedOps} unsealed`,
        `last sealed seq ${st.lastSealedSeq ?? 'none'}`,
        ...(quarantined > 0 ? [`${quarantined} quarantined`] : []),
        'server fields unknown until T12343/S4',
      ];
      return ` Sync (${st.scope}${st.stream ? ` ${st.stream}` : ''}): ${parts.join('; ')}.`;
    })
    .join('');
}

/**
 * One human line for `cleo cloud projects show`.
 *
 * @param r - Project detail.
 * @returns e.g. `Project p "demo" (owner): 2 active device(s), 3 replica(s) (retired on this device: r-1 retired → r-2), head 7, 0 open conflict(s).`
 */
export function cloudProjectShowSummary(
  r: CloudProjectShowResult,
  thisDeviceId: string | null = null,
): string {
  // Replicas this device retired stay listed by the server until S4 (T13109).
  const retired =
    r.retiredHere.length > 0 ? ` (retired on this device: ${retiredList(r.retiredHere)})` : '';
  const retiredIds = new Set(r.retiredHere.map((x) => x.replicaId));
  const holders = r.replicas
    .filter((rep) => !retiredIds.has(rep.replicaId))
    .map((rep) => ({
      deviceId: rep.deviceId,
      deviceName: rep.deviceName,
      presenceAt: rep.presenceAt,
      thisDevice: thisDeviceId !== null && rep.deviceId === thisDeviceId,
    }));
  return `Project ${r.projectId} "${terminalSafe(r.project.label ?? '')}" (${r.role}): ${r.devices.active} active device(s), ${r.replicas.length} replica(s)${retired}, head ${r.stream?.headSeq ?? 'none'}, ${r.openConflicts} open conflict(s).${devicesClause(holders)}`;
}

/**
 * Run a `cleo cloud` read: call it, print warnings, emit, or fail with a LAFS error.
 *
 * @param operation - LAFS operation id (e.g. `cloud.status`).
 * @param call - The core call.
 * @param summary - Human line for the result.
 */
export async function runCloudRead<R extends { warnings: CloudWarning[] }>(
  operation: string,
  call: () => Promise<R>,
  summary: (r: R) => string,
): Promise<void> {
  let result: R;
  try {
    result = await call();
  } catch (err) {
    // Warnings collected before the failure (e.g. a logout retry, an
    // unreadable store) are printed, not lost with the result.
    const { NexusCloudOfflineError } = await import(
      /* webpackIgnore: true */ '@cleocode/core/cloud/nexus-cloud-status.js'
    );
    if (err instanceof NexusCloudOfflineError) writeWarnings(err.publicDetails.warnings);
    failNexus(err, operation);
  }
  writeWarnings(result.warnings);
  emitNexusResult(result, summary(result), 'cloud', operation);
}

/**
 * `cleo cloud status [--project <id>]`.
 *
 * @param args - Parsed args (`--api-url`, `--project`).
 */
export async function runCloudStatus(args: Args): Promise<void> {
  // TODO(T12905): `--report` (send presence before E3) is out of scope here.
  await runCloudRead<CloudStatusResult>(
    'cloud.status',
    async () => {
      const { getNexusCloudStatus } = await import(
        /* webpackIgnore: true */ '@cleocode/core/cloud/nexus-cloud-status.js'
      );
      const projectId = stringArg(args, 'project');
      return getNexusCloudStatus({
        apiUrl: nexusApiUrlArg(args),
        ...(projectId !== undefined ? { projectId } : {}),
      });
    },
    cloudStatusSummary,
  );
}

/**
 * `cleo cloud whoami`.
 *
 * @param args - Parsed args (`--api-url`).
 */
export async function runCloudWhoami(args: Args): Promise<void> {
  await runCloudRead<CloudWhoamiResult>(
    'cloud.whoami',
    async () => {
      const { nexusCloudWhoami } = await import(
        /* webpackIgnore: true */ '@cleocode/core/cloud/nexus-cloud.js'
      );
      return nexusCloudWhoami({ apiUrl: nexusApiUrlArg(args) });
    },
    (r) =>
      `Signed in to ${r.apiUrl} as ${r.user.email} with a ${r.credential.kind} credential${r.device ? ` (device ${r.device.deviceId}, profile ${r.credential.profile ?? 'none'})` : ''}.`,
  );
}

/**
 * `cleo cloud devices [--state <s>]`.
 *
 * @param args - Parsed args (`--api-url`, `--state`).
 */
export async function runCloudDevices(args: Args): Promise<void> {
  await runCloudRead<CloudDevicesResult>(
    'cloud.devices.list',
    async () => {
      const state = deviceStateArg(args);
      const { listNexusCloudDevices } = await import(
        /* webpackIgnore: true */ '@cleocode/core/cloud/nexus-cloud.js'
      );
      return listNexusCloudDevices({
        apiUrl: nexusApiUrlArg(args),
        ...(state !== undefined ? { state } : {}),
      });
    },
    (r) =>
      `${r.count} device(s) on ${r.apiUrl}${r.state ? ` (state ${r.state})` : ''}: ${r.devices.map((d) => `${terminalSafe(d.name)} ${d.deviceId} ${d.state}${d.current ? ' (this machine)' : ''}`).join('; ')}`,
  );
}

/**
 * `cleo cloud projects [--org <id>]` and `cleo cloud projects show [<id>]`.
 *
 * @param args - Parsed args (`action`, `id`, `--api-url`, `--org`).
 */
export async function runCloudProjects(args: Args): Promise<void> {
  const action = stringArg(args, 'action');
  if (action === 'show') {
    await runCloudRead<CloudProjectShowResult>(
      'cloud.projects.show',
      async () => {
        const projectId = stringArg(args, 'id');
        const { showNexusCloudProject } = await import(
          /* webpackIgnore: true */ '@cleocode/core/cloud/nexus-cloud.js'
        );
        return showNexusCloudProject({
          apiUrl: nexusApiUrlArg(args),
          ...(projectId !== undefined ? { projectId } : {}),
        });
      },
      cloudProjectShowSummary,
    );
    return;
  }
  if (action !== undefined && action !== 'list') {
    failNexus(
      Object.assign(new Error(`unknown action '${action}'`), {
        code: 'E_VALIDATION',
        fix: 'use `cleo cloud projects` or `cleo cloud projects show [<id>]`',
      }),
      'cloud.projects.list',
    );
  }
  await runCloudRead<CloudProjectsResult>(
    'cloud.projects.list',
    async () => {
      const organizationId = stringArg(args, 'org');
      const { listNexusCloudProjects } = await import(
        /* webpackIgnore: true */ '@cleocode/core/cloud/nexus-cloud.js'
      );
      return listNexusCloudProjects({
        apiUrl: nexusApiUrlArg(args),
        ...(organizationId !== undefined ? { organizationId } : {}),
      });
    },
    (r) =>
      `${r.count} project(s) on ${r.apiUrl}: ${r.projects.map((p) => `${terminalSafe(p.label ?? p.projectId)} (${p.role})`).join('; ')}`,
  );
}
