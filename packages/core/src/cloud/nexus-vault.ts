/**
 * The cloud vault: encrypted snapshots of a project's (or this account's
 * global) CLEO store on Cleo Nexus, with lineage, a single-writer lease and
 * verified restore (T12336 protocol, T12337 CLI, T12338 lease handoff).
 *
 * A snapshot is a checkpoint on the store's journal stream (`project:<id>`,
 * or the account's `home:<userId>`):
 *
 * - **Bundle**: the store's portable bundle (`exportPortableBundle`, no
 *   secrets; for the global store without machine-local state or the config
 *   home), sealed with the stream data key and uploaded as a blob. The data
 *   key derives from the account master key, which is escrowed on Cleo Nexus
 *   (released only to your approved devices; see `nexus-vault-keys.ts` for the
 *   threat model), so this is encrypted at rest, not zero-knowledge.
 * - **Manifest** (plaintext): per-table row counts and keyed hashes of the
 *   store's syncing tables (`buildVaultManifest`). The server checks counts
 *   reconcile with the journal; only key holders can check hashes.
 * - **Lineage**: each snapshot names its parent; the server refuses one that
 *   does not descend from the stream head (E_LINEAGE). The client refuses
 *   earlier, with `E_NEXUS_VAULT_BEHIND`, when the head is not the snapshot
 *   this store last pushed or restored: another device wrote since.
 * - **Counts**: a non-genesis snapshot's counts must equal the parent's plus
 *   the per-table deltas of the journal segments between them. A push whose
 *   counts changed appends one signed "vault delta" segment carrying exactly
 *   the difference (the journal sync of Stage C will carry real ops).
 * - **Lease**: a push takes the stream's `writer` lease. Another device's
 *   live lease refuses the push (`E_NEXUS_VAULT_LEASE_HELD`); `--force`
 *   takes it, and the server labels the take as a fork from the holder.
 * - **Fork label**: a `--force` push over a head this store had not synced,
 *   or over another device's lease, carries `zz_vault_fork` (0 rows) in its
 *   signed manifest, so every device's verify still sees the fork after the
 *   lease is released (T13007).
 *
 * Restore downloads, verifies the author's signature, decrypts, and checks
 * every table's count and hash against the manifest before anything is
 * placed; this machine's `local-only` rows are carried into the snapshot so
 * machine state (replica binding, registry paths) is never overwritten, and
 * what the snapshot no longer lists is removed afterwards (T13004).
 *
 * Nothing here blocks normal commands: the vault runs only when asked.
 *
 * @task T12336
 * @task T12337
 * @task T12338
 * @epic T12322
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  CloudLeaseReleaseResult,
  CloudPushResult,
  CloudRestoreResult,
  CloudVaultLease,
  CloudVaultScope,
  CloudVaultSnapshot,
  CloudVaultStatusResult,
  CloudVaultTableDiff,
  CloudVerifyResult,
  CloudWarning,
  PortableBundleManifest,
} from '@cleocode/contracts';
import {
  NEXUS_VAULT_LEASE_ROLE,
  nexusCloudDevicePageSchema,
  nexusLeaseAcquireSchema,
  nexusStreamHeadSchema,
} from '@cleocode/contracts';
import {
  type Checkpoint,
  ListCheckpointsResult,
  ListLeasesResult,
} from '@cleocode/contracts/cloud';
import { readDeclaredProjectIdentity } from '@cleocode/paths';
import { extract as tarExtract } from 'tar';
import { z } from 'zod';
import { getCleoHome, resolveOrCwd } from '../paths.js';
import { withLock } from '../store/lock.js';
import { exportPortableBundle, globalHomeRules } from '../store/portable-bundle.js';
import { importPortableBundle } from '../store/portable-bundle-import.js';
import {
  integrityCheck,
  PROJECT_SECTION_RULES,
  type SectionScan,
  scanSection,
} from '../store/portable-bundle-scan.js';
import { FIRST_OPEN_LOCK_SUFFIX } from '../store/sqlite.js';
import { readActiveReplicaId } from '../store/sync/replica.js';
import {
  buildVaultManifest,
  type CarriedMachineState,
  carryMachineState,
  compareVaultManifests,
  emptyVaultTableHash,
  isVaultForkManifest,
  sameVaultManifest,
  VAULT_FILES_KEY,
  VAULT_FORK_KEY,
  VAULT_MANIFEST_SCHEMA_VERSION,
  type VaultManifest,
  vaultDatabaseEntry,
  vaultDatabaseKey,
  vaultFileDigest,
  vaultFilesEntry,
  vaultForkEntry,
  vaultStripColumns,
} from '../store/vault-manifest.js';
import { foreignWriterLeases, storeOpenElsewhere } from '../store/writer-lease.js';
import { deriveKey } from './crypto.js';
import { NexusError } from './http.js';
import { cursorFromCheckpoint, initialPullCursor, Journal, type PullCursor } from './journal.js';
import type { TrustedSigners } from './keys.js';
import { canonicalGlobalReplicaBinder } from './nexus-attach.js';
import { NexusAccountError } from './nexus-auth.js';
import { nexusApiErrorToAccountError } from './nexus-enrol.js';
import { readNexusProjectLink } from './nexus-link.js';
import {
  connectNexusVault,
  type NexusVaultConnection,
  type NexusVaultOptions,
  nexusHomeDataKey,
  nexusProjectDataKey,
  unlockNexusAccountKey,
} from './nexus-vault-keys.js';
import type { VaultStreamState } from './nexus-vault-state.js';
import { homeStream, projectStream } from './streams.js';

/** Default lease length of a push: long enough for a large upload, short enough to hand off. */
export const NEXUS_VAULT_LEASE_TTL_SECONDS = 900;

/**
 * Global-home paths a vault snapshot never carries (T12968): this machine's
 * identity and runtime state. A global pull must leave them as they are, so
 * the bundle does not hold them at all. The config home is left out too.
 */
export const VAULT_GLOBAL_EXCLUSIONS = {
  dirs: {
    state:
      'machine-local state (on macOS the replica registries live here); never in a vault snapshot',
    keys: 'machine-local keys (evidence cache key); never in a vault snapshot',
    'rate-limit-state': 'machine-local rate-limit counters; never in a vault snapshot',
  },
  files: {
    'device-id': "this machine's stable device id; never in a vault snapshot",
    'web-server.json': 'machine-local web server runtime state; never in a vault snapshot',
    'sentient-state.json': 'machine-local daemon state; never in a vault snapshot',
    'device-heartbeat.stamp': 'machine-local heartbeat; never in a vault snapshot',
    'nexus.db': 'machine-local code index (rebuilt per machine); never in a vault snapshot',
    'exodus-complete': 'machine-local migration marker; never in a vault snapshot',
    'telemetry-config.json':
      "this install's telemetry opt-in and anonymous id; never in a vault snapshot",
    'decide/spend.json':
      "this machine's decision spend ledger (in-flight reservations); never in a vault snapshot",
    'decide/budget.json': "this machine's decision request token bucket; never in a vault snapshot",
  },
} as const;

/**
 * Plain files of a snapshot that belong to the machine, not to the store
 * (T13005), so they are outside its hashed file inventory and a restore never
 * overwrites them:
 *
 * - `skip`: never placed from a snapshot (`worktrees.json` names this
 *   machine's worktrees).
 * - `keep`: this machine's copy stays; the snapshot's is placed only where
 *   this machine has none: the replica link (`nexus-link.json`), files CLEO
 *   regenerates on its own (`memory-bridge.md`, timestamped) and per-session
 *   scratch (top-level dotfiles, `tmp/`, `state/`), which would otherwise read
 *   as a change on every run.
 *
 * Everything else, `config.json` and `project-context.json` included, is in
 * the inventory: hashed (relocation-aware, {@link vaultFileDigest}) and placed.
 */
