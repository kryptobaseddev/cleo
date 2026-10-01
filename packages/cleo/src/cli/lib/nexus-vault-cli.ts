/**
 * CLI glue for the cloud vault and activity commands: `cleo cloud push |
 * pull | restore | verify | vault | lease release | activity`. Parses flags,
 * calls `@cleocode/core/cloud/nexus-vault.js` (or `nexus-cloud-activity.js`)
 * and emits one LAFS envelope, with a one-line human summary.
 *
 * @task T12337
 * @task T12950
 * @task T12951
 * @epic T12322
 */

import type {
  CloudActivityResult,
  CloudLeaseReleaseResult,
  CloudPushResult,
  CloudRestoreResult,
  CloudVaultScope,
  CloudVaultStatusResult,
  CloudVerifyResult,
} from '@cleocode/contracts';
import { failNexus, nexusApiUrlArg } from './nexus-account-cli.js';
import { runCloudRead, stringArg } from './nexus-cloud-cli.js';

/** Parsed citty args. */
type Args = Readonly<Record<string, unknown>>;

/** `--scope project|global` (default project). */
function scopeArg(args: Args, operation: string): CloudVaultScope {
  const raw = stringArg(args, 'scope') ?? 'project';
  if (raw === 'project' || raw === 'global') return raw;
  failNexus(
    Object.assign(new Error(`unknown scope '${raw}'`), {
      code: 'E_VALIDATION',
      fix: 'use --scope project (default) or --scope global',
    }),
    operation,
  );
}

const vaultModule = () => import(/* webpackIgnore: true */ '@cleocode/core/cloud/nexus-vault.js');

function common(args: Args, operation: string) {
  return { apiUrl: nexusApiUrlArg(args), scope: scopeArg(args, operation) };
}

const who = (name: string | null, id: string) => name ?? id;

/**
 * `cleo cloud push [--scope] [--force]`.
 *
 * @param args - Parsed args.
 */
export async function runCloudPush(args: Args): Promise<void> {
  await runCloudRead<CloudPushResult>(
    'cloud.push',
    async () =>
      (await vaultModule()).pushNexusVault({
        ...common(args, 'cloud.push'),
        force: args['force'] === true,
      }),
    (r) =>
      r.status === 'up-to-date'
        ? `Up to date: ${r.streamId} already holds this ${r.scope} store (snapshot ${r.snapshot?.checkpointId ?? 'none'}).`
        : `Pushed ${r.scope} snapshot ${r.snapshot?.checkpointId} to ${r.streamId} (${r.snapshot?.rows ?? 0} rows${r.parentCheckpointId ? `, parent ${r.parentCheckpointId}` : ', first snapshot'}${r.forked ? ', FORK: lease taken by force' : ''}).`,
  );
}

/**
 * `cleo cloud pull [--scope] [--force]`.
 *
 * @param args - Parsed args.
 */
export async function runCloudPull(args: Args): Promise<void> {
  await runCloudRestoreLike(args, 'cloud.pull', 'pull');
}

/**
 * `cleo cloud restore [--scope] [--checkpoint <id>] [--project <id> --into <dir>] [--force]`.
 *
 * @param args - Parsed args.
 */
export async function runCloudRestore(args: Args): Promise<void> {
  await runCloudRestoreLike(args, 'cloud.restore', 'restore');
}

async function runCloudRestoreLike(
  args: Args,
  operation: string,
  mode: 'pull' | 'restore',
): Promise<void> {
  await runCloudRead<CloudRestoreResult>(
    operation,
    async () => {
      const checkpointId = stringArg(args, 'checkpoint');
      const projectId = stringArg(args, 'project');
      const into = stringArg(args, 'into');
      return (await vaultModule()).restoreNexusVault({
        ...common(args, operation),
        mode,
        force: args['force'] === true,
        ...(mode === 'restore' && checkpointId !== undefined ? { checkpointId } : {}),
        ...(mode === 'restore' && projectId !== undefined ? { projectId } : {}),
        ...(mode === 'restore' && into !== undefined ? { into } : {}),
        relink: async (projectRoot: string) => {
          const { linkProjectToNexus } = await import(
            /* webpackIgnore: true */ '@cleocode/core/cloud/nexus-link.js'
          );
          try {
            const linked = await linkProjectToNexus({ apiUrl: nexusApiUrlArg(args), projectRoot });
            return linked.warnings;
          } catch (err) {
            return [
              `restored, but attaching this copy failed (${err instanceof Error ? err.message : String(err)}); run \`cleo project link\``,
            ];
          }
        },
      });
    },
    (r) =>
      r.status === 'up-to-date'
        ? `Up to date: this ${r.scope} store already holds snapshot ${r.snapshot?.checkpointId ?? 'none'}.`
        : `Restored ${r.scope} snapshot ${r.snapshot?.checkpointId} into ${r.target}: ${r.tables} table(s) verified by count and hash${r.safetyBackup ? `; previous state saved to ${r.safetyBackup}` : ''}.`,
  );
}

