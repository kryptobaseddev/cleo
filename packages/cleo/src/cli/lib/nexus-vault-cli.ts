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
  CloudConflictResolveResult,
  CloudConflictsResult,
  CloudLeaseReleaseResult,
  CloudPushResult,
  CloudRestoreResult,
  CloudSyncPushEnableResult,
  CloudSyncResult,
  CloudVaultScope,
  CloudVaultStatusResult,
  CloudVerifyResult,
} from '@cleocode/contracts';
import { failNexus, nexusApiUrlArg } from './nexus-account-cli.js';
import { runCloudRead, stringArg } from './nexus-cloud-cli.js';
import { terminalSafe } from './terminal-safe.js';

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

/** A device as a human line names it: its server-supplied name, else its id, made terminal-safe (T13295). */
const who = (name: string | null, id: string) => terminalSafe(name ?? id);

/**
 * `--limit` of `cleo cloud activity`, validated (T13007): a whole number from
 * 1 to 200, else E_VALIDATION (exit 6 via `failNexus`).
 *
 * @param args - Parsed args.
 * @returns The limit, or `undefined` for the default.
 */
function activityLimitArg(args: Args): number | undefined {
  const raw = stringArg(args, 'limit');
  if (raw === undefined) return undefined;
  const limit = Number(raw);
  if (/^\d+$/.test(raw) && Number.isSafeInteger(limit) && limit >= 1 && limit <= 200) return limit;
  throw Object.assign(new Error(`--limit must be a whole number from 1 to 200, got '${raw}'`), {
    code: 'E_VALIDATION',
    fix: 'pass --limit 1..200 (default 50)',
  });
}

/**
 * `cleo cloud push [--scope] [--force] [--hold]`.
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
        hold: args['hold'] === true,
      }),
    (r) =>
      r.status === 'up-to-date'
        ? `Up to date: ${r.streamId} already holds this ${r.scope} store (snapshot ${r.snapshot?.checkpointId ?? 'none'}).`
        : `Pushed ${r.scope} snapshot ${r.snapshot?.checkpointId} to ${r.streamId} (${r.snapshot?.rows ?? 0} rows${r.parentCheckpointId ? `, parent ${r.parentCheckpointId}` : ', first snapshot'}${r.forked ? ', FORK: lease taken by force' : ''}).`,
  );
}

/**
 * `cleo sync enable push [--scope]`: record the store's genesis cut and push
 * its genesis checkpoint (T12343 S4-1b). Refused while `sync.push` is
 * unreleased: this CLI never opts in.
 *
 * @param args - Parsed args.
 */
export async function runSyncEnablePush(args: Args): Promise<void> {
  await runCloudRead<CloudSyncPushEnableResult>(
    'sync.enable.push',
    async () => (await vaultModule()).enableSyncPush(common(args, 'sync.enable.push')),
    (r) =>
      r.status === 'already'
        ? `Push is already on for ${r.streamId} (genesis cut at capture ${r.cut}).`
        : `Push is on for ${r.streamId}: genesis cut at capture ${r.cut}, checkpoint ${r.snapshot?.checkpointId}${r.status === 'resumed' ? ' (resumed)' : ''}.`,
  );
}

/**
 * `cleo cloud sync [--scope]`: seal, push, pull and apply each attached
 * stream (T12996). Without `--scope`, every attached stream.
 *
 * @param args - Parsed args.
 */
