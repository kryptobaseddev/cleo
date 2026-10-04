/**
 * `cleo cloud whoami|devices|projects`: read-only Cleo Nexus reads with the
 * device credential (cleo-nexus device contract v2.15, §4.2 E2, E5, E13, E14,
 * E15; CLI mapping §4.4).
 *
 * - Every request is a `GET`. Nothing here writes to the server or to a
 *   project store. The one side effect is the one every device-credential
 *   command has: {@link ensureNexusDeviceCredential} retries unsettled
 *   logouts and upgrades a 9.24 session once (§3.4, §3.5).
 * - Lists follow `nextCursor` (§4.0.3) with the largest page the server takes,
 *   up to a page budget, and report the server's `truncated` flags.
 * - Failures are mapped by {@link nexusApiErrorToAccountError}, whose table
 *   lives in `@cleocode/contracts` (§4.0.4).
 *
 * No function here logs, and no result or error carries a token.
 *
 * @task T12871
 * @epic T12323
 */

import type {
  CloudDevicesResult,
  CloudPaging,
  CloudProjectShowResult,
  CloudProjectsResult,
  CloudWarning,
  CloudWhoamiResult,
  NexusCloudReplica,
  NexusDeviceListState,
  NexusProjectLink,
} from '@cleocode/contracts';
import {
  NEXUS_CLOUD_MAX_PAGES,
  NEXUS_PAGE_LIMIT_MAX,
  nexusCloudDevicePageSchema,
  nexusCloudProjectDetailSchema,
  nexusCloudProjectPageSchema,
  nexusCloudReplicaPageSchema,
  nexusCloudWhoamiSchema,
} from '@cleocode/contracts/nexus-cloud.js';
import { readDeclaredProjectIdentity } from '@cleocode/paths';
import { resolveOrCwd } from '../paths.js';
import { type FetchLike, Http, NexusError, type ResponseSchema } from './http.js';
import { NexusAccountError, resolveNexusApiUrl } from './nexus-auth.js';
import { isNexusDeviceEnabled, NexusDeviceStore, type SealedNexusDevice } from './nexus-device.js';
import {
  ensureNexusDeviceCredential,
  type NexusDeviceCredentialOptions,
  nexusApiErrorToAccountError,
} from './nexus-enrol.js';
import { nexusLinkPath, readNexusProjectLink } from './nexus-link.js';

/** Timeout of one `cleo cloud` request. */
export const NEXUS_CLOUD_TIMEOUT_MS = 15_000;

/** Warning code for a non-fatal problem met while getting the device credential. */
export const W_NEXUS_CREDENTIAL = 'W_NEXUS_CREDENTIAL';

/** Warning code: a list stopped at its page budget while the server had more. */
export const W_NEXUS_PAGE_LIMIT = 'W_NEXUS_PAGE_LIMIT';

/** Warning code: a server ceiling cut a list (§4.0.3 `truncated`). */
export const W_NEXUS_TRUNCATED = 'W_NEXUS_TRUNCATED';

/** Options shared by every `cleo cloud` read; all optional (tests inject them). */
export interface NexusCloudOptions extends NexusDeviceCredentialOptions {
  /** Project root; defaults to the current project (when there is one). */
  projectRoot?: string;
  /** Per-request timeout; default {@link NEXUS_CLOUD_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Most pages a list follows; default {@link NEXUS_CLOUD_MAX_PAGES}. */
  maxPages?: number;
  /** Page size sent as `limit`; default {@link NEXUS_PAGE_LIMIT_MAX}. */
  pageLimit?: number;
}

/** A signed-in, read-only connection to the API. Holds the bearer inside {@link Http} only. */
export interface NexusCloudConnection {
  /** API origin. */
  readonly apiUrl: string;
  /** The device entry whose credential the requests carry. */
  readonly device: SealedNexusDevice;
  /** Warnings from getting the credential. */
  readonly warnings: CloudWarning[];
  /** `GET path`, parsed against `schema`; failures mapped per §4.0.4. */
  get<T>(path: string, schema: ResponseSchema<T>): Promise<T>;
  /** {@link NexusCloudConnection.get}, but a 404 `E_NOT_FOUND` answers `null`. */
  find<T>(path: string, schema: ResponseSchema<T>): Promise<T | null>;
}

