/**
 * The guided first run of `cleo login nexus` (T13102, owner decision
 * 2026-10-02: onboarding = A + B + C' + D, so that `cleo login` is the only
 * setup step in practice). It runs after a successful sign-in and never fails
 * it: every problem becomes a state, a warning and the exact next command.
 *
 * - **Inside a CLEO project this device has not linked**: offer "link and
 *   back up now". With consent `yes` (`--yes`) it links the project through
 *   {@link linkProjectToNexus} (the same path as `cleo project link`, so the
 *   project key created at registration comes with it) and then takes the
 *   first encrypted backup through {@link pushNexusVault}. With `prompt` (a
 *   terminal) it asks first. With `never` (a non-interactive run: an agent)
 *   it never asks and reports the exact next command.
 * - **Inside an unlinked project the cloud already backs up**, from another
 *   device, and this copy never synced (a fresh clone on a new machine: the
 *   project id is tracked in git): a backup would be refused as behind, so
 *   the offer is to restore that backup here ({@link restoreNexusVault}, then
 *   the same link), under the same consent rules.
 * - **Inside a project linked and attached from this device**: nothing to do.
 * - **Outside a CLEO project**: list the account's projects by name
 *   ({@link listNexusNamedProjects}) with the exact `cleo cloud restore`
 *   command for each one this machine can restore.
 * - **A read-only device, or device credentials off**: skipped.
 *
 * Every printed command carries `--api-url` when the origin is not the
 * default. No function here logs, prompts or prints: the caller supplies
 * `confirm` and `onStep`.
 *
 * @task T13102
 * @epic T12322
 */

import path from 'node:path';
import type {
  CloudPushResult,
  CloudRestoreResult,
  CloudWarning,
  NexusFirstRunResult,
  NexusFirstRunState,
  NexusProjectLink,
  NexusProjectLinkResult,
} from '@cleocode/contracts';
import { nexusCloudProjectDetailSchema } from '@cleocode/contracts/nexus-cloud.js';
import { NexusAccountError, resolveNexusApiUrl } from './nexus-auth.js';
import { connectNexusCloud, currentNexusCloudProject } from './nexus-cloud.js';
import { isNexusDeviceEnabled } from './nexus-device.js';
import { linkProjectToNexus, type NexusLinkOptions, readNexusProjectLink } from './nexus-link.js';
import {
  listNexusNamedProjects,
  type NexusNamedProjectsOptions,
  type NexusNamedProjectsResult,
  nexusApiUrlFlag,
  shellQuoteWord,
} from './nexus-project-names.js';
import {
  type NexusVaultCommandOptions,
  type NexusVaultRestoreOptions,
  pushNexusVault,
  restoreNexusVault,
} from './nexus-vault.js';
import type { NexusVaultOptions } from './nexus-vault-keys.js';
import { NexusVaultState } from './nexus-vault-state.js';

/** The question a terminal is asked before linking and backing up. */
export const NEXUS_FIRST_RUN_QUESTION =
  'This project is not linked to Cleo Nexus. Link it and back it up now (encrypted)?';

/** The question a terminal is asked before restoring a backup this copy never synced. */
export const NEXUS_FIRST_RUN_RESTORE_QUESTION =
  'Cleo Nexus holds a backup of this project from another device. Restore it here now?';

/** Warning code: linking the project failed. */
export const W_NEXUS_FIRST_RUN_LINK = 'W_NEXUS_FIRST_RUN_LINK';

/** Warning code: the first backup failed. */
export const W_NEXUS_FIRST_RUN_BACKUP = 'W_NEXUS_FIRST_RUN_BACKUP';

/** Warning code: restoring the cloud's backup failed. */
export const W_NEXUS_FIRST_RUN_RESTORE = 'W_NEXUS_FIRST_RUN_RESTORE';

/** Warning code: the account's projects could not be listed. */
export const W_NEXUS_FIRST_RUN_PROJECTS = 'W_NEXUS_FIRST_RUN_PROJECTS';

