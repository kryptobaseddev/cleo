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
 * - **Inside a project linked and attached from this device**: nothing to do.
 * - **Outside a CLEO project**: list the account's projects by name
 *   ({@link listNexusNamedProjects}) with the exact `cleo cloud restore`
 *   command for each one this machine can restore.
 * - **A read-only device, or device credentials off**: skipped.
 *
 * No function here logs, prompts or prints: the caller supplies `confirm`
 * and `onStep`.
 *
 * @task T13102
 * @epic T12322
 */

import type {
  CloudPushResult,
  CloudWarning,
  NexusFirstRunResult,
  NexusFirstRunState,
  NexusProjectLink,
  NexusProjectLinkResult,
} from '@cleocode/contracts';
import { NexusAccountError, resolveNexusApiUrl } from './nexus-auth.js';
import { currentNexusCloudProject } from './nexus-cloud.js';
import { isNexusDeviceEnabled } from './nexus-device.js';
import { linkProjectToNexus, type NexusLinkOptions } from './nexus-link.js';
import {
  listNexusNamedProjects,
  type NexusNamedProjectsOptions,
  type NexusNamedProjectsResult,
} from './nexus-project-names.js';
import { type NexusVaultCommandOptions, pushNexusVault } from './nexus-vault.js';
import type { NexusVaultOptions } from './nexus-vault-keys.js';

/** What a run that did not link and back up tells the user to run instead. */
export const NEXUS_FIRST_RUN_NEXT_COMMAND = 'cleo project link && cleo cloud push';

/** The question a terminal is asked before linking and backing up. */
export const NEXUS_FIRST_RUN_QUESTION =
  'This project is not linked to Cleo Nexus. Link it and back it up now (encrypted)?';

/** Warning code: linking the project failed. */
export const W_NEXUS_FIRST_RUN_LINK = 'W_NEXUS_FIRST_RUN_LINK';

/** Warning code: the first backup failed. */
export const W_NEXUS_FIRST_RUN_BACKUP = 'W_NEXUS_FIRST_RUN_BACKUP';

/** Warning code: the account's projects could not be listed. */
export const W_NEXUS_FIRST_RUN_PROJECTS = 'W_NEXUS_FIRST_RUN_PROJECTS';

/** Warning code: a non-fatal problem the link reported. */
export const W_NEXUS_FIRST_RUN_LINK_NOTE = 'W_NEXUS_FIRST_RUN_LINK_NOTE';

/**
 * Whether the first run may link and back up: `yes` does it, `prompt` asks
 * through `confirm`, `never` only reports the next command.
 */
export type NexusFirstRunConsent = 'yes' | 'prompt' | 'never';

/** A step the first run is about to take (for progress lines). */
export type NexusFirstRunStep = 'link' | 'backup' | 'projects';

/** Options of {@link runNexusFirstRun}. */
export interface NexusFirstRunOptions extends NexusVaultOptions {
  /** `yes` (`--yes`), `prompt` (a terminal) or `never` (non-interactive). */
  consent: NexusFirstRunConsent;
  /** Asks a yes/no question (`prompt` only); without it, `prompt` acts as `never`. */
  confirm?: (question: string) => Promise<boolean>;
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
    backup: null,
    projects: [],
    nextCommand: null,
    warnings: [],
    ...fields,
  };
}

/** A failure as one secret-free line: code, message and remedy. */
function describeFailure(err: unknown): string {
  if (err instanceof NexusAccountError) {
    return `${err.code}: ${err.message}${err.fix ? `; ${err.fix}` : ''}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** The link is attached from this device (or, with no device id known, attached at all). */
function attachedHere(link: NexusProjectLink | null, deviceId: string | null): boolean {
  if (link === null || !link.replicaId) return false;
  return deviceId === null || link.nexusDeviceId === deviceId;
}

/** Ask, when asking is allowed; a failed or closed prompt answers no. */
async function consented(opts: NexusFirstRunOptions): Promise<boolean> {
  if (opts.consent === 'yes') return true;
  if (opts.consent !== 'prompt' || !opts.confirm) return false;
  try {
    return await opts.confirm(NEXUS_FIRST_RUN_QUESTION);
  } catch {
    return false;
  }
}

/** Link the project (the `cleo project link` path), then push its first backup. */
async function linkAndBackUp(
  opts: NexusFirstRunOptions,
  vault: NexusVaultOptions,
  projectRoot: string,
): Promise<NexusFirstRunResult> {
  opts.onStep?.('link');
  let linked: NexusProjectLinkResult;
  try {
    linked = await (opts.link ?? linkProjectToNexus)({
      apiUrl: vault.apiUrl,
      projectRoot,
      ...(vault.store ? { store: vault.store } : {}),
      ...(vault.fetch ? { fetch: vault.fetch } : {}),
      ...(vault.deviceStore ? { deviceStore: vault.deviceStore } : {}),
    });
  } catch (err) {
    return nexusFirstRunResult('link-failed', {
      projectRoot,
      nextCommand: NEXUS_FIRST_RUN_NEXT_COMMAND,
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
      projectRoot,
      link: linked.link,
      nextCommand: NEXUS_FIRST_RUN_NEXT_COMMAND,
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
      projectRoot,
      link: linked.link,
      nextCommand: 'cleo cloud push',
      warnings: [...warnings, { code: W_NEXUS_FIRST_RUN_BACKUP, message: describeFailure(err) }],
    });
  }
  return nexusFirstRunResult('backed-up', {
    projectRoot,
    link: linked.link,
    backup: { status: pushed.status, snapshot: pushed.snapshot },
    warnings: [...warnings, ...pushed.warnings],
  });
}

/** Outside a project: the account's projects by name, with their restore commands. */
async function listProjectsStep(
  opts: NexusFirstRunOptions,
  vault: NexusVaultOptions,
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
      nextCommand: 'cleo cloud projects',
      warnings: [{ code: W_NEXUS_FIRST_RUN_PROJECTS, message: describeFailure(err) }],
    });
  }
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
  const { consent, confirm, deviceId, readOnly, onStep, link, push, listProjects, ...rest } = opts;
  const apiUrl = resolveNexusApiUrl(opts.apiUrl);
  const vault: NexusVaultOptions = { ...rest, apiUrl };
  const project = currentNexusCloudProject(apiUrl, opts.projectRoot);
  if (project === null) return listProjectsStep(opts, vault);
  if (attachedHere(project.link, deviceId ?? null)) {
    return nexusFirstRunResult('already-linked', {
      projectRoot: project.root,
      link: project.link,
    });
  }
  if (!(await consented(opts))) {
    return nexusFirstRunResult(consent === 'prompt' && confirm ? 'declined' : 'offered', {
      projectRoot: project.root,
      link: project.link,
      nextCommand: NEXUS_FIRST_RUN_NEXT_COMMAND,
    });
  }
  return linkAndBackUp(opts, vault, project.root);
}