/** The current CLEO project, as far as the cloud reads need it. */
export interface NexusCloudProject {
  /** Project root. */
  readonly root: string;
  /** The tracked project id (`.cleo/project.json`, legacy `.cleo/project-id`). */
  readonly projectId: string;
  /** The `.cleo/nexus-link.json` entry for the origin, if any. */
  readonly link: NexusProjectLink | null;
  /** Path of `.cleo/nexus-link.json` (whether or not it exists). */
  readonly linkPath: string;
}

/**
 * Refuse with `E_NEXUS_DEVICE_REQUIRED` when device credentials are off
 * (`CLEO_NEXUS_DEVICE=0`): the cloud reads never fall back to a 9.24 session.
 *
 * @throws {NexusAccountError} `E_NEXUS_DEVICE_REQUIRED`.
 */
export function assertNexusCloudDeviceMode(): void {
  if (isNexusDeviceEnabled()) return;
  throw new NexusAccountError(
    'E_NEXUS_DEVICE_REQUIRED',
    '`cleo cloud` reads use the device credential, which CLEO_NEXUS_DEVICE=0 turns off',
    'unset CLEO_NEXUS_DEVICE and run `cleo login nexus`',
  );
}

/** Wrap credential warnings (plain strings) as envelope warnings. */
export function nexusCredentialWarnings(warnings: readonly string[]): CloudWarning[] {
  return warnings.map((message) => ({ code: W_NEXUS_CREDENTIAL, message }));
}

/**
 * Open a read-only connection with this machine's device credential.
 *
 * @param opts - API URL, account, stores and test overrides.
 * @returns The connection.
 * @throws {NexusAccountError} `E_NEXUS_DEVICE_REQUIRED`, `E_NEXUS_NOT_SIGNED_IN`,
 *   `E_NEXUS_ACCOUNT_AMBIGUOUS`, or an upgrade failure.
 */
export async function connectNexusCloud(
  opts: NexusCloudOptions = {},
): Promise<NexusCloudConnection> {
  assertNexusCloudDeviceMode();
  const apiUrl = resolveNexusApiUrl(opts.apiUrl);
  const handle = await ensureNexusDeviceCredential({ ...opts, apiUrl });
  const bearer = handle.device.currentBearer();
  if (bearer === null) {
    throw new NexusAccountError(
      'E_NEXUS_NOT_SIGNED_IN',
      `not signed in to Cleo Nexus at ${apiUrl}`,
      'run `cleo login nexus`',
    );
  }
  const base: FetchLike =
    opts.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? NEXUS_CLOUD_TIMEOUT_MS;
  const timed: FetchLike = (input, init) =>
    base(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const http = new Http({ baseUrl: apiUrl, token: bearer, fetch: timed, maxAttempts: 1 });
  return {
    apiUrl,
    device: handle.device,
    warnings: nexusCredentialWarnings(handle.warnings),
    async get<T>(path: string, schema: ResponseSchema<T>): Promise<T> {
      try {
        return await http.request('GET', path, schema);
      } catch (err) {
        throw nexusApiErrorToAccountError(err);
      }
    },
    async find<T>(path: string, schema: ResponseSchema<T>): Promise<T | null> {
      try {
        return await http.request('GET', path, schema);
      } catch (err) {
        if (err instanceof NexusError && err.status === 404 && err.code === 'E_NOT_FOUND') {
          return null;
        }
        throw nexusApiErrorToAccountError(err);
      }
    },
  };
}

/** A path with its query string; `undefined` values are left out. */
export function nexusQueryPath(
  path: string,
  query: Readonly<Record<string, string | number | undefined>>,
): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
  const qs = params.toString();
  return qs === '' ? path : `${path}?${qs}`;
}

/** One page of a cursor-paged list. */
interface Page {
  readonly nextCursor: string | null;
  readonly truncated: boolean;
}

/**
 * Follow `nextCursor` until the server has no more or the budget is spent.
 *
 * @param fetchPage - Fetch the page after `cursor` (`null` for the first).
 * @param maxPages - Page budget (at least 1).
 * @returns Every page fetched and the paging facts.
 */
export async function followNexusPages<P extends Page>(
  fetchPage: (cursor: string | null) => Promise<P>,
  maxPages: number,
): Promise<{ pages: P[]; paging: CloudPaging }> {
  const pages: P[] = [];
  let cursor: string | null = null;
  const budget = Math.max(1, Math.floor(maxPages));
  do {
    const page = await fetchPage(cursor);
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor !== null && pages.length < budget);
  return {
    pages,
    paging: {
      pages: pages.length,
      truncated: pages.some((p) => p.truncated),
      pageLimitReached: cursor !== null,
    },
  };
}