/** Warning code: a non-fatal problem the link reported. */
export const W_NEXUS_FIRST_RUN_LINK_NOTE = 'W_NEXUS_FIRST_RUN_LINK_NOTE';

/**
 * Whether the first run may act: `yes` does it, `prompt` asks through
 * `confirm`, `never` only reports the next command.
 */
export type NexusFirstRunConsent = 'yes' | 'prompt' | 'never';

/** A step the first run is about to take (for progress lines). */
export type NexusFirstRunStep = 'link' | 'backup' | 'restore' | 'projects';

/** What {@link NexusFirstRunOptions.cloudBackup} is asked about. */
export interface NexusCloudBackupQuery extends NexusVaultOptions {
  /** API origin. */
  apiUrl: string;
  /** The project's root on this machine. */
  projectRoot: string;
  /** The server's project id (the tracked local id, or the link's remote id). */
  projectId: string;
}

/** Options of {@link runNexusFirstRun}. */
export interface NexusFirstRunOptions extends NexusVaultOptions {
  /** `yes` (`--yes`), `prompt` (a terminal) or `never` (non-interactive). */
  consent: NexusFirstRunConsent;
  /**
   * Asks a yes/no question (`prompt` only); `defaultYes` is what an empty answer means
   * (yes for link and back up, no for a restore). Without it, `prompt` acts as `never`.
   */
  confirm?: (question: string, defaultYes: boolean) => Promise<boolean>;
  /** The device login enrolled, to tell projects attached here from others. */
  deviceId?: string | null;
  /** The device signed in with the read-only profile: it cannot link or back up. */
  readOnly?: boolean;
  /** Called before each step (progress lines). */
  onStep?: (step: NexusFirstRunStep) => void;
  /** Link (tests); defaults to {@link linkProjectToNexus}. */
  link?: (opts: NexusLinkOptions) => Promise<NexusProjectLinkResult>;
  /** Push (tests); defaults to {@link pushNexusVault}. */
  push?: (opts: NexusVaultCommandOptions) => Promise<CloudPushResult>;
  /** Restore (tests); defaults to {@link restoreNexusVault}. */
  restore?: (opts: NexusVaultRestoreOptions) => Promise<CloudRestoreResult>;
  /** Unsynced-backup check (tests); defaults to {@link hasUnsyncedNexusBackup}. */
  cloudBackup?: (query: NexusCloudBackupQuery) => Promise<boolean>;
  /** Project list (tests); defaults to {@link listNexusNamedProjects}. */
  listProjects?: (opts: NexusNamedProjectsOptions) => Promise<NexusNamedProjectsResult>;
}

/**
 * A first-run result with every field at its empty value.
 *
 * @param state - How it ended.
 * @param fields - Fields to set.
 * @returns The result.
 */
export function nexusFirstRunResult(
  state: NexusFirstRunState,
  fields: Partial<Omit<NexusFirstRunResult, 'state'>> = {},
): NexusFirstRunResult {
  return {
    state,
    reason: null,
    projectRoot: null,
    link: null,
    offer: null,
    backup: null,
    restore: null,
    projects: [],
    nextCommand: null,
    choices: [],
    warnings: [],
    ...fields,
  };
}

/** The commands a first run names (see {@link nexusFirstRunCommands}). */
export interface NexusFirstRunCommands {
  /** Link the current project, then push its first backup. */
  linkAndBackUp: string;
  /** Link the current project, then push it as a labelled fork over a newer cloud head. */
  linkAndForkPush: string;
  /** Push the current project. */
  push: string;
  /** Pull the cloud's newest snapshot into the current project. */
  pull: string;
  /** List the account's projects. */
  projects: string;
  /** Restore a project's backup into a directory. */
  restore: (projectId: string, root: string) => string;
}

/**
 * The commands a first run names, with `--api-url` when the origin is not the default.
 *
 * @param apiUrl - API origin.
 * @returns The link-and-back-up, push, pull, list and restore commands.
 */