function machineLocalFile(relPath: string): 'keep' | 'skip' | null {
  if (relPath === 'worktrees.json') return 'skip';
  return relPath === 'nexus-link.json' ||
    relPath === 'memory-bridge.md' ||
    (!relPath.includes('/') && relPath.startsWith('.')) ||
    relPath.startsWith('tmp/') ||
    relPath.startsWith('state/')
    ? 'keep'
    : null;
}

/** A plain file outside the vault's hashed inventory ({@link machineLocalFile}). */
const inventoryExcluded = (relPath: string): boolean => machineLocalFile(relPath) !== null;

/** Options shared by the vault commands. */
export interface NexusVaultCommandOptions extends NexusVaultOptions {
  /** `project` (the current project, default) or `global` (this account's global store). */
  scope?: CloudVaultScope;
}

/** The store a vault command acts on. */
interface VaultTarget {
  scope: CloudVaultScope;
  streamId: string;
  /** Project root, or the CLEO home for global. */
  storeRoot: string;
  /** The store's `cleo.db`. */
  dbPath: string;
  /** Server project id (project scope). */
  projectId: string | null;
  /** This machine's replica on the stream (project: the attached one; global: minted once). */
  replicaId: string | null;
  /** Stream data key. */
  dataKey: Buffer;
}

const tableScopeOf = (t: VaultTarget) => (t.scope === 'global' ? 'global' : 'project');
const hashKeyOf = (dataKey: Buffer) => deriveKey(dataKey, 'vault-manifest');
const streamPath = (streamId: string) => `/v1/streams/${encodeURIComponent(streamId)}`;

function vaultError(
  code: ConstructorParameters<typeof NexusAccountError>[0],
  message: string,
  fix?: string,
): NexusAccountError {
  return new NexusAccountError(code, message, fix);
}

/**
 * The store a command acts on. `push` binds the global replica and may mint
 * the project key; `read` only reads (a read-only replica lookup, no key
 * minting), so status, verify, restore and lease release never write (T12974).
 */
async function resolveTarget(
  conn: NexusVaultConnection,
  mk: Buffer,
  opts: NexusVaultCommandOptions,
  mode: 'push' | 'read',
): Promise<VaultTarget> {
  if (opts.scope === 'global') {
    const cleoHome = getCleoHome();
    const dbPath = path.join(cleoHome, 'cleo.db');
    let replicaId: string | null;
    if (mode === 'push') {
      replicaId = (await canonicalGlobalReplicaBinder().ensure()).replicaId;
      // The binder's handle must not stay open past the bind (a later restore replaces the file).
      const { _resetDualScopeDbCache } = await import('../store/dual-scope-db.js');
      _resetDualScopeDbCache('global');
    } else {
      replicaId = await readActiveReplicaId(dbPath, 'global');
    }
    return {
      scope: 'global',
      streamId: homeStream(conn.userId),
      storeRoot: cleoHome,
      dbPath,
      projectId: null,
      replicaId,
      dataKey: nexusHomeDataKey(mk),
    };
  }
  const root = path.resolve(resolveOrCwd(opts.projectRoot));
  if (!readDeclaredProjectIdentity(root)) {
    throw vaultError(
      'E_NEXUS_NOT_A_PROJECT',
      `${root} is not a CLEO project`,
      'run it inside a CLEO project, or pass --scope global',
    );
  }
  const link = readNexusProjectLink(root, conn.apiUrl);
  if (!link) {
    throw vaultError(
      'E_NEXUS_VAULT_NOT_LINKED',
      `this project is not linked to Cleo Nexus at ${conn.apiUrl}`,
      'run `cleo project link`',
    );
  }
  const dataKey = await nexusProjectDataKey(conn, mk, link.remoteProjectId, mode === 'push');
  if (dataKey === null) {
    throw vaultError(
      'E_NEXUS_VAULT_EMPTY',
      'the cloud holds no snapshot of this project yet',
      'run `cleo cloud push` on a device that has it',
    );
  }
  return {
    scope: 'project',
    streamId: link.streamId || projectStream(link.remoteProjectId),
    storeRoot: root,
    dbPath: path.join(root, '.cleo', 'cleo.db'),
    projectId: link.remoteProjectId,
    replicaId: link.replicaId && link.nexusDeviceId === conn.deviceId ? link.replicaId : null,
    dataKey,
  };
}

function journalFor(conn: NexusVaultConnection, t: VaultTarget): Journal {
  return new Journal({
    http: conn.http,
    streamId: t.streamId,
    replicaId: t.replicaId ?? '00000000-0000-7000-8000-000000000000',
    deviceId: conn.deviceId,
    signing: conn.keys.signing,
    key: t.dataKey,
    fetch: conn.blobFetch,
  });
}

async function deviceNames(conn: NexusVaultConnection): Promise<Map<string, string>> {
  try {
    const page = await conn.call('GET', '/v1/devices?limit=100', nexusCloudDevicePageSchema);
    return new Map(page.devices.map((d) => [d.deviceId, d.name]));
  } catch {
    return new Map();
  }
}

function snapshotOf(cp: Checkpoint, names: Map<string, string>): CloudVaultSnapshot {
  return {
    checkpointId: cp.checkpointId,
    parentCheckpointId: cp.parentCheckpointId,
    deviceId: cp.deviceId,
    deviceName: names.get(cp.deviceId) ?? null,
    replicaId: cp.replicaId,
    coversSeq: cp.coversSeq,
    createdAt: (cp as Checkpoint & { createdAt?: string }).createdAt ?? null,
    sizeBytes: cp.sizeBytes,
    rows: Object.values(cp.manifest.tables).reduce((n, t) => n + t.rows, 0),
    endorsedBy: cp.endorsements.map((e) => e.deviceId),
  };
}

async function listCheckpoints(
  conn: NexusVaultConnection,
  streamId: string,
): Promise<Checkpoint[]> {
  const res = await conn.find(`${streamPath(streamId)}/checkpoints`, ListCheckpointsResult);
  return res?.checkpoints ?? [];
}

async function streamHead(conn: NexusVaultConnection, streamId: string) {
  return (
    (await conn.find(streamPath(streamId), nexusStreamHeadSchema)) ?? {
      streamId,
      headSeq: 0,
      headCheckpointId: null,
    }
  );
}

async function leasesOf(
  conn: NexusVaultConnection,
  t: VaultTarget,
  names: Map<string, string>,
  warnings: CloudWarning[],
): Promise<CloudVaultLease[]> {
  try {
    const res = await conn.raw('GET', `${streamPath(t.streamId)}/leases`, ListLeasesResult);
    return res.leases.map((l) => ({
      role: l.role,
      replicaId: l.replicaId,
      deviceId: l.deviceId ?? null,
      deviceName: l.deviceId ? (names.get(l.deviceId) ?? null) : null,
      expiresAt: l.expiresAt,
      forkedFromReplicaId: l.forkedFromReplicaId ?? null,
      acquiredAt: l.acquiredAt ?? null,
      mine: l.replicaId === t.replicaId,
    }));
  } catch (err) {
    if (err instanceof NexusError && err.status === 404) {
      warnings.push({
        code: 'W_NEXUS_LEASES_UNAVAILABLE',
        message: 'this Cleo Nexus server does not list leases yet',
      });
      return [];
    }
    throw err;
  }
}

