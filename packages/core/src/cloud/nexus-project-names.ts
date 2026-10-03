/**
 * The account's Cleo Nexus projects by name (T13102): the list the guided
 * first run of `cleo login nexus` shows on a machine with no linked project,
 * and the name resolution behind `cleo cloud restore <name>`.
 *
 * - A project's display name is its `encryptedName` opened with the project
 *   data key (unwrapped with the account key, read-only: nothing is minted),
 *   else its plaintext label, else its id. A name that does not open falls
 *   back to the label with one warning; it never fails the list.
 * - Names are matched exactly first, then case-insensitively, against the
 *   display name, the label and the id. One match restores; several are
 *   refused with the candidates listed (`E_NEXUS_PROJECT_AMBIGUOUS`); none is
 *   `E_NEXUS_PROJECT_NOT_FOUND`. A UUID is taken as an id without listing.
 * - Names from the server are shown with control and bidirectional-override
 *   characters removed, and the restore command quotes them for a POSIX shell.
 *
 * Every request is a `GET`. No function here logs, and no result or error
 * carries a key or a token.
 *
 * @task T13102
 * @epic T12322
 */

import type {
  CloudWarning,
  NexusCloudProjectListItem,
  NexusNamedProject,
  NexusProjectNameSource,
} from '@cleocode/contracts';
import { openProjectName } from './keys.js';
import { NexusAccountError, resolveNexusApiUrl } from './nexus-auth.js';
import { listNexusCloudProjects } from './nexus-cloud.js';
import {
  connectNexusVault,
  type NexusVaultOptions,
  nexusProjectDataKey,
  unlockNexusAccountKey,
} from './nexus-vault-keys.js';

/** Warning code: some project names are encrypted and could not be opened on this device. */
export const W_NEXUS_PROJECT_NAME_LOCKED = 'W_NEXUS_PROJECT_NAME_LOCKED';

/** A UUID project id: taken as an id without listing. */
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A legacy 12-hex project id (`ProjectId`): an id when no name matches it. */
const LEGACY_ID = /^[0-9a-f]{12}$/;

/** Control characters and bidirectional overrides: never echoed from a server-held name. */
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** A word a POSIX shell takes literally without quotes. */
const SHELL_SAFE = /^[A-Za-z0-9._@%+=:,/-]+$/;

/** Opens one project's `encryptedName`; throws when it cannot. */
export type NexusProjectNameOpener = (projectId: string, encryptedName: string) => Promise<string>;

/** Options of {@link listNexusNamedProjects} and {@link resolveNexusProjectRef}. */
export interface NexusNamedProjectsOptions extends NexusVaultOptions {
  /** This machine's device id, to mark projects already here; `null`/absent marks none. */
  deviceId?: string | null;
  /** Opener of `encryptedName` (tests); defaults to the account key, unlocked read-only. */
  openName?: NexusProjectNameOpener;
}

/** The account's projects with display names. */
export interface NexusNamedProjectsResult {
  /** API origin asked. */
  apiUrl: string;
  /** Every visible project, newest first. */
  projects: NexusNamedProject[];
  /** The list stopped short (a server ceiling or the page budget): a project may be missing. */
  incomplete: boolean;
  /** Non-fatal problems. */
  warnings: CloudWarning[];
}

/** What a project reference resolved to. */
export interface NexusProjectRef {
  /** The server's project id. */
  projectId: string;
  /** The display name it matched, or `null` when it was taken as an id. */
  name: string | null;
  /** `id`: the reference was the project id; `name`: a name or label. */
  matchedBy: 'id' | 'name';
}

/** The candidates an ambiguous or missing reference reports (the envelope's `error.details`). */
export interface NexusProjectRefDetails {
  /** The reference given. */
  ref: string;
  /** The projects it matched, each with a by-id restore command. */
  candidates: NexusNamedProject[];
}

/**
 * A reference that matched several projects or none. `publicDetails` is
 * secret-free and the CLI forwards it as the envelope's `error.details`.
 */
export class NexusProjectRefError extends NexusAccountError {
  /** The reference and its candidates. */
  readonly publicDetails: NexusProjectRefDetails;

  /**
   * @param code - `E_NEXUS_PROJECT_AMBIGUOUS` or `E_NEXUS_PROJECT_NOT_FOUND`.
   * @param message - Human message.
   * @param fix - Remedy.
   * @param publicDetails - The reference and its candidates.
   */
  constructor(
    code: 'E_NEXUS_PROJECT_AMBIGUOUS' | 'E_NEXUS_PROJECT_NOT_FOUND',
    message: string,
    fix: string,
    publicDetails: NexusProjectRefDetails,
  ) {
    super(code, message, fix);
    this.publicDetails = publicDetails;
  }
}