export async function runCloudSync(args: Args): Promise<void> {
  const scope = stringArg(args, 'scope') === undefined ? undefined : scopeArg(args, 'cloud.sync');
  await runCloudRead<CloudSyncResult>(
    'cloud.sync',
    async () =>
      (await vaultModule()).cloudSync({
        apiUrl: nexusApiUrlArg(args),
        ...(scope !== undefined ? { scope } : {}),
      }),
    (r) =>
      r.streams
        .map((st) =>
          st.status === 'synced'
            ? `${st.streamId}: sent ${st.sent} segment(s), received ${st.received}, applied ${st.applied}${st.held > 0 ? `, ${st.held} held` : ''}${st.conflicts > 0 ? `, ${st.conflicts} in conflict` : ''} (at ${st.after} of ${st.head}).`
            : `${st.streamId ?? st.scope}: ${st.status}${st.refused ? ` (${st.refused})` : ''}.`,
        )
        .join('\n'),
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
 * `cleo cloud restore [<name>] [--scope] [--checkpoint <id>] [--project <name|id> --into <dir>] [--force]`.
 *
 * @param args - Parsed args.
 */
export async function runCloudRestore(args: Args): Promise<void> {
  await runCloudRestoreLike(args, 'cloud.restore', 'restore');
}

/**
 * The project a restore names (the `<name>` positional or `--project`), as
 * the server's project id: a name or label is resolved through the account's
 * project list (T13102). `undefined` when none was given.
 *
 * @param args - Parsed args.
 * @returns The project id, or `undefined`.
 * @throws `E_VALIDATION` when both are given and differ, or with `--scope global`;
 *   `E_NEXUS_VAULT_TARGET_OCCUPIED` when, without `--into`, the current directory is
 *   inside another CLEO project; `E_NEXUS_PROJECT_AMBIGUOUS` / `E_NEXUS_PROJECT_NOT_FOUND`
 *   from the resolution.
 */
async function restoreProjectId(args: Args): Promise<string | undefined> {
  const positional = stringArg(args, 'name');
  const flag = stringArg(args, 'project');
  if (positional !== undefined && flag !== undefined && positional !== flag) {
    throw Object.assign(new Error('give the project once: as <name> or as --project'), {
      code: 'E_VALIDATION',
      fix: 'use `cleo cloud restore <name>` (or `--project <name>`), not both',
    });
  }
  const ref = positional ?? flag;
  if (ref === undefined) return undefined;
  if (stringArg(args, 'scope') === 'global') {
    throw Object.assign(new Error('a project name restores a project, not the global store'), {
      code: 'E_VALIDATION',
      fix: 'drop --scope global to restore the project, or drop the project to restore the global store',
    });
  }
  const { assertNexusRestoreTarget, resolveNexusProjectRef } = await import(
    /* webpackIgnore: true */ '@cleocode/core/cloud/nexus-project-names.js'
  );
  // Without --into the restore lands in the current directory: never inside another project.
  if (stringArg(args, 'into') === undefined) assertNexusRestoreTarget();
  const resolved = await resolveNexusProjectRef(ref, { apiUrl: nexusApiUrlArg(args) });
  if (resolved.matchedBy === 'name') {
    process.stderr.write(
      `Restoring "${terminalSafe(resolved.name ?? '')}" (project ${resolved.projectId})...\n`,
    );
  }
  return resolved.projectId;
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
      const projectId = mode === 'restore' ? await restoreProjectId(args) : undefined;
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
    cloudRestoreSummary,
  );
}

/**
 * One human line for `cleo cloud pull` and `cleo cloud restore`.
 *
 * @param r - Restore result.
 * @returns e.g. `Restored project snapshot cp-1 into /p: 12 table(s) verified by count and hash; replica r-1 retired → r-2.`
 */
export function cloudRestoreSummary(r: CloudRestoreResult): string {
  if (r.status === 'up-to-date') {
    return `Up to date: this ${r.scope} store already holds snapshot ${r.snapshot?.checkpointId ?? 'none'}.`;
  }
  const backup = r.safetyBackup ? `; previous state saved to ${r.safetyBackup}` : '';
  // The placed file is a new store instance: its replica was retired (T13109).
  // A copy's carried replica stays live where it belongs; only the copy moves on.
  const carried =
    r.replica?.reason === 'file-identity'
      ? 'from a copied file'
      : r.replica?.reason === 'foreign-device'
        ? 'from another device'
        : null;
  const replica = !r.replica
    ? ''
    : carried
      ? `; this copy now has its own replica ${r.replica.current} (${r.replica.reason}: it carried ${r.replica.retired} ${carried})`
      : `; replica ${r.replica.retired} retired → ${r.replica.current}`;
  return `Restored ${r.scope} snapshot ${r.snapshot?.checkpointId} into ${r.target}: ${r.tables} table(s) verified by count and hash${backup}${replica}.`;
}

/**
 * The `--deep` part of the `cleo cloud verify` line (T13291): how many
 * snapshots and segments passed the byte check, and the first failure.
 *
 * @param deep - The deep check, absent without `--deep`.
 * @returns The clause, empty without `--deep`.
 */
export function deepVerifyClause(deep: CloudVerifyResult['deep']): string {
  if (!deep) return '';
  const passed = deep.snapshots.filter((x) => x.ok).length;
  const failed = deep.snapshots.find((x) => !x.ok);
  const segments = `${deep.segments.checked} segment(s) after seq ${deep.segments.from} ${deep.segments.ok ? 'verified' : `verified, then FAILED: ${deep.segments.problem}`}`;
  return `; deep: ${passed}/${deep.snapshots.length} snapshot bundle(s) verified${failed ? ` (${failed.checkpointId} FAILED: ${failed.problem})` : ''}, ${segments}`;
}

/**
 * The human line of `cleo cloud verify`: verdict, differing tables, local
 * integrity, each device against the head, the `--deep` part, and where local
 * backups are checked.
 *
 * @param r - The verify result.
 * @returns The line.
 */
export function cloudVerifySummary(r: CloudVerifyResult): string {
  const bad = r.tables.filter((t) => !t.match).map((t) => t.table);
  const devices = r.devices
    .map(
      (d) => `${who(d.deviceName, d.deviceId)} ${d.matchesHead ? 'matches' : 'differs from'} head`,
    )
    .join('; ');
  return `Verify ${r.scope}: ${r.verdict}${bad.length ? ` (${bad.length} table(s) differ: ${bad.slice(0, 8).join(', ')}${bad.length > 8 ? ', …' : ''})` : ''}; local integrity ${r.localIntegrity ? 'ok' : 'FAILED'}${devices ? `; ${devices}` : ''}${deepVerifyClause(r.deep)}. Local backups: \`cleo backup verify\`.`;
}

/**
 * `cleo cloud verify [--scope] [--deep]`.
 *
 * @param args - Parsed args.
 */
export async function runCloudVerify(args: Args): Promise<void> {
  await runCloudRead<CloudVerifyResult>(
    'cloud.verify',
    async () =>
      (await vaultModule()).verifyNexusVault({
        ...common(args, 'cloud.verify'),
        deep: args['deep'] === true,
      }),
    cloudVerifySummary,
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
      const limit = activityLimitArg(args);
      const before = stringArg(args, 'before');
      const projectId = stringArg(args, 'project');
      const deviceId = stringArg(args, 'device');
      return nexusCloudActivity({
        ...(deviceId !== undefined ? { deviceId } : {}),
        apiUrl: nexusApiUrlArg(args),
        ...(limit !== undefined ? { limit } : {}),
        ...(before !== undefined ? { before } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
      });
    },
    (r) =>
      `${r.items.length} event(s)${r.projectId ? ` for project ${r.projectId}` : ''}: ${r.items
        .slice(0, 10)
        .map(
          (i) =>
            `${i.at} ${who(i.deviceName, i.deviceId ?? 'account')}${i.thisDevice ? ' (this machine)' : ''} ${terminalSafe(i.action)}${i.target ? ` ${terminalSafe(i.target)}` : ''}`,
        )
        .join('; ')}${r.items.length > 10 ? '; …' : ''}`,
  );
}

/**
 * `cleo cloud conflicts [list|resolve <id>] [--all] [--stream] [--scope]`:
 * the sync conflicts this store's apply recorded (T12344 PR-6). Local only.
 *
 * @param args - Parsed args.
 */
export async function runCloudConflicts(args: Args): Promise<void> {
  const action = stringArg(args, 'action') ?? 'list';
  const conflicts = () =>
    import(/* webpackIgnore: true */ '@cleocode/core/cloud/nexus-cloud-conflicts.js');
  if (action === 'resolve') {
    const raw = stringArg(args, 'id');
    const id = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(id)) {
      failNexus(
        Object.assign(new Error('resolve needs a conflict id'), {
          code: 'E_VALIDATION',
          fix: 'use `cleo cloud conflicts resolve <id>` (ids from `cleo cloud conflicts`)',
        }),
        'cloud.conflicts.resolve',
      );
    }
    await runCloudRead<CloudConflictResolveResult>(
      'cloud.conflicts.resolve',
      async () =>
        (await conflicts()).resolveNexusCloudConflict({
          id,
          scope: scopeArg(args, 'cloud.conflicts.resolve'),
        }),
      (r) => (r.resolved ? `Conflict ${r.id} resolved.` : `No open conflict ${r.id}.`),
    );
    return;
  }
  if (action !== 'list') {
    failNexus(
      Object.assign(new Error(`unknown action '${action}'`), {
        code: 'E_VALIDATION',
        fix: 'use `cleo cloud conflicts` (list) or `cleo cloud conflicts resolve <id>`',
      }),
      'cloud.conflicts',
    );
  }
  const stream = stringArg(args, 'stream');
  await runCloudRead<CloudConflictsResult>(
    'cloud.conflicts',
    async () =>
      (await conflicts()).nexusCloudConflicts({
        scope: scopeArg(args, 'cloud.conflicts'),
        all: args.all === true,
        ...(stream !== undefined ? { stream } : {}),
      }),
    (r) =>
      r.conflicts.length === 0
        ? `No ${args.all === true ? '' : 'open '}sync conflicts (${r.total} recorded).`
        : [
            `${r.open} open of ${r.total} sync conflict(s):`,
            ...r.conflicts.map(
              (c) =>
                `  #${c.id} ${c.kind} ${c.table}/${c.uid}${c.columns.length ? ` [${c.columns.join(', ')}]` : ''}${c.rule ? ` ${c.rule}` : ''}: ${c.resolution}${c.resolvedAt ? ' (resolved)' : ''}`,
            ),
          ].join('\n'),
  );
}