/** Take (or renew) the stream's writer lease; `force` takes it from a live holder (a labelled fork). */
async function acquireLease(
  conn: NexusVaultConnection,
  t: VaultTarget,
  force: boolean,
  reason: string,
): Promise<{ lease: CloudVaultLease; forked: boolean }> {
  if (!t.replicaId) throw new Error('acquireLease: no replica');
  try {
    const res = await conn.raw(
      'POST',
      `${streamPath(t.streamId)}/leases`,
      nexusLeaseAcquireSchema,
      {
        role: NEXUS_VAULT_LEASE_ROLE,
        replicaId: t.replicaId,
        ttlSeconds: NEXUS_VAULT_LEASE_TTL_SECONDS,
        force,
        reason,
      },
    );
    const l = res.lease;
    return {
      lease: {
        role: l.role,
        replicaId: l.replicaId,
        deviceId: conn.deviceId,
        deviceName: null,
        expiresAt: l.expiresAt,
        forkedFromReplicaId: l.forkedFromReplicaId ?? null,
        mine: true,
      },
      forked: force && (l.forkedFromReplicaId ?? null) !== null,
    };
  } catch (err) {
    if (err instanceof NexusError && err.code === 'E_LEASE_HELD') {
      const holder = String(err.details?.['replicaId'] ?? 'another replica');
      const until = String(err.details?.['expiresAt'] ?? 'its expiry');
      throw vaultError(
        'E_NEXUS_VAULT_LEASE_HELD',
        `another device holds the write lease on ${t.streamId} (replica ${holder}, until ${until})`,
        'wait for it to push and release (`cleo cloud lease release` on that machine), then `cleo cloud pull`; or `--force` to take it, which labels this snapshot as a fork',
      );
    }
    throw err;
  }
}

/** Hand the writer lease back, ignoring failures (a failed push must not keep it). */
async function releaseLeaseQuietly(conn: NexusVaultConnection, t: VaultTarget): Promise<void> {
  if (!t.replicaId) return;
  try {
    await conn.raw(
      'DELETE',
      `${streamPath(t.streamId)}/leases/${NEXUS_VAULT_LEASE_ROLE}?replicaId=${encodeURIComponent(t.replicaId)}`,
      z.looseObject({}),
    );
  } catch {
    // It expires on its own.
  }
}

/** Every segment after `cursor`, replayed through the journal (signatures and gaps checked). */
async function replaySegments(
  journal: Journal,
  cursor: PullCursor,
  signers: TrustedSigners,
): Promise<{
  cursor: PullCursor;
  deltas: Array<Record<string, { created: number; deleted: number }>>;
}> {
  const deltas: Array<Record<string, { created: number; deleted: number }>> = [];
  let c = cursor;
  for (;;) {
    const page = await journal.pull(c, signers, 200);
    for (const s of page.segments) deltas.push(s.meta.deltas);
    c = page.cursor;
    if (page.segments.length === 0 || c.after >= page.head) return { cursor: c, deltas };
  }
}

/**
 * The checkpoints whose author signature (or a live device's endorsement)
 * verifies against the trusted signers. Each one that does not is reported
 * when `warnings` is given and left out (T13007), so no verdict, comparison
 * or refusal is decided from a manifest the server could have forged.
 */