/**
 * A server-held name made safe to print: control and bidi-override characters removed.
 *
 * @param raw - Name as the server or the decryption gave it.
 * @returns The cleaned name, or `null` when nothing printable is left.
 */
export function safeNexusProjectName(raw: string | null | undefined): string | null {
  const clean = (raw ?? '').replace(UNSAFE_NAME_CHARS, '').trim();
  return clean === '' ? null : clean;
}

/**
 * Quote a word for a POSIX shell (single quotes; `'` becomes `'\''`).
 *
 * @param word - The word.
 * @returns It unchanged when it needs no quoting, else single-quoted.
 */
export function shellQuoteWord(word: string): string {
  return SHELL_SAFE.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The default opener: account key (read-only unlock), then each project's data key. */
function accountKeyNameOpener(opts: NexusVaultOptions): NexusProjectNameOpener {
  let unlocked: Promise<{
    conn: Awaited<ReturnType<typeof connectNexusVault>>;
    mk: Buffer;
  }> | null = null;
  return async (projectId, encryptedName) => {
    unlocked ??= (async () => {
      const conn = await connectNexusVault(opts);
      // Read-only: listing names never mints, escrows or certifies (T12974).
      const key = await unlockNexusAccountKey(conn, { readOnly: true });
      return { conn, mk: key.masterKey };
    })();
    const { conn, mk } = await unlocked;
    const pdk = await nexusProjectDataKey(conn, mk, projectId, false);
    if (pdk === null) throw new Error(`project ${projectId} has no data key yet`);
    return openProjectName(pdk, projectId, encryptedName);
  };
}

/** Open every `encryptedName`; failures become one warning, never an error. */
async function openNames(
  items: readonly NexusCloudProjectListItem[],
  opener: NexusProjectNameOpener,
  warnings: CloudWarning[],
): Promise<Map<string, string>> {
  const opened = new Map<string, string>();
  let failed = 0;
  let firstReason = '';
  for (const item of items) {
    if (!item.encryptedName) continue;
    try {
      opened.set(item.projectId, await opener(item.projectId, item.encryptedName));
    } catch (err) {
      failed += 1;
      if (firstReason === '') firstReason = err instanceof Error ? err.message : String(err);
    }
  }
  if (failed > 0) {
    warnings.push({
      code: W_NEXUS_PROJECT_NAME_LOCKED,
      message: `${failed} project name(s) are encrypted and could not be opened on this device (${firstReason}); showing the label or id instead`,
    });
  }
  return opened;
}

/** One list item as a named project, without its restore command yet. */
function namedProject(
  item: NexusCloudProjectListItem,
  decrypted: string | null,
  deviceId: string | null,
): NexusNamedProject {
  const fromName = safeNexusProjectName(decrypted);
  const label = safeNexusProjectName(item.label);
  const [name, nameSource]: [string, NexusProjectNameSource] = fromName
    ? [fromName, 'encrypted-name']
    : label
      ? [label, 'label']
      : [item.projectId, 'id'];
  return {
    projectId: item.projectId,
    name,
    nameSource,
    label,
    organizationName: item.organizationName ?? null,
    lastSyncAt: item.lastSyncAt ?? null,
    hasBackup: item.headCheckpointId === undefined ? null : item.headCheckpointId !== null,
    onThisDevice: deviceId !== null && item.replicas.some((r) => r.deviceId === deviceId),
    restoreCommand: null,
  };
}

/**
 * The projects a reference names: exact matches on the id, display name or
 * label first; when there are none, case-insensitive matches on the names.
 *
 * @param projects - The account's projects.
 * @param ref - A project name, label or id.
 * @returns Every match (one: resolved; several: ambiguous; none: not found).
 */
export function matchNexusProjects(
  projects: readonly NexusNamedProject[],
  ref: string,
): NexusNamedProject[] {
  const want = ref.trim();
  if (want === '') return [];
  const names = (p: NexusNamedProject): string[] =>
    [p.name, p.label].filter((n): n is string => n !== null);
  const exact = projects.filter((p) => p.projectId === want || names(p).includes(want));
  if (exact.length > 0) return exact;
  const folded = want.toLowerCase();
  return projects.filter((p) => names(p).some((n) => n.toLowerCase() === folded));
}

/** ` --api-url <origin>` when the origin is not the one a bare command would use. */
function apiUrlFlag(apiUrl: string): string {
  let fallback: string | null;
  try {
    fallback = resolveNexusApiUrl();
  } catch {
    fallback = null;
  }
  return apiUrl === fallback ? '' : ` --api-url ${shellQuoteWord(apiUrl)}`;
}

/**
 * The exact `cleo cloud restore` command for a project: by name when the name
 * resolves to it alone (and cannot be read as a flag or an id), else by id.
 *
 * @param project - The project.
 * @param all - Every project of the account, for the uniqueness check.
 * @param apiUrl - API origin (added as `--api-url` when not the default).
 * @returns The command.
 */
export function nexusRestoreCommand(
  project: NexusNamedProject,
  all: readonly NexusNamedProject[],
  apiUrl: string,
): string {
  const matches = matchNexusProjects(all, project.name);
  const byName =
    project.nameSource !== 'id' &&
    !project.name.startsWith('-') &&
    !UUID_ID.test(project.name) &&
    matches.length === 1 &&
    matches[0]?.projectId === project.projectId;
  const ref = byName ? project.name : project.projectId;
  return `cleo cloud restore ${shellQuoteWord(ref)}${apiUrlFlag(apiUrl)}`;
}

/**
 * `GET /v1/projects` (E13, every page) with display names and, for each
 * project this machine can restore, the exact restore command.
 *
 * @param opts - Device id, name opener, API URL, stores and test overrides.
 * @returns The named projects, whether the list is complete, and warnings.
 * @throws {NexusAccountError} When the list itself cannot be read.
 */
export async function listNexusNamedProjects(
  opts: NexusNamedProjectsOptions = {},
): Promise<NexusNamedProjectsResult> {
  const { deviceId, openName, ...vault } = opts;
  const list = await listNexusCloudProjects(vault);
  const warnings = [...list.warnings];
  const opened = await openNames(
    list.projects,
    openName ?? accountKeyNameOpener({ ...vault, apiUrl: list.apiUrl }),
    warnings,
  );
  const named = list.projects.map((item) =>
    namedProject(item, opened.get(item.projectId) ?? null, deviceId ?? null),
  );
  const projects = named.map((p) => ({
    ...p,
    restoreCommand:
      p.hasBackup === false || p.onThisDevice ? null : nexusRestoreCommand(p, named, list.apiUrl),
  }));
  return {
    apiUrl: list.apiUrl,
    projects,
    incomplete: list.paging.pageLimitReached || list.paging.projectsTruncated,
    warnings,
  };
}

/** One candidate line: name, id, organization and last sync. */
function candidateLine(p: NexusNamedProject): string {
  const org = p.organizationName ? `, ${p.organizationName}` : '';
  const sync = p.lastSyncAt ? `, last sync ${p.lastSyncAt}` : '';
  return `${p.name} (${p.projectId}${org}${sync})`;
}

/**
 * Resolve a project name, label or id to the server's project id, for
 * `cleo cloud restore <name>`. A UUID is taken as the id without a request.
 *
 * @param ref - What the user typed.
 * @param opts - Name opener, API URL, stores and test overrides.
 * @returns The project id and how it matched.
 * @throws {NexusProjectRefError} `E_NEXUS_PROJECT_AMBIGUOUS` (the candidates
 *   are listed) or `E_NEXUS_PROJECT_NOT_FOUND`.
 * @throws {NexusAccountError} When the project list cannot be read.
 */
export async function resolveNexusProjectRef(
  ref: string,
  opts: NexusNamedProjectsOptions = {},
): Promise<NexusProjectRef> {
  const want = ref.trim();
  if (UUID_ID.test(want)) return { projectId: want.toLowerCase(), name: null, matchedBy: 'id' };
  const listed = await listNexusNamedProjects({ ...opts, deviceId: null });
  const matches = matchNexusProjects(listed.projects, want);
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only) {
    return only.projectId === want
      ? { projectId: only.projectId, name: null, matchedBy: 'id' }
      : { projectId: only.projectId, name: only.name, matchedBy: 'name' };
  }
  if (matches.length > 1) {
    const candidates = matches.map((p) => ({
      ...p,
      restoreCommand: `cleo cloud restore ${p.projectId}${apiUrlFlag(listed.apiUrl)}`,
    }));
    throw new NexusProjectRefError(
      'E_NEXUS_PROJECT_AMBIGUOUS',
      `"${safeNexusProjectName(want) ?? want}" matches ${matches.length} projects: ${matches.map(candidateLine).join('; ')}`,
      `restore one by its id: ${candidates.map((c) => c.restoreCommand).join(' | ')}`,
      { ref: want, candidates },
    );
  }
  if (LEGACY_ID.test(want)) return { projectId: want, name: null, matchedBy: 'id' };
  throw new NexusProjectRefError(
    'E_NEXUS_PROJECT_NOT_FOUND',
    `no project of this account at ${listed.apiUrl} is named "${safeNexusProjectName(want) ?? want}"${listed.incomplete ? ' (the project list was cut short, so it may exist; use its id)' : ''}`,
    'run `cleo cloud projects` to list the projects, then pass a name or id from it',
    { ref: want, candidates: [] },
  );
}
