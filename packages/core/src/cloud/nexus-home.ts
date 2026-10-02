/**
 * This device's global CLEO store (the main brain) on Cleo Nexus: bind its
 * global-scope replica and attach it to the account's `home:` stream with
 * presence (T12952, cleo-nexus T084). `cleo login nexus` runs it after a
 * device login, so login stays the only setup step; `cleo cloud status`
 * reads the attachments back.
 *
 * A server that does not have the home-replica endpoints yet answers 404:
 * that is reported as a warning, never a failure.
 *
 * @task T12952
 * @epic T12323
 */

import type { NexusReplicaAttachment } from '@cleocode/contracts';
import { z } from 'zod';
import { NexusError } from './http.js';
import { attachHomeReplica, type ProjectReplicaBinder } from './nexus-attach.js';
import { resolveNexusApiUrl } from './nexus-auth.js';
import { connectNexusCloud, type NexusCloudOptions } from './nexus-cloud.js';
import { isNexusDeviceEnabled } from './nexus-device.js';
import { ensureNexusDeviceCredential } from './nexus-enrol.js';

/** Warning code: the server has no home-replica endpoints yet. */
export const W_NEXUS_HOME_UNSUPPORTED = 'W_NEXUS_HOME_UNSUPPORTED';

/** Options of {@link attachNexusGlobalStore}. */
export interface AttachNexusGlobalStoreOptions extends NexusCloudOptions {
  /** CLEO version reported in presence; defaults to the installed one. */
  cliVersion?: string;
  /** Replica binding (tests); defaults to the canonical global store. */
  binder?: ProjectReplicaBinder;
}

/**
 * Attach this device's global store to the account's home stream.
 *
 * @param opts - API URL, stores and overrides.
 * @returns The attachment (or `null` when the server does not support it) and warnings.
 * @throws {NexusAccountError} Not signed in, or `E_NEXUS_REPLICA_COPIED`.
 */
export async function attachNexusGlobalStore(
  opts: AttachNexusGlobalStoreOptions = {},
): Promise<{ replica: NexusReplicaAttachment | null; warnings: string[] }> {
  if (!isNexusDeviceEnabled()) return { replica: null, warnings: [] };
  const apiUrl = resolveNexusApiUrl(opts.apiUrl);
  const handle = await ensureNexusDeviceCredential({ ...opts, apiUrl });
  const bearer = handle.device.currentBearer();
  if (bearer === null) return { replica: null, warnings: [...handle.warnings] };
  let cliVersion = opts.cliVersion;
  if (cliVersion === undefined) {
    const { getCleoVersion } = await import('../scaffold/ensure-config.js');
    cliVersion = getCleoVersion();
  }
  try {
    const r = await attachHomeReplica({
      apiUrl,
      bearer,
      deviceId: handle.device.deviceId,
      cliVersion,
      ...(opts.binder ? { binder: opts.binder } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    return { replica: r.replica, warnings: [...handle.warnings, ...r.warnings] };
  } catch (err) {
    if (err instanceof NexusError && err.status === 404) {
      return {
        replica: null,
        warnings: [
          ...handle.warnings,
          `${W_NEXUS_HOME_UNSUPPORTED}: this Cleo Nexus server does not attach global stores yet`,
        ],
      };
    }
    throw err;
  }
}

/** One home-stream replica as `GET /v1/account/home/replicas` lists it. */
export const nexusHomeReplicaSchema = z.looseObject({
  replicaId: z.string(),
  deviceId: z.string(),
  deviceState: z.string().optional(),
  presenceAt: z.string().nullable().optional(),
  lastSyncAt: z.string().nullable().optional(),
  attachedAt: z.string().optional(),
});

/** `GET /v1/account/home/replicas`. */
export const nexusHomeReplicaListSchema = z.looseObject({
  replicas: z.array(nexusHomeReplicaSchema),
});

/** The account's global-store attachments, as `cleo cloud status` reports them. */
export interface NexusGlobalStoreStatus {
  /** Whether the server lists home replicas at all. */
  supported: boolean;
  /** This device's attachment, if any. */
  thisDevice: z.infer<typeof nexusHomeReplicaSchema> | null;
  /** Every device's global store attached to the account. */
  replicas: Array<z.infer<typeof nexusHomeReplicaSchema>>;
}

/**
 * Read the account's global-store attachments (GET only).
 *
 * @param opts - API URL, stores and overrides.
 * @returns The attachments; `supported: false` when the server has no such endpoint.
 */
export async function nexusGlobalStoreStatus(
  opts: NexusCloudOptions = {},
): Promise<NexusGlobalStoreStatus> {
  const conn = await connectNexusCloud(opts);
  const list = await conn.find('/v1/account/home/replicas', nexusHomeReplicaListSchema);
  if (list === null) return { supported: false, thisDevice: null, replicas: [] };
  return {
    supported: true,
    thisDevice: list.replicas.find((r) => r.deviceId === conn.device.deviceId) ?? null,
    replicas: list.replicas,
  };
}