/** The warnings a list's paging facts call for. */
export function nexusPagingWarnings(what: string, paging: CloudPaging): CloudWarning[] {
  const out: CloudWarning[] = [];
  if (paging.truncated) {
    out.push({
      code: W_NEXUS_TRUNCATED,
      message: `the server cut the ${what} at its hard ceiling; counts in the rows are exact, the list is not`,
    });
  }
  if (paging.pageLimitReached) {
    out.push({
      code: W_NEXUS_PAGE_LIMIT,
      message: `stopped after ${paging.pages} page(s) of ${what}; the server has more`,
    });
  }
  return out;
}

/**
 * The current CLEO project, or `null` outside one (or without a project id).
 *
 * @param apiUrl - API origin whose link entry to read.
 * @param projectRoot - Explicit project root; defaults to the current one.
 * @returns The project, its id and link entry, or `null`.
 */
export function currentNexusCloudProject(
  apiUrl: string,
  projectRoot?: string,
): NexusCloudProject | null {
  let root: string;
  try {
    root = resolveOrCwd(projectRoot);
  } catch {
    return null;
  }
  const identity = readDeclaredProjectIdentity(root);
  if (!identity) return null;
  return {
    root,
    projectId: identity.projectId,
    link: readNexusProjectLink(root, apiUrl),
    linkPath: nexusLinkPath(root),
  };
}

/**
 * `cleo cloud whoami`: E2 `GET /v1/whoami`.
 *
 * @param opts - API URL, account, stores and test overrides.
 * @returns Who is calling: user, organizations, credential and device.
 */
export async function nexusCloudWhoami(opts: NexusCloudOptions = {}): Promise<CloudWhoamiResult> {
  const conn = await connectNexusCloud(opts);
  const whoami = await conn.get('/v1/whoami', nexusCloudWhoamiSchema);
  return { apiUrl: conn.apiUrl, ...whoami, warnings: conn.warnings };
}

/** Options for {@link listNexusCloudDevices}. */
export interface NexusCloudDevicesOptions extends NexusCloudOptions {
  /** `--state`; the server's default (`active` for device callers) when absent. */
  state?: NexusDeviceListState;
}

/**
 * `cleo cloud devices`: E5 `GET /v1/devices`, every page.
 *
 * @param opts - State filter, paging and test overrides.
 * @returns Every device, newest first, with paging facts.
 */
export async function listNexusCloudDevices(
  opts: NexusCloudDevicesOptions = {},
): Promise<CloudDevicesResult> {
  const conn = await connectNexusCloud(opts);
  const limit = opts.pageLimit ?? NEXUS_PAGE_LIMIT_MAX;
  const { pages, paging } = await followNexusPages(
    (cursor) =>
      conn.get(
        nexusQueryPath('/v1/devices', { limit, cursor: cursor ?? undefined, state: opts.state }),
        nexusCloudDevicePageSchema,
      ),
    opts.maxPages ?? NEXUS_CLOUD_MAX_PAGES,
  );
  const devices = pages.flatMap((p) => p.devices);
  return {
    apiUrl: conn.apiUrl,
    state: opts.state ?? null,
    devices,
    count: devices.length,
    paging,
    warnings: [...conn.warnings, ...nexusPagingWarnings('device list', paging)],
  };
}

/** Options for {@link listNexusCloudProjects}. */
export interface NexusCloudProjectsOptions extends NexusCloudOptions {
  /** `--org`: only this organization's projects. */
  organizationId?: string;
}

/**
 * `cleo cloud projects`: E13 `GET /v1/projects`, every page.
 *
 * @param opts - Organization filter, paging and test overrides.
 * @returns Every visible project, newest first, with paging facts.
 */