function trustedCheckpoints(
  journal: Journal,
  cps: readonly Checkpoint[],
  signers: TrustedSigners,
  warnings: CloudWarning[] | null,
): Checkpoint[] {
  return cps.filter((cp) => {
    try {
      journal.verifyCheckpoint(cp, signers);
      return true;
    } catch (err) {
      warnings?.push({
        code: 'W_NEXUS_VAULT_UNTRUSTED_SNAPSHOT',
        message: `snapshot ${cp.checkpointId}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return false;
    }
  });
}

/**
 * What this store last synced with on the stream. A push whose state write
 * was lost (a crash between the checkpoint and the state file, T13007) left
 * its in-flight mark and the head as this device and replica's own snapshot
 * over the marked parent: that head is what this store holds, so it counts
 * as synced (`adopted`; push and pull record it). Without the mark (a store
 * restored to an older snapshot of its own) nothing is adopted.
 */
function syncedState(
  conn: NexusVaultConnection,
  t: VaultTarget,
  trusted: readonly Checkpoint[],
  headCheckpointId: string | null,
): { state: VaultStreamState | null; adopted: Checkpoint | null } {
  const recorded = conn.state.stream(conn.apiUrl, conn.userId, t.streamId, t.storeRoot);
  const head = trusted.find((c) => c.checkpointId === headCheckpointId);
  if (
    head !== undefined &&
    t.replicaId !== null &&
    head.deviceId === conn.deviceId &&
    head.replicaId === t.replicaId &&
    recorded?.pushInFlight !== undefined &&
    head.checkpointId !== recorded.lastCheckpointId &&
    head.parentCheckpointId === recorded.pushInFlight.parentCheckpointId
  ) {
    return {
      state: {
        lastCheckpointId: head.checkpointId,
        lastCoversSeq: head.coversSeq,
        updatedAt: head.createdAt,
      },
      adopted: head,
    };
  }
  return { state: recorded, adopted: null };
}

/** Record that this store holds `cp` on the stream. */
function saveSynced(
  conn: NexusVaultConnection,
  t: VaultTarget,
  cp: Checkpoint,
  streamId = t.streamId,
): void {
  conn.state.saveStream(conn.apiUrl, conn.userId, streamId, t.storeRoot, {
    lastCheckpointId: cp.checkpointId,
    lastCoversSeq: cp.coversSeq,
  });
}

/**
 * Export the store the way the vault snapshots it: no secrets, no `strip`
 * columns (T13007), and for the global store without machine-local state or
 * the config home (T12968).
 */
async function exportVaultBundle(t: VaultTarget, outputPath: string, label: string): Promise<void> {
  await exportPortableBundle({
    scope: t.scope === 'global' ? 'global' : 'project',
    ...(t.scope === 'project' ? { projectRoot: t.storeRoot } : {}),
    ...(t.scope === 'global'
      ? { globalHomeExclusions: VAULT_GLOBAL_EXCLUSIONS, includeConfigHome: false }
      : {}),
    stripColumns: vaultStripColumns(tableScopeOf(t)),
    outputPath,
    label,
  });
}

/**
 * The vault manifest of an extracted bundle: the syncing tables of its
 * `cleo.db`, one entry per other database of the section, and one entry for
 * its plain-file inventory (T12969), so a change anywhere in the bundle is seen.
 */
async function snapshotManifest(
  extractDir: string,
  manifest: PortableBundleManifest,
  t: VaultTarget,
): Promise<{ vault: VaultManifest; dbPath: string }> {
  const section = t.scope === 'global' ? manifest.global?.home : manifest.projects[0];
  const entry = section?.databases.find((d) => d.role === 'primary' && d.relPath === 'cleo.db');
  if (!section || !entry) {
    throw vaultError('E_NEXUS_VAULT_VERIFY_FAILED', 'the snapshot holds no primary cleo.db');
  }
  // A restore relocates a project's primary store from its original path; a
  // global store, and every other database, is placed as is.
  const root =
    t.scope === 'global' ? null : (manifest.projects[0]?.originalPath ?? section.originalRoot);
  const hashKey = hashKeyOf(t.dataKey);
  const dbPath = path.join(extractDir, entry.bundlePath);
  const vault = buildVaultManifest(dbPath, { scope: tableScopeOf(t), hashKey, root }).manifest;
  for (const d of section.databases) {
    if (d === entry) continue;
    vault.tables[vaultDatabaseKey(d.relPath)] = vaultDatabaseEntry(
      path.join(extractDir, d.bundlePath),
      { hashKey, root: null },
    );
  }
  const files: Array<{ relPath: string; sha256: string }> = [];
  for (const f of section.files) {
    if (f.secret || inventoryExcluded(f.relPath)) continue;
    files.push({
      relPath: f.relPath,
      sha256: await vaultFileDigest(path.join(extractDir, f.bundlePath), f.relPath, root, f.sha256),
    });
  }
  vault.tables[VAULT_FILES_KEY] = vaultFilesEntry(files, hashKey);
  return { vault, dbPath };
}

/** Export and extract the store into `work`, returning its bundle and vault manifest. */
async function exportAndRead(
  t: VaultTarget,
  work: string,
  label: string,
): Promise<{ bundlePath: string; vault: VaultManifest }> {
  const bundlePath = path.join(work, 'snapshot.cleobundle.tar.gz');
  await exportVaultBundle(t, bundlePath, label);
  const extractDir = path.join(work, 'x');
  fs.mkdirSync(extractDir);
  await tarExtract({ file: bundlePath, cwd: extractDir });
  const bundleManifest = JSON.parse(
    fs.readFileSync(path.join(extractDir, 'manifest.json'), 'utf8'),
  ) as PortableBundleManifest;
  const { vault } = await snapshotManifest(extractDir, bundleManifest, t);
  return { bundlePath, vault };
}

/**
 * The vault manifest of this machine's store as a push would snapshot it, or
 * `null` when it has none, computed from the live databases (one read
 * transaction each) and a walk with the export's own rules: no export, no
 * VACUUM, so `cloud vault`, `verify` and the pull checks stay cheap (#1773 P0).
 * The values match {@link snapshotManifest} of a fresh export: credential
 * columns hash as NULL in every database, as the export clears them.
 */
async function localManifest(t: VaultTarget): Promise<VaultManifest | null> {
  if (!fs.existsSync(t.dbPath)) return null;
  const { sectionRoot, scan, primaryRel } = sectionScan(t);
  const hashKey = hashKeyOf(t.dataKey);
  const root = t.scope === 'global' ? null : t.storeRoot;
  const vault = buildVaultManifest(t.dbPath, { scope: tableScopeOf(t), hashKey, root }).manifest;
  for (const rel of scan.sqlite) {
    if (rel === primaryRel) continue;
    try {
      vault.tables[vaultDatabaseKey(rel)] = vaultDatabaseEntry(path.join(sectionRoot, rel), {
        hashKey,
        root: null,
      });
    } catch {
      // Unreadable: the export leaves it out of an unencrypted bundle too.
    }
  }
  const files: Array<{ relPath: string; sha256: string }> = [];
  for (const rel of scan.files) {
    if (inventoryExcluded(rel)) continue;
    files.push({
      relPath: rel,
      sha256: await vaultFileDigest(path.join(sectionRoot, rel), rel, root),
    });
  }
  vault.tables[VAULT_FILES_KEY] = vaultFilesEntry(files, hashKey);
  return vault;
}

/**
 * This store's section as a vault snapshot walks it: the section root, the
 * export's walk rules (so secrets, excluded directories and machine-local
 * global state are never in it) and the primary store's path in it.
 */
function sectionScan(t: VaultTarget): {
  sectionRoot: string;
  scan: SectionScan;
  primaryRel: string;
} {
  const sectionRoot = t.scope === 'global' ? t.storeRoot : path.join(t.storeRoot, '.cleo');
  const rules =
    t.scope === 'global' ? globalHomeRules(VAULT_GLOBAL_EXCLUSIONS) : PROJECT_SECTION_RULES;
  return {
    sectionRoot,
    scan: scanSection(sectionRoot, rules),
    primaryRel: path.relative(sectionRoot, t.dbPath).split(path.sep).join('/'),
  };
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** `cleo cloud push`. */
async function pushNexusVaultImpl(
  opts: NexusVaultCommandOptions & { force?: boolean; hold?: boolean } = {},
): Promise<CloudPushResult> {
  const conn = await connectNexusVault(opts);
  const key = await unlockNexusAccountKey(conn);
  const t = await resolveTarget(conn, key.masterKey, opts, 'push');
  const scope: CloudVaultScope = t.scope;
  const warnings: CloudWarning[] = [...conn.warnings];
  const replicaId = t.replicaId;
  if (!replicaId) {
    throw vaultError(
      'E_NEXUS_VAULT_NOT_LINKED',
      'this copy of the project is not attached from this device',
      'run `cleo project link`',
    );
  }
  const force = opts.force === true;
  const journal = journalFor(conn, t);
  const head = await streamHead(conn, t.streamId);
  const checkpoints = head.headCheckpointId ? await listCheckpoints(conn, t.streamId) : [];
  const parent = checkpoints.find((c) => c.checkpointId === head.headCheckpointId) ?? null;
  if (head.headCheckpointId && !parent) {
    throw vaultError(
      'E_NEXUS_VAULT_REFUSED',
      `the head snapshot ${head.headCheckpointId} is not in the stream's list`,
    );
  }
  if (parent) journal.verifyCheckpoint(parent, key.signers);
  const { state: synced, adopted } = syncedState(
    conn,
    t,
    parent ? [parent] : [],
    head.headCheckpointId,
  );
  if (adopted) saveSynced(conn, t, adopted);
  // Another device pushed since this store last synced: only `--force` pushes
  // over it, and that snapshot is labelled a fork on the checkpoint (T13007).
  const overUnsynced =
    head.headCheckpointId !== null && head.headCheckpointId !== synced?.lastCheckpointId;
  if (overUnsynced && !force) {
    throw vaultError(
      'E_NEXUS_VAULT_BEHIND',
      `another device pushed snapshot ${head.headCheckpointId} after this machine's last sync`,
      'run `cleo cloud pull` first (it refuses to overwrite local changes), or `--force` to push this store as a labelled fork',
    );
  }

  const work = tempDir('cleo-vault-push-');
  try {
    const { bundlePath, vault } = await exportAndRead(t, work, `cloud-vault-${scope}`);
    const names = await deviceNames(conn);
    // Nothing changed since the head: no lease, no upload (T12971).
    if (parent && sameVaultManifest(vault, parent.manifest)) {
      saveSynced(conn, t, parent);
      warnings.push(...conn.state.drainWarnings());
      return {
        apiUrl: conn.apiUrl,
        scope,
        streamId: t.streamId,
        status: 'up-to-date',
        snapshot: snapshotOf(parent, names),
        parentCheckpointId: parent.parentCheckpointId,
        deltaSegmentSeq: null,
        lease: null,
        forked: false,
        warnings,
      };
    }

    // A table the parent lists must stay listed (0 rows when it is gone); the
    // parent's fork label is not a table and is not carried.
    const manifest: VaultManifest = {
      schemaVersion: VAULT_MANIFEST_SCHEMA_VERSION,
      tables: { ...vault.tables },
    };
    if (parent) {
      for (const table of Object.keys(parent.manifest.tables)) {
        if (table === VAULT_FORK_KEY) continue;
        manifest.tables[table] ??= { rows: 0, hash: buildEmptyHash(t, table) };
      }
    }

    // The lease is taken only after the cheap refusals and the up-to-date
    // check, and handed back when the push ends (kept only with `hold`).
    const acquired = await acquireLease(
      conn,
      t,
      force,
      force ? 'cleo cloud push --force' : 'cleo cloud push',
    );
    const { lease } = acquired;
    // A fork: over a head this store had not synced, or over another device's
    // live lease. Labelled on the signed checkpoint, so every device's verify
    // still sees it after the lease is handed back (T13007).
    const forked = overUnsynced || acquired.forked;
    if (forked && parent) {
      manifest.tables[VAULT_FORK_KEY] = vaultForkEntry(hashKeyOf(t.dataKey), parent.checkpointId);
    }
    try {
      // A crash before the snapshot is recorded must not leave this store behind its own push.
      conn.state.markPushInFlight(
        conn.apiUrl,
        conn.userId,
        t.streamId,
        t.storeRoot,
        parent?.checkpointId ?? null,
      );
      let deltaSegmentSeq: number | null = null;
      let cp: Checkpoint | null = null;
      // A segment another device appends between our replay and our checkpoint
      // makes the server's count or replica-map check fail: replay once more
      // (our own delta is then part of the history) and retry (T12975). The
      // retry seals the bundle under a new checkpoint id (the AAD covers it),
      // so the first attempt's uploaded blob is left unreferenced: one orphan
      // per retry, for the server's blob garbage collection.
      for (let attempt = 0; cp === null; attempt++) {
        const replay = await replaySegments(
          journal,
          parent ? cursorFromCheckpoint(parent) : initialPullCursor(),
          key.signers,
        );
        let cursor = replay.cursor;
        if (parent) {
          const between: Record<string, { created: number; deleted: number }> = {};
          for (const d of replay.deltas) {
            for (const [table, v] of Object.entries(d)) {
              const p = between[table] ?? { created: 0, deleted: 0 };
              between[table] = { created: p.created + v.created, deleted: p.deleted + v.deleted };
            }
          }
          const need: Record<string, number> = {};
          const deltas: Record<string, { created: number; deleted: number }> = {};
          for (const table of new Set([
            ...Object.keys(manifest.tables),
            ...Object.keys(parent.manifest.tables),
            ...Object.keys(between),
          ])) {
            const expected =
              (parent.manifest.tables[table]?.rows ?? 0) +
              (between[table]?.created ?? 0) -
              (between[table]?.deleted ?? 0);
            const diff = (manifest.tables[table]?.rows ?? 0) - expected;
            if (diff !== 0) {
              need[table] = diff;
              deltas[table] = { created: Math.max(0, diff), deleted: Math.max(0, -diff) };
            }
          }
          if (Object.keys(deltas).length > 0) {
            // A replica's first segment is replicaSeq 0 (the server and every puller enforce it).
            const mine = cursor.replicas[replicaId];
            const replicaSeq = mine ? mine.replicaSeq + 1 : 0;
            const hlc = `${String(Date.now()).padStart(13, '0')}-000000-${replicaId}`;
            const appended = await journal.push(
              replicaSeq,
              Buffer.from(
                JSON.stringify({
                  kind: 'cleo-vault-delta/v1',
                  base: parent.checkpointId,
                  tables: need,
                }),
                'utf8',
              ),
              {
                opCount: 1,
                hlcMin: hlc,
                hlcMax: hlc,
                deltas,
                schemaVersion: VAULT_MANIFEST_SCHEMA_VERSION,
              },
            );
            deltaSegmentSeq = appended.seq;
            cursor = {
              after: appended.seq,
              knowsAllReplicas: cursor.knowsAllReplicas,
              replicas: {
                ...cursor.replicas,
                [replicaId]: { deviceId: conn.deviceId, replicaSeq },
              },
            };
          }
        }
        try {
          cp = await journal.pushCheckpoint({
            bundle: fs.readFileSync(bundlePath),
            manifest,
            cursor,
            parentCheckpointId: parent?.checkpointId ?? null,
          });
        } catch (err) {
          if (err instanceof NexusError && err.code === 'E_LINEAGE') {
            throw vaultError(
              'E_NEXUS_VAULT_BEHIND',
              'another device pushed a snapshot while this one was uploading',
              'run `cleo cloud pull`, then push again',
            );
          }
          const countRefusal =
            err instanceof NexusError &&
            (err.code === 'E_REGRESSION' || err.code === 'E_VALIDATION');
          if (countRefusal && attempt === 0) continue;
          if (countRefusal) {
            throw vaultError(
              'E_NEXUS_VAULT_REFUSED',
              `the server refused the snapshot: ${(err as Error).message}`,
            );
          }
          throw err;
        }
      }
      saveSynced(conn, t, cp);
      if (opts.hold !== true) await releaseLeaseQuietly(conn, t);
      warnings.push(...conn.state.drainWarnings());
      return {
        apiUrl: conn.apiUrl,
        scope,
        streamId: t.streamId,
        status: 'pushed',
        snapshot: snapshotOf(cp, names),
        parentCheckpointId: cp.parentCheckpointId,
        deltaSegmentSeq,
        lease: opts.hold === true ? lease : null,
        forked,
        warnings,
      };
    } catch (err) {
      await releaseLeaseQuietly(conn, t);
      throw err;
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** The keyed hash of an empty table (a table the parent lists that this store no longer has). */
function buildEmptyHash(t: VaultTarget, table: string): string {
  return emptyVaultTableHash(hashKeyOf(t.dataKey), table);
}

/** Options of {@link restoreNexusVault}. */
export interface NexusVaultRestoreOptions extends NexusVaultCommandOptions {
  /** `pull`: bring this store to the head; `restore`: any snapshot (`checkpointId`), or a project onto a new machine. */
  mode: 'pull' | 'restore';
  /** A specific snapshot (restore only). */
  checkpointId?: string;
  /** Overwrite local changes (a safety backup is taken first). */
  force?: boolean;
  /** Restore a project this machine does not have: its server id. */
  projectId?: string;
  /** Where to place a project restored onto this machine (default: the current directory). */
  into?: string;
  /** Called after a project restore to attach this store (defaults to `linkProjectToNexus`). */
  relink?: (projectRoot: string) => Promise<string[]>;
}

/** Warnings for what {@link carryMachineState} could not keep. */
function carryWarnings(kept: CarriedMachineState): CloudWarning[] {
  const out: CloudWarning[] = [];
  if (kept.skipped.length > 0) {
    out.push({
      code: 'W_NEXUS_VAULT_LOCAL_TABLES',
      message: `machine-local values taken from the snapshot (the table is shaped differently here or has no primary key): ${kept.skipped.join(', ')}`,
    });
  }
  for (const l of kept.lost) {
    out.push({
      code: 'W_NEXUS_VAULT_CREDENTIALS_LOST',
      message: `${l.rows} row(s) of ${l.table} held credentials on this machine that the snapshot no longer has a place for: ${l.remedy}`,
    });
  }
  return out;
}

/**
 * Refuse to replace a store another process has open (T12973): a live writer
 * lease means a write is in flight, and any other open connection (an idle
 * session, the sentient daemon) would keep writing to the replaced file
 * afterwards. Every database the restore replaces is checked: the primary
 * store and the section's others (blobs manifest, attachments index, a legacy
 * `brain.db`, T13007). This process's own handles are closed first. Residual:
 * a process that opens a store between this check and the placement (a few
 * milliseconds, under the first-open lock that a store's first open also takes).
 */
async function assertStoreQuiescent(t: VaultTarget): Promise<void> {
  const { closeAllDatabases } = await import('../store/sqlite.js');
  await closeAllDatabases();
  const { _resetDualScopeDbCache } = await import('../store/dual-scope-db.js');
  _resetDualScopeDbCache();
  const held = foreignWriterLeases(t.dbPath);
  if (held.length > 0) {
    throw vaultError(
      'E_NEXUS_VAULT_STORE_BUSY',
      `another CLEO process is writing to ${t.dbPath} (${held.map((h) => `${h.lane} lane, pid ${h.holderPid}`).join('; ')}); restoring now would lose its writes`,
      'wait for it to finish (or stop it), then run the command again',
    );
  }
  const { sectionRoot, scan, primaryRel } = sectionScan(t);
  const open = [
    t.dbPath,
    ...scan.sqlite.filter((rel) => rel !== primaryRel).map((rel) => path.join(sectionRoot, rel)),
  ].filter((db) => storeOpenElsewhere(db));
  if (open.length > 0) {
    throw vaultError(
      'E_NEXUS_VAULT_STORE_BUSY',
      `another process has ${open.join(', ')} open (a CLEO session, daemon or tool); it would keep writing to the replaced store`,
      'close it (end the session, stop the daemon with `cleo daemon stop`), then run the command again',
    );
  }
}

/** Safety bundles kept per store under `backups/vault`; older ones are removed (T13007). */
export const NEXUS_VAULT_SAFETY_BUNDLES_KEPT = 10;

/** Keep the newest {@link NEXUS_VAULT_SAFETY_BUNDLES_KEPT} safety bundles in `dir`. */
function rotateSafetyBundles(dir: string): void {
  const bundles = fs
    .readdirSync(dir)
    .filter((name) => /^pre-restore-.+\.cleobundle\.tar\.gz$/.test(name))
    .sort();
  for (const name of bundles.slice(
    0,
    Math.max(0, bundles.length - NEXUS_VAULT_SAFETY_BUNDLES_KEPT),
  )) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
}

/**
 * After a verified snapshot is placed, remove what this store holds inside
 * the vault's inventory scope that the snapshot does not list (T13004), so a
 * file or database another device deleted is deleted here too: inventory
 * files, and databases other than the primary store (with their sidecars).
 * Machine-local files ({@link machineLocalFile}), secrets and excluded
 * directories are outside that scope and never touched. Runs only after the
 * safety backup, under the store's first-open lock.
 *
 * @returns The removed paths, relative to the section root.
 */
function pruneUnlisted(t: VaultTarget, listed: ReadonlySet<string>): string[] {
  const { sectionRoot, scan, primaryRel } = sectionScan(t);
  const removed: string[] = [];
  const remove = (rel: string, sidecars: boolean) => {
    const abs = path.join(sectionRoot, rel);
    fs.rmSync(abs, { force: true });
    if (sidecars) {
      for (const suffix of ['-wal', '-shm', '-journal'])
        fs.rmSync(`${abs}${suffix}`, { force: true });
    }
    // Leave no emptied directory behind (never the section root itself).
    for (
      let dir = path.dirname(abs);
      dir.startsWith(`${sectionRoot}${path.sep}`);
      dir = path.dirname(dir)
    ) {
      try {
        fs.rmdirSync(dir);
      } catch {
        break;
      }
    }
    removed.push(rel);
  };
  for (const rel of scan.files) if (!inventoryExcluded(rel) && !listed.has(rel)) remove(rel, false);
  for (const rel of scan.sqlite) if (rel !== primaryRel && !listed.has(rel)) remove(rel, true);
  return removed;
}

/** `cleo cloud pull` and `cleo cloud restore`. */
async function restoreNexusVaultImpl(opts: NexusVaultRestoreOptions): Promise<CloudRestoreResult> {
  const conn = await connectNexusVault(opts);
  // Read-only: a restore never mints, escrows or certifies (T12974).
  const key = await unlockNexusAccountKey(conn, { readOnly: true });
  const warnings: CloudWarning[] = [...conn.warnings];
  let t: VaultTarget;
  if (opts.scope !== 'global' && opts.projectId) {
    // The target of a new-machine restore is where the user stands (it is not
    // a project yet), never an enclosing project root.
    const into = path.resolve(opts.into ?? opts.projectRoot ?? process.cwd()); // CWD-OK: restore target directory, not a project root lookup
    const dataKey = await nexusProjectDataKey(conn, key.masterKey, opts.projectId, false);
    if (dataKey === null) {
      throw vaultError(
        'E_NEXUS_VAULT_EMPTY',
        `the cloud holds no snapshot of project ${opts.projectId}`,
      );
    }
    t = {
      scope: 'project',
      streamId: projectStream(opts.projectId),
      storeRoot: into,
      dbPath: path.join(into, '.cleo', 'cleo.db'),
      projectId: opts.projectId,
      replicaId: null,
      dataKey,
    };
  } else {
    t = await resolveTarget(conn, key.masterKey, opts, 'read');
  }
  const journal = journalFor(conn, t);
  const head = await streamHead(conn, t.streamId);
  const target = opts.checkpointId ?? head.headCheckpointId;
  if (!target) {
    throw vaultError(
      'E_NEXUS_VAULT_EMPTY',
      `the cloud holds no snapshot on ${t.streamId}`,
      'run `cleo cloud push` on a device that has the data',
    );
  }
  const cps = await listCheckpoints(conn, t.streamId);
  // Only a snapshot whose signature verifies says what this store holds (T13007).
  const trusted = trustedCheckpoints(journal, cps, key.signers, null);
  const { state: synced, adopted } = syncedState(conn, t, trusted, head.headCheckpointId);
  if (adopted) saveSynced(conn, t, adopted);
  const names = await deviceNames(conn);
  if (opts.mode === 'pull' && synced?.lastCheckpointId === target && opts.force !== true) {
    const cp = cps.find((c) => c.checkpointId === target) ?? null;
    warnings.push(...conn.state.drainWarnings());
    return {
      apiUrl: conn.apiUrl,
      scope: t.scope,
      streamId: t.streamId,
      status: 'up-to-date',
      snapshot: cp ? snapshotOf(cp, names) : null,
      target: t.storeRoot,
      verified: false,
      tables: 0,
      safetyBackup: null,
      warnings,
    };
  }
  // Never overwrite unsynced local work without --force: tables, other
  // databases and files alike (T12969).
  const hasLocal = fs.existsSync(t.dbPath);
  const local = hasLocal && opts.force !== true ? await localManifest(t) : null;
  if (local !== null) {
    const last = synced
      ? trusted.find((c) => c.checkpointId === synced.lastCheckpointId)
      : undefined;
    const hasRows = Object.entries(local.tables).some(
      ([name, x]) => x.rows > 0 && name !== VAULT_FILES_KEY,
    );
    if ((!last && hasRows) || (last && !sameVaultManifest(local, last.manifest))) {
      const changed = last
        ? compareVaultManifests(local, last.manifest)
            .filter((d) => !d.match)
            .map((d) => d.table)
        : [];
      throw vaultError(
        'E_NEXUS_VAULT_LOCAL_CHANGES',
        last
          ? `this store changed since its last cloud sync (${changed.slice(0, 8).join(', ')}); restoring would overwrite those changes`
          : 'this store holds data that was never synced with this cloud snapshot; restoring would replace it',
        'run `cleo cloud push` to keep them (as a fork with --force if another device pushed since), or pass --force to restore anyway (a safety backup is taken first)',
      );
    }
  }
  const restored = await journal.restoreCheckpoint(target, key.signers, {
    minCoversSeq: opts.checkpointId ? 0 : (synced?.lastCoversSeq ?? 0),
  });

  const work = tempDir('cleo-vault-restore-');
  try {
    const bundlePath = path.join(work, 'snapshot.cleobundle.tar.gz');
    fs.writeFileSync(bundlePath, restored.bundle);
    if (hasLocal) await assertStoreQuiescent(t);
    let safetyBackup: string | null = null;
    if (hasLocal) {
      const dir =
        t.scope === 'global'
          ? path.join(t.storeRoot, 'backups', 'vault')
          : path.join(t.storeRoot, '.cleo', 'backups', 'vault');
      fs.mkdirSync(dir, { recursive: true });
      safetyBackup = path.join(
        dir,
        `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.cleobundle.tar.gz`,
      );
      await exportPortableBundle({
        scope: t.scope === 'global' ? 'global' : 'project',
        ...(t.scope === 'project' ? { projectRoot: t.storeRoot } : {}),
        outputPath: safetyBackup,
        label: 'cloud-vault-pre-restore',
      });
      rotateSafetyBundles(dir);
    }
    let tables = 0;
    // Every path the snapshot lists in its section; the rest of the inventory is removed.
    const listed = new Set<string>();
    if (t.scope === 'project') fs.mkdirSync(t.storeRoot, { recursive: true });
    const place = () =>
      importPortableBundle({
        bundlePath,
        ...(t.scope === 'project' ? { target: t.storeRoot } : {}),
        force: true,
        cwd: t.storeRoot,
        confirmOwnerStore: true,
        requireLossless: false,
        // This machine keeps its own link, worktree index and scratch (T13005).
        machineLocalFile,
        onStaged: async (extractDir, manifest) => {
          // A project restored onto this machine never lands on another project (T12976).
          if (opts.projectId && opts.force !== true) {
            const present = readDeclaredProjectIdentity(t.storeRoot);
            const incoming = manifest.projects[0]?.projectId ?? null;
            if (present && incoming !== null && present.projectId !== incoming) {
              throw vaultError(
                'E_NEXUS_VAULT_TARGET_OCCUPIED',
                `${t.storeRoot} already holds project ${present.projectId}, not ${incoming}`,
                'pass --into an empty directory, or --force to replace it (a safety backup is taken first)',
              );
            }
          }
          const staged = await snapshotManifest(extractDir, manifest, t);
          const diff = compareVaultManifests(staged.vault, restored.checkpoint.manifest).filter(
            (d) => !d.match,
          );
          if (diff.length > 0) {
            throw vaultError(
              'E_NEXUS_VAULT_VERIFY_FAILED',
              `snapshot ${target} does not match its manifest (${diff.map((d) => d.table).join(', ')}); nothing was restored`,
            );
          }
          tables = Object.keys(restored.checkpoint.manifest.tables).filter(
            (k) => k !== VAULT_FORK_KEY,
          ).length;
          const section = t.scope === 'global' ? manifest.global?.home : manifest.projects[0];
          for (const e of [
            ...(section?.files ?? []),
            ...(section?.databases ?? []),
            ...(section?.symlinks ?? []),
          ]) {
            listed.add(e.relPath);
          }
          // Checked again under the lock.
          if (hasLocal) await assertStoreQuiescent(t);
          // Keep this machine's own state: local-only tables and columns,
          // credentials (T12966, T12967). A store new to this machine is
          // carried against none, so no machine state of the pusher's arrives
          // (T13007).
          warnings.push(
            ...carryWarnings(
              carryMachineState(staged.dbPath, hasLocal ? t.dbPath : null, tableScopeOf(t), {
                snapshotRoot:
                  t.scope === 'global' ? null : (manifest.projects[0]?.originalPath ?? null),
              }),
            ),
          );
        },
      });
    const placeAndPrune = async () => {
      await place();
      // Deletions propagate: what the snapshot no longer lists goes (T13004).
      if (!hasLocal) return;
      const removed = pruneUnlisted(t, listed);
      if (removed.length > 0) {
        warnings.push({
          code: 'W_NEXUS_VAULT_REMOVED',
          message: `removed ${removed.length} file(s) the snapshot no longer has (the safety backup ${safetyBackup} keeps a copy): ${removed.slice(0, 8).join(', ')}${removed.length > 8 ? ', …' : ''}`,
        });
      }
    };
    // Serialise with first-open migrations and auto-recovery of the same store.
    if (hasLocal) {
      await withLock(t.dbPath + FIRST_OPEN_LOCK_SUFFIX, placeAndPrune);
    } else {
      await placeAndPrune();
    }
    saveSynced(conn, t, restored.checkpoint);
    if (t.scope === 'project' && opts.relink) {
      for (const message of await opts.relink(t.storeRoot)) {
        warnings.push({ code: 'W_NEXUS_VAULT_RELINK', message });
      }
      // Later commands key this store by the stream its link names (T13007).
      const linked = readNexusProjectLink(t.storeRoot, conn.apiUrl);
      if (linked?.streamId && linked.streamId !== t.streamId) {
        saveSynced(conn, t, restored.checkpoint, linked.streamId);
      }
    }
    warnings.push(...conn.state.drainWarnings());
    return {
      apiUrl: conn.apiUrl,
      scope: t.scope,
      streamId: t.streamId,
      status: 'restored',
      snapshot: snapshotOf(restored.checkpoint, names),
      target: t.storeRoot,
      verified: true,
      tables,
      safetyBackup,
      warnings,
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** `cleo cloud vault`: lineage, last push per device, pending changes, leases. */
async function nexusVaultStatusImpl(
  opts: NexusVaultCommandOptions = {},
): Promise<CloudVaultStatusResult> {
  const conn = await connectNexusVault(opts);
  const key = await unlockNexusAccountKey(conn, { readOnly: true });
  const t = await resolveTarget(conn, key.masterKey, opts, 'read');
  const warnings: CloudWarning[] = [...conn.warnings];
  const names = await deviceNames(conn);
  const head = await streamHead(conn, t.streamId);
  const cps = await listCheckpoints(conn, t.streamId);
  const lineage = cps.map((c) => snapshotOf(c, names));
  const byDevice = new Map<string, CloudVaultSnapshot>();
  for (const s of lineage) if (!byDevice.has(s.deviceId)) byDevice.set(s.deviceId, s);
  const trusted = trustedCheckpoints(journalFor(conn, t), cps, key.signers, warnings);
  const { state: synced } = syncedState(conn, t, trusted, head.headCheckpointId);
  const last = synced ? trusted.find((c) => c.checkpointId === synced.lastCheckpointId) : undefined;
  const local = await localManifest(t);
  const pendingChanges: CloudVaultTableDiff[] =
    local && last ? compareVaultManifests(local, last.manifest).filter((d) => !d.match) : [];
  return {
    apiUrl: conn.apiUrl,
    scope: t.scope,
    streamId: t.streamId,
    headSeq: head.headSeq,
    head: lineage.find((s) => s.checkpointId === head.headCheckpointId) ?? null,
    lineage,
    lastPushByDevice: [...byDevice.values()].map((s) => ({
      deviceId: s.deviceId,
      deviceName: s.deviceName,
      checkpointId: s.checkpointId,
      createdAt: s.createdAt,
    })),
    pendingChanges,
    lastSynced: synced?.lastCheckpointId ?? null,
    leases: await leasesOf(conn, t, names, warnings),
    warnings: [...warnings, ...conn.state.drainWarnings()],
  };
}

/**
 * The fork labels this store has not synced past: labelled snapshots
 * ({@link VAULT_FORK_KEY}) on the lineage from the head back to the
 * snapshot this store last synced, exclusive, by another device (T13007).
 * A store that never synced sees only the head's label.
 */
function unsyncedForks(
  trusted: readonly Checkpoint[],
  headCheckpointId: string | null,
  syncedCheckpointId: string | null,
  deviceId: string,
): Checkpoint[] {
  const byId = new Map(trusted.map((c) => [c.checkpointId, c]));
  const out: Checkpoint[] = [];
  let id = headCheckpointId;
  for (let walked = 0; id !== null && id !== syncedCheckpointId && walked < byId.size; walked++) {
    const cp = byId.get(id);
    if (!cp) break;
    if (isVaultForkManifest(cp.manifest) && cp.deviceId !== deviceId) out.push(cp);
    if (syncedCheckpointId === null) break;
    id = cp.parentCheckpointId;
  }
  return out;
}

/** `cleo cloud verify`: local integrity, local vs head per table, and every device's newest snapshot vs the head. */
async function verifyNexusVaultImpl(
  opts: NexusVaultCommandOptions = {},
): Promise<CloudVerifyResult> {
  const conn = await connectNexusVault(opts);
  const key = await unlockNexusAccountKey(conn, { readOnly: true });
  const t = await resolveTarget(conn, key.masterKey, opts, 'read');
  const warnings: CloudWarning[] = [...conn.warnings];
  const names = await deviceNames(conn);
  const journal = journalFor(conn, t);
  const head = await streamHead(conn, t.streamId);
  const cps = await listCheckpoints(conn, t.streamId);
  // A snapshot whose signature does not verify is reported and decides nothing (T13007).
  const trusted = trustedCheckpoints(journal, cps, key.signers, warnings);
  const headCp = trusted.find((c) => c.checkpointId === head.headCheckpointId) ?? null;
  const headUntrusted = head.headCheckpointId !== null && headCp === null;
  const localIntegrity = fs.existsSync(t.dbPath) ? integrityCheck(t.dbPath) === 'ok' : false;
  const local = (await localManifest(t)) ?? {
    schemaVersion: VAULT_MANIFEST_SCHEMA_VERSION,
    tables: {},
  };
  const { state: synced } = syncedState(conn, t, trusted, head.headCheckpointId);
  const last = synced ? trusted.find((c) => c.checkpointId === synced.lastCheckpointId) : undefined;
  const tables = headCp ? compareVaultManifests(local, headCp.manifest) : [];
  let verdict: CloudVerifyResult['verdict'];
  if (headUntrusted) verdict = 'untrusted';
  else if (!headCp) verdict = 'empty';
  else if (tables.every((x) => x.match)) verdict = 'match';
  else {
    const localChanged = last ? !sameVaultManifest(local, last.manifest) : true;
    const cloudAdvanced = synced?.lastCheckpointId !== headCp.checkpointId;
    verdict = localChanged && cloudAdvanced ? 'diverged' : cloudAdvanced ? 'behind' : 'ahead';
  }
  const newest = new Map<string, Checkpoint>();
  for (const cp of trusted) if (!newest.has(cp.deviceId)) newest.set(cp.deviceId, cp);
  // Only a fork this machine has not synced past is news to it (T12976). The
  // label is on the checkpoint, so it outlives the lease (T13007); a forced
  // lease whose push has not landed yet is reported from the lease.
  const fork = unsyncedForks(
    trusted,
    headCp?.checkpointId ?? null,
    synced?.lastCheckpointId ?? null,
    conn.deviceId,
  )[0];
  const forkedLease = (await leasesOf(conn, t, names, warnings)).find(
    (l) =>
      l.forkedFromReplicaId !== null &&
      !l.mine &&
      (synced === null ||
        l.acquiredAt === null ||
        l.acquiredAt === undefined ||
        l.acquiredAt > synced.updatedAt),
  );
  if (fork) {
    const over = trusted.find((c) => c.checkpointId === fork.parentCheckpointId);
    warnings.push({
      code: 'W_NEXUS_VAULT_FORK',
      message: `snapshot ${fork.checkpointId} by ${names.get(fork.deviceId) ?? fork.deviceId} is a labelled fork: pushed with --force over snapshot ${fork.parentCheckpointId}${over ? ` (replica ${over.replicaId})` : ''}, which that device had not synced${forkedLease ? `; the write lease was taken by force from replica ${forkedLease.forkedFromReplicaId}` : ''}`,
    });
  } else if (forkedLease) {
    warnings.push({
      code: 'W_NEXUS_VAULT_FORK',
      message: `the write lease was taken by force from replica ${forkedLease.forkedFromReplicaId}: the newest snapshot is a labelled fork`,
    });
  }
  const remedy =
    verdict === 'untrusted'
      ? `the newest snapshot ${head.headCheckpointId} is not signed by a device this account trusts: do not pull it; see which device pushed it with \`cleo cloud vault\` and \`cleo cloud activity\`, and revoke that device if you do not recognise it`
      : verdict === 'behind'
        ? 'run `cleo cloud pull` to bring this machine to the newest snapshot'
        : verdict === 'ahead'
          ? 'run `cleo cloud push` to back up the local changes'
          : verdict === 'diverged'
            ? 'both sides changed: run `cleo cloud push --force` to keep this machine (a labelled fork), or `cleo cloud pull --force` to take the cloud (a safety backup is taken first)'
            : verdict === 'empty'
              ? 'run `cleo cloud push` to make the first snapshot'
              : !localIntegrity
                ? 'the local store failed its integrity check: run `cleo doctor` and `cleo cloud restore`'
                : null;
  return {
    apiUrl: conn.apiUrl,
    scope: t.scope,
    streamId: t.streamId,
    verdict,
    remedy,
    localIntegrity,
    head: headCp ? snapshotOf(headCp, names) : null,
    lastSynced: synced?.lastCheckpointId ?? null,
    tables,
    devices: [...newest.values()].map((cp) => ({
      deviceId: cp.deviceId,
      deviceName: names.get(cp.deviceId) ?? null,
      checkpointId: cp.checkpointId,
      createdAt: (cp as Checkpoint & { createdAt?: string }).createdAt ?? null,
      matchesHead: headCp ? sameVaultManifest(cp.manifest, headCp.manifest) : false,
    })),
    warnings: [...warnings, ...conn.state.drainWarnings()],
  };
}

/** `cleo cloud lease release`: hand the write lease back so another device can push. */
async function releaseNexusVaultLeaseImpl(
  opts: NexusVaultCommandOptions = {},
): Promise<CloudLeaseReleaseResult> {
  const conn = await connectNexusVault(opts);
  const key = await unlockNexusAccountKey(conn, { readOnly: true });
  const t = await resolveTarget(conn, key.masterKey, opts, 'read');
  if (!t.replicaId) {
    throw vaultError(
      'E_NEXUS_VAULT_NOT_LINKED',
      'this copy is not attached from this device',
      'run `cleo project link`',
    );
  }
  let released = true;
  try {
    await conn.raw(
      'DELETE',
      `${streamPath(t.streamId)}/leases/${NEXUS_VAULT_LEASE_ROLE}?replicaId=${encodeURIComponent(t.replicaId)}`,
      z.looseObject({}),
    );
  } catch (err) {
    if (!(err instanceof NexusError && err.status === 404)) throw err;
    released = false;
  }
  return {
    apiUrl: conn.apiUrl,
    scope: t.scope,
    streamId: t.streamId,
    released,
    warnings: [...conn.warnings],
  };
}

/** Run a vault command; a raw API failure becomes a mapped {@link NexusAccountError}. */
async function mapped<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw err instanceof NexusError ? nexusApiErrorToAccountError(err) : err;
  }
}

/**
 * `cleo cloud push`: snapshot this store into the vault under the write lease.
 *
 * @param opts - Scope, `force` (take the lease, push over a newer head as a labelled fork),
 *   `hold` (keep the writer lease after the push instead of releasing it) and overrides.
 * @returns What was pushed.
 * @throws {NexusAccountError} `E_NEXUS_VAULT_LEASE_HELD`, `E_NEXUS_VAULT_BEHIND`, `E_NEXUS_VAULT_REFUSED`,
 *   `E_NEXUS_VAULT_NOT_LINKED`, `E_NEXUS_VAULT_KEY_UNAVAILABLE`, or a mapped API error.
 */
export function pushNexusVault(
  opts: NexusVaultCommandOptions & { force?: boolean; hold?: boolean } = {},
): Promise<CloudPushResult> {
  return mapped(() => pushNexusVaultImpl(opts));
}

/**
 * `cleo cloud pull` / `cleo cloud restore`: verify and activate a snapshot.
 *
 * @param opts - Mode, snapshot, project and target overrides.
 * @returns What was restored.
 * @throws {NexusAccountError} `E_NEXUS_VAULT_LOCAL_CHANGES`, `E_NEXUS_VAULT_VERIFY_FAILED`,
 *   `E_NEXUS_VAULT_EMPTY`, `E_NEXUS_VAULT_KEY_UNAVAILABLE`, or a mapped API error.
 */
export function restoreNexusVault(opts: NexusVaultRestoreOptions): Promise<CloudRestoreResult> {
  return mapped(() => restoreNexusVaultImpl(opts));
}

/**
 * `cleo cloud vault`: the vault's lineage, last push per device, pending changes and leases.
 *
 * @param opts - Scope and overrides.
 * @returns The vault status.
 */
export function nexusVaultStatus(
  opts: NexusVaultCommandOptions = {},
): Promise<CloudVaultStatusResult> {
  return mapped(() => nexusVaultStatusImpl(opts));
}

/**
 * `cleo cloud verify`: compare this store with the cloud and every device's newest snapshot.
 *
 * @param opts - Scope and overrides.
 * @returns The verdict and per-table comparison.
 */
export function verifyNexusVault(opts: NexusVaultCommandOptions = {}): Promise<CloudVerifyResult> {
  return mapped(() => verifyNexusVaultImpl(opts));
}

/**
 * `cleo cloud lease release`: hand the write lease back.
 *
 * @param opts - Scope and overrides.
 * @returns Whether a lease was released.
 */
export function releaseNexusVaultLease(
  opts: NexusVaultCommandOptions = {},
): Promise<CloudLeaseReleaseResult> {
  return mapped(() => releaseNexusVaultLeaseImpl(opts));
}