/**
 * `cleo cloud verify [--scope]`.
 *
 * @param args - Parsed args.
 */
export async function runCloudVerify(args: Args): Promise<void> {
  await runCloudRead<CloudVerifyResult>(
    'cloud.verify',
    async () => (await vaultModule()).verifyNexusVault(common(args, 'cloud.verify')),
    (r) => {
      const bad = r.tables.filter((t) => !t.match).map((t) => t.table);
      const devices = r.devices
        .map(
          (d) =>
            `${who(d.deviceName, d.deviceId)} ${d.matchesHead ? 'matches' : 'differs from'} head`,
        )
        .join('; ');
      return `Verify ${r.scope}: ${r.verdict}${bad.length ? ` (${bad.length} table(s) differ: ${bad.slice(0, 8).join(', ')}${bad.length > 8 ? ', …' : ''})` : ''}; local integrity ${r.localIntegrity ? 'ok' : 'FAILED'}${devices ? `; ${devices}` : ''}.`;
    },
  );
}

/**
 * `cleo cloud vault [--scope]`.
 *
 * @param args - Parsed args.
 */
export async function runCloudVault(args: Args): Promise<void> {
  await runCloudRead<CloudVaultStatusResult>(
    'cloud.vault',
    async () => (await vaultModule()).nexusVaultStatus(common(args, 'cloud.vault')),
    (r) =>
      `Vault ${r.scope} ${r.streamId}: ${r.lineage.length} snapshot(s), head ${r.head?.checkpointId ?? 'none'}${r.head ? ` by ${who(r.head.deviceName, r.head.deviceId)}` : ''}; this store last synced ${r.lastSynced ?? 'never'}; ${r.pendingChanges.length} table(s) changed since; leases: ${r.leases.map((l) => `${l.role} ${who(l.deviceName, l.deviceId ?? l.replicaId)} until ${l.expiresAt}${l.mine ? ' (this machine)' : ''}${l.forkedFromReplicaId ? ' (forked)' : ''}`).join('; ') || 'none'}.`,
  );
}

/**
 * `cleo cloud lease release [--scope]`.
 *
 * @param args - Parsed args.
 */
export async function runCloudLease(args: Args): Promise<void> {
  const action = stringArg(args, 'action') ?? 'release';
  if (action !== 'release') {
    failNexus(
      Object.assign(new Error(`unknown action '${action}'`), {
        code: 'E_VALIDATION',
        fix: 'use `cleo cloud lease release` (see `cleo cloud vault` for holders)',
      }),
      'cloud.lease.release',
    );
  }
  await runCloudRead<CloudLeaseReleaseResult>(
    'cloud.lease.release',
    async () => (await vaultModule()).releaseNexusVaultLease(common(args, 'cloud.lease.release')),
    (r) =>
      r.released
        ? `Released the write lease on ${r.streamId}: another device may push now.`
        : `This machine held no write lease on ${r.streamId}.`,
  );
}

/**
 * `cleo cloud activity [--limit] [--before] [--project]`.
 *
 * @param args - Parsed args.
 */
export async function runCloudActivity(args: Args): Promise<void> {
  await runCloudRead<CloudActivityResult>(
    'cloud.activity',
    async () => {
      const { nexusCloudActivity } = await import(
        /* webpackIgnore: true */ '@cleocode/core/cloud/nexus-cloud-activity.js'
      );
      const limit = stringArg(args, 'limit');
      const before = stringArg(args, 'before');
      const projectId = stringArg(args, 'project');
      const deviceId = stringArg(args, 'device');
      return nexusCloudActivity({
        ...(deviceId !== undefined ? { deviceId } : {}),
        apiUrl: nexusApiUrlArg(args),
        ...(limit !== undefined ? { limit: Number(limit) } : {}),
        ...(before !== undefined ? { before } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
      });
    },
    (r) =>
      `${r.items.length} event(s)${r.projectId ? ` for project ${r.projectId}` : ''}: ${r.items
        .slice(0, 10)
        .map(
          (i) =>
            `${i.at} ${who(i.deviceName, i.deviceId ?? 'account')}${i.thisDevice ? ' (this machine)' : ''} ${i.action}${i.target ? ` ${i.target}` : ''}`,
        )
        .join('; ')}${r.items.length > 10 ? '; …' : ''}`,
  );
}