export function nexusFirstRunCommands(apiUrl: string): NexusFirstRunCommands {
  const f = nexusApiUrlFlag(apiUrl);
  return {
    linkAndBackUp: `cleo project link${f} && cleo cloud push${f}`,
    linkAndForkPush: `cleo project link${f} && cleo cloud push --force${f}`,
    push: `cleo cloud push${f}`,
    pull: `cleo cloud pull${f}`,
    projects: `cleo cloud projects${f}`,
    restore: (projectId: string, root: string) =>
      `cleo cloud restore ${shellQuoteWord(projectId)} --into ${shellQuoteWord(root)}${f}`,
  };
}

/** A failure as one secret-free line: code, message and remedy. */
function describeFailure(err: unknown): string {
  if (err instanceof NexusAccountError) {
    return `${err.code}: ${err.message}${err.fix ? `; ${err.fix}` : ''}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** The error's code, when it carries one. */
function codeOf(err: unknown): string | null {
  return err instanceof NexusAccountError ? err.code : null;
}

/** The link is attached from this device (or, with no device id known, attached at all). */
function attachedHere(link: NexusProjectLink | null, deviceId: string | null): boolean {
  if (link === null || !link.replicaId) return false;
  return deviceId === null || link.nexusDeviceId === deviceId;
}

/** Ask, when asking is allowed; a failed or closed prompt answers no. */
async function consented(
  opts: NexusFirstRunOptions,
  question: string,
  defaultYes: boolean,
): Promise<boolean> {
  if (opts.consent === 'yes') return true;
  if (opts.consent !== 'prompt' || !opts.confirm) return false;
  try {
    return await opts.confirm(question, defaultYes);
  } catch {
    return false;
  }
}

/**
 * Whether Cleo Nexus holds a backup of the project that this copy never
 * synced: the project is registered with a head snapshot (E14, a `GET`), and
 * the vault state records no sync of its stream from this project root. Any
 * failure answers `false`, so the run falls back to link and back up.
 *
 * @param query - API URL, project root and id, stores and test overrides.
 * @returns `true` when a restore, not a backup, is the right first step.
 */
export async function hasUnsyncedNexusBackup(query: NexusCloudBackupQuery): Promise<boolean> {
  try {
    const conn = await connectNexusCloud(query);
    const detail = await conn.find(
      `/v1/projects/${encodeURIComponent(query.projectId)}`,
      nexusCloudProjectDetailSchema,
    );
    const stream = detail?.stream ?? null;
    if (stream === null || stream.headCheckpointId === null) return false;
    const synced = (query.vaultState ?? new NexusVaultState()).stream(
      conn.apiUrl,
      conn.device.userId,
      stream.streamId,
      path.resolve(query.projectRoot),
    );
    return !synced?.lastCheckpointId;
  } catch {
    return false;
  }
}

/** The link step's options from the vault options. */
function linkOptions(vault: NexusVaultOptions, projectRoot: string): NexusLinkOptions {
  return {
    apiUrl: vault.apiUrl,
    projectRoot,
    ...(vault.store ? { store: vault.store } : {}),
    ...(vault.fetch ? { fetch: vault.fetch } : {}),
    ...(vault.deviceStore ? { deviceStore: vault.deviceStore } : {}),
  };
}

/** Link the project (the `cleo project link` path), then push its first backup. */
async function linkAndBackUp(
  opts: NexusFirstRunOptions,
  vault: NexusVaultOptions & { apiUrl: string },
  projectRoot: string,
): Promise<NexusFirstRunResult> {
  const commands = nexusFirstRunCommands(vault.apiUrl);
  const base = { projectRoot, offer: 'link-and-backup' as const };
  opts.onStep?.('link');
  let linked: NexusProjectLinkResult;
  try {
    linked = await (opts.link ?? linkProjectToNexus)(linkOptions(vault, projectRoot));
  } catch (err) {
    return nexusFirstRunResult('link-failed', {
      ...base,
      nextCommand: commands.linkAndBackUp,
      warnings: [{ code: W_NEXUS_FIRST_RUN_LINK, message: describeFailure(err) }],
    });
  }
  const warnings: CloudWarning[] = linked.warnings.map((message) => ({
    code: W_NEXUS_FIRST_RUN_LINK_NOTE,
    message,
  }));
  if (linked.replica === null) {
    // A push needs this copy attached from this device; the link's warning says why it is not.
    return nexusFirstRunResult('backup-failed', {
      ...base,
      link: linked.link,
      nextCommand: commands.linkAndBackUp,
      warnings: [
        ...warnings,
        {
          code: W_NEXUS_FIRST_RUN_BACKUP,
          message: `not backed up: this copy is not attached from this device${linked.attachError ? ` (${linked.attachError.code}: ${linked.attachError.message})` : ''}`,
        },
      ],
    });
  }
  opts.onStep?.('backup');
  let pushed: CloudPushResult;
  try {
    pushed = await (opts.push ?? pushNexusVault)({ ...vault, projectRoot, scope: 'project' });
  } catch (err) {
    return nexusFirstRunResult('backup-failed', {
      ...base,
      link: linked.link,
      // Behind: another device pushed since this copy last synced; bring that state here first.
      nextCommand: codeOf(err) === 'E_NEXUS_VAULT_BEHIND' ? commands.pull : commands.push,
      warnings: [...warnings, { code: W_NEXUS_FIRST_RUN_BACKUP, message: describeFailure(err) }],
    });
  }
  return nexusFirstRunResult('backed-up', {
    ...base,
    link: linked.link,
    backup: { status: pushed.status, snapshot: pushed.snapshot },
    warnings: [...warnings, ...pushed.warnings],
  });
}

/** Restore the cloud's backup into this copy, then link it (the `cleo cloud restore` path). */
async function restoreHere(
  opts: NexusFirstRunOptions,
  vault: NexusVaultOptions & { apiUrl: string },
  projectRoot: string,
  projectId: string,
): Promise<NexusFirstRunResult> {
  const base = { projectRoot, offer: 'restore' as const };
  opts.onStep?.('restore');
  let restored: CloudRestoreResult;
  try {
    restored = await (opts.restore ?? restoreNexusVault)({
      ...vault,
      scope: 'project',
      mode: 'restore',
      projectId,
      into: projectRoot,
      relink: async (root: string) => {
        try {
          return (await (opts.link ?? linkProjectToNexus)(linkOptions(vault, root))).warnings;
        } catch (err) {
          return [
            `restored, but linking this copy failed (${describeFailure(err)}); run \`cleo project link\``,
          ];
        }
      },
    });
  } catch (err) {
    const commands = nexusFirstRunCommands(vault.apiUrl);
    const restoreCmd = commands.restore(projectId, projectRoot);
    const warnings = [{ code: W_NEXUS_FIRST_RUN_RESTORE, message: describeFailure(err) }];
    if (codeOf(err) === 'E_NEXUS_VAULT_LOCAL_CHANGES') {
      // This copy has rows it never synced: rerunning the restore refuses the same way, so
      // the user chooses which side wins (review LOW-2).
      return nexusFirstRunResult('restore-failed', {
        ...base,
        choices: [
          {
            command: `${restoreCmd} --force`,
            effect: "take the cloud's backup; this copy's rows are replaced after a safety backup",
          },
          {
            command: commands.linkAndForkPush,
            effect:
              "keep this copy; it is pushed as a labelled fork over the cloud's newest backup",
          },
        ],
        warnings,
      });
    }
    return nexusFirstRunResult('restore-failed', { ...base, nextCommand: restoreCmd, warnings });
  }
  return nexusFirstRunResult('restored', {
    ...base,
    link: readNexusProjectLink(projectRoot, vault.apiUrl),
    restore: {
      status: restored.status,
      snapshot: restored.snapshot,
      tables: restored.tables,
      safetyBackup: restored.safetyBackup,
    },
    warnings: restored.warnings,
  });
}