export async function listNexusCloudProjects(
  opts: NexusCloudProjectsOptions = {},
): Promise<CloudProjectsResult> {
  const conn = await connectNexusCloud(opts);
  const limit = opts.pageLimit ?? NEXUS_PAGE_LIMIT_MAX;
  const { pages, paging } = await followNexusPages(
    (cursor) =>
      conn.get(
        nexusQueryPath('/v1/projects', {
          limit,
          cursor: cursor ?? undefined,
          organizationId: opts.organizationId,
        }),
        nexusCloudProjectPageSchema,
      ),
    opts.maxPages ?? NEXUS_CLOUD_MAX_PAGES,
  );
  const projects = pages.flatMap((p) => p.projects);
  const full = { ...paging, projectsTruncated: pages.some((p) => p.projectsTruncated) };
  return {
    apiUrl: conn.apiUrl,
    organizationId: opts.organizationId ?? null,
    projects,
    count: projects.length,
    paging: full,
    warnings: [...conn.warnings, ...nexusPagingWarnings('project list', paging)],
  };
}

/**
 * Every replica of a project from E15, following its cursors.
 *
 * @param conn - Connection.
 * @param projectId - Project id.
 * @param opts - Paging overrides.
 * @returns The replicas, oldest attachment first, and the paging facts.
 */
export async function listNexusCloudReplicas(
  conn: NexusCloudConnection,
  projectId: string,
  opts: Pick<NexusCloudOptions, 'maxPages' | 'pageLimit'> = {},
): Promise<{ replicas: NexusCloudReplica[]; paging: CloudPaging }> {
  const limit = opts.pageLimit ?? NEXUS_PAGE_LIMIT_MAX;
  const { pages, paging } = await followNexusPages(
    (cursor) =>
      conn.get(
        nexusQueryPath(`/v1/projects/${encodeURIComponent(projectId)}/replicas`, {
          limit,
          cursor: cursor ?? undefined,
        }),
        nexusCloudReplicaPageSchema,
      ),
    opts.maxPages ?? NEXUS_CLOUD_MAX_PAGES,
  );
  return { replicas: pages.flatMap((p) => p.replicas), paging };
}

/** Options for {@link showNexusCloudProject}. */
export interface NexusCloudProjectShowOptions extends NexusCloudOptions {
  /** The project; defaults to the current project. */
  projectId?: string;
}

/**
 * `cleo cloud projects show [<id>]`: E14 `GET /v1/projects/:projectId`. When
 * E14 cut its replica list at 50, the full list is read from E15.
 *
 * @param opts - Project id (default: the current project), paging and test overrides.
 * @returns The project detail.
 * @throws {NexusAccountError} `E_NEXUS_NOT_A_PROJECT` with no id outside a
 *   project; `E_NEXUS_REQUEST_FAILED` for an unknown or invisible project.
 */
export async function showNexusCloudProject(
  opts: NexusCloudProjectShowOptions = {},
): Promise<CloudProjectShowResult> {
  const apiUrl = resolveNexusApiUrl(opts.apiUrl);
  let projectId = opts.projectId;
  const currentProject = projectId === undefined;
  if (projectId === undefined) {
    const project = currentNexusCloudProject(apiUrl, opts.projectRoot);
    if (project === null) {
      throw new NexusAccountError(
        'E_NEXUS_NOT_A_PROJECT',
        'no project id given and not inside a CLEO project',
        'pass a project id (`cleo cloud projects show <id>`) or run it inside a CLEO project',
      );
    }
    projectId = project.link?.remoteProjectId ?? project.projectId;
  }
  const conn = await connectNexusCloud({ ...opts, apiUrl });
  const detail = await conn.get(
    `/v1/projects/${encodeURIComponent(projectId)}`,
    nexusCloudProjectDetailSchema,
  );
  let replicaPaging: CloudPaging = {
    pages: 0,
    truncated: detail.truncated,
    pageLimitReached: false,
  };
  let replicas = detail.replicas;
  if (detail.truncated) {
    const all = await listNexusCloudReplicas(conn, projectId, opts);
    replicas = all.replicas;
    replicaPaging = all.paging;
  }
  return {
    ...detail,
    replicas,
    apiUrl: conn.apiUrl,
    projectId,
    currentProject,
    replicaPaging,
    warnings: [...conn.warnings, ...nexusPagingWarnings('replica list', replicaPaging)],
  };
}

/**
 * The device credential store's location, for reports (never its contents).
 *
 * @param store - The store in use, if injected.
 * @returns Absolute path of `nexus-device.json`.
 */
export function nexusCloudCredentialsPath(store?: NexusDeviceStore): string {
  return (store ?? new NexusDeviceStore()).location;
}
