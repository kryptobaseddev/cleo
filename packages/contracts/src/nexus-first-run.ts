/**
 * Guided first run of `cleo login nexus` (T13102, owner decision 2026-10-02:
 * onboarding = A + B + C' + D, so that `cleo login` is the only setup step in
 * practice).
 *
 * After a successful sign-in, login looks at where it runs:
 *
 * - Inside a CLEO project this machine has not linked: it offers to link the
 *   project and take the first encrypted backup. `--yes` does it without asking,
 *   a terminal asks, and a non-interactive (agent) run never asks: it reports
 *   the exact next command.
 * - Outside a CLEO project: it lists the account's projects, by name, with
 *   the exact `cleo cloud restore <name>` command for each one that has a
 *   backup this machine does not hold yet.
 *
 * `cleo cloud restore <name>` resolves a project name or label (or an id) to
 * the server's project id; an ambiguous name lists the candidates.
 *
 * This file is types + const data only (arch gate 10).
 *
 * @task T13102
 * @epic T12322
 */

import type { NexusProjectLink } from './nexus-account.js';
import type { CloudWarning } from './nexus-cloud.js';
import type { CloudVaultSnapshot } from './nexus-vault.js';

/**
 * How the guided first run ended.
 *
 * - `backed-up`: the project was linked (or already linked) and its first backup pushed
 *   (or the cloud already held this exact state).
 * - `link-failed`: linking failed; nothing was pushed.
 * - `backup-failed`: the project is linked, but the backup failed.
 * - `offered`: a non-interactive run inside an unlinked project; nothing was done and
 *   `nextCommand` says what to run.
 * - `declined`: the user answered no at the prompt; `nextCommand` says what to run later.
 * - `already-linked`: the project is linked and attached from this device; nothing to do.
 * - `projects`: outside a CLEO project; `projects` lists the account's projects.
 * - `skipped`: the first run does not apply (`reason` says why).
 */
export const NEXUS_FIRST_RUN_STATES = [
  'backed-up',
  'link-failed',
  'backup-failed',
  'offered',
  'declined',
  'already-linked',
  'projects',
  'skipped',
] as const;

/** One of {@link NEXUS_FIRST_RUN_STATES}. */
export type NexusFirstRunState = (typeof NEXUS_FIRST_RUN_STATES)[number];

/** Where a project's display name came from. */
export type NexusProjectNameSource = 'encrypted-name' | 'label' | 'id';

/** One of the account's projects, as the first run and `cleo cloud restore <name>` see it. */
export interface NexusNamedProject {
  /** The server's project id (the tracked local project id of whoever linked it). */
  projectId: string;
  /** Display name: the decrypted `encryptedName`, else the plaintext label, else the id. */
  name: string;
  /** Where {@link NexusNamedProject.name} came from. */
  nameSource: NexusProjectNameSource;
  /** The plaintext label the server holds, if any. */
  label: string | null;
  /** The owning organization's name, when the server sent it. */
  organizationName: string | null;
  /** The newest sync over every replica, when the server sent it. */
  lastSyncAt: string | null;
  /**
   * The project's stream holds a snapshot to restore. `null` when the server did not say
   * (an older server without `headCheckpointId` on the project list).
   */
  hasBackup: boolean | null;
  /** A replica of the project is attached from this device. */
  onThisDevice: boolean;
  /**
   * The exact command that restores it into the current directory: by name when the name
   * is unique on the account, else by id. `null` when there is nothing to restore here
   * (no backup, or it is already on this device).
   */
  restoreCommand: string | null;
}

/** The first backup the guided run pushed. */
export interface NexusFirstRunBackup {
  /** `pushed`: a new snapshot; `up-to-date`: the cloud already held this state. */
  status: 'pushed' | 'up-to-date';
  /** The snapshot, when the server named one. */
  snapshot: CloudVaultSnapshot | null;
}

/** The guided first run's outcome, carried as `data.firstRun` of the `cleo login nexus` envelope. */
export interface NexusFirstRunResult {
  /** How it ended. */
  state: NexusFirstRunState;
  /** Why it was skipped (`skipped` only), e.g. a read-only device. */
  reason: string | null;
  /** The CLEO project login ran in, or `null` outside one. */
  projectRoot: string | null;
  /** The project's link after the run, when it is linked. */
  link: NexusProjectLink | null;
  /** The backup pushed (`backed-up` only). */
  backup: NexusFirstRunBackup | null;
  /** The account's projects (`projects` only), newest first. */
  projects: NexusNamedProject[];
  /** The exact command to run next, when there is one (never asks: agents run it). */
  nextCommand: string | null;
  /** Non-fatal problems met on the way (secret-free). */
  warnings: CloudWarning[];
}