/** Outside a project: the account's projects by name, with their restore commands. */
async function listProjectsStep(
  opts: NexusFirstRunOptions,
  vault: NexusVaultOptions & { apiUrl: string },
): Promise<NexusFirstRunResult> {
  opts.onStep?.('projects');
  try {
    const listed = await (opts.listProjects ?? listNexusNamedProjects)({
      ...vault,
      deviceId: opts.deviceId ?? null,
    });
    const restorable = listed.projects.filter((p) => p.restoreCommand !== null);
    return nexusFirstRunResult('projects', {
      projects: listed.projects,
      nextCommand: restorable.length === 1 ? (restorable[0]?.restoreCommand ?? null) : null,
      warnings: listed.warnings,
    });
  } catch (err) {
    return nexusFirstRunResult('projects', {
      nextCommand: nexusFirstRunCommands(vault.apiUrl).projects,
      warnings: [{ code: W_NEXUS_FIRST_RUN_PROJECTS, message: describeFailure(err) }],
    });
  }
}

/** Inside an unlinked project: restore the cloud's backup, or link and back up; asking first. */
async function offerInProject(
  opts: NexusFirstRunOptions,
  vault: NexusVaultOptions & { apiUrl: string },
  project: { root: string; projectId: string; link: NexusProjectLink | null },
): Promise<NexusFirstRunResult> {
  const projectId = project.link?.remoteProjectId ?? project.projectId;
  const restore = await (opts.cloudBackup ?? hasUnsyncedNexusBackup)({
    ...vault,
    projectRoot: project.root,
    projectId,
  });
  const question = restore ? NEXUS_FIRST_RUN_RESTORE_QUESTION : NEXUS_FIRST_RUN_QUESTION;
  // A restore replaces what this copy holds, so an empty answer means no (review LOW-3).
  if (await consented(opts, question, !restore)) {
    return restore
      ? restoreHere(opts, vault, project.root, projectId)
      : linkAndBackUp(opts, vault, project.root);
  }
  const commands = nexusFirstRunCommands(vault.apiUrl);
  return nexusFirstRunResult(opts.consent === 'prompt' && opts.confirm ? 'declined' : 'offered', {
    projectRoot: project.root,
    link: project.link,
    offer: restore ? 'restore' : 'link-and-backup',
    nextCommand: restore ? commands.restore(projectId, project.root) : commands.linkAndBackUp,
  });
}

/**
 * The guided first run after `cleo login nexus` signed in. Never throws for a
 * flow failure: the result's state, warnings and next command describe it.
 *
 * @param opts - Consent, prompt, device id, profile, API URL, stores and test overrides.
 * @returns How it ended.
 * @throws {NexusAccountError} `E_NEXUS_INVALID_API_URL` only (login has already checked it).
 */
export async function runNexusFirstRun(opts: NexusFirstRunOptions): Promise<NexusFirstRunResult> {
  if (opts.readOnly === true) {
    return nexusFirstRunResult('skipped', {
      reason: 'this device signed in with the read-only profile, which cannot link or back up',
    });
  }
  if (!isNexusDeviceEnabled()) {
    return nexusFirstRunResult('skipped', {
      reason: 'device credentials are off (CLEO_NEXUS_DEVICE=0); linking and backups need them',
    });
  }
  const {
    consent,
    confirm,
    deviceId,
    readOnly,
    onStep,
    link,
    push,
    restore,
    cloudBackup,
    listProjects,
    ...rest
  } = opts;
  const apiUrl = resolveNexusApiUrl(opts.apiUrl);
  const vault = { ...rest, apiUrl };
  const project = currentNexusCloudProject(apiUrl, opts.projectRoot);
  if (project === null) return listProjectsStep(opts, vault);
  if (attachedHere(project.link, deviceId ?? null)) {
    return nexusFirstRunResult('already-linked', {
      projectRoot: project.root,
      link: project.link,
    });
  }
  return offerInProject(opts, vault, project);
}
