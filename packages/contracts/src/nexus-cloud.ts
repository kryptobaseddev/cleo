/**
 * Cleo Nexus remote reads: what `cleo cloud status|whoami|devices|projects`
 * parse from the API and emit in their LAFS envelopes (cleo-nexus device
 * contract v2.15, §4.1, §4.2 E2/E3/E5/E13/E14/E15, §4.4), plus the error
 * mapping table of §4.0.4.
 *
 * The response schemas are the client's tolerant reading of §4.1: every field
 * the CLI reports is named, unknown fields are stripped (never `.strict()`,
 * §4 preamble), and fields the deployed server does not send on every route
 * yet (E2's `device` is a subset of `DeviceView`, E13 has no
 * `lastPresenceAt`) are optional. They are not part of `./cloud`, which
 * mirrors the server's `@cleo-nexus/shared` package one-to-one.
 *
 * Nothing here carries a token, a key or a filesystem path the server sent;
 * the local paths in {@link CloudStatusLocal} are locations only.
 *
 * This file is types + zod schemas + const data only (arch gate 10).
 *
 * @task T12871
 * @epic T12323
 */

import { z } from 'zod';
import type { NexusAccountErrorCode } from './nexus-account.js';

// ---------- shared pieces (§4.1) ----------

/** Device states (§4.1 `DeviceState`). */
export const NEXUS_DEVICE_STATES = ['active', 'signed-out', 'revoked'] as const;

/** Device-credential profiles (§2.3, §4.1 `DeviceProfile`). */
export const NEXUS_CLOUD_PROFILES = ['device', 'read-only'] as const;

/** The `state` filter of `GET /v1/devices` (E5, `ListDevicesQuery.state`). */
export const NEXUS_DEVICE_LIST_STATES = ['active', 'signed-out', 'revoked', 'all'] as const;

/** One of {@link NEXUS_DEVICE_LIST_STATES}. */
export type NexusDeviceListState = (typeof NEXUS_DEVICE_LIST_STATES)[number];

/** Largest page the list endpoints accept (§4.0.3). */
export const NEXUS_PAGE_LIMIT_MAX = 200;

/** Default number of pages a `cleo cloud` list follows before it stops and says so. */
export const NEXUS_CLOUD_MAX_PAGES = 25;

/** Seconds within which a replica's presence counts as fresh (§4.1 `PRESENCE_FRESH_SECONDS`). */
export const NEXUS_PRESENCE_FRESH_SECONDS = 86_400;

/**
 * The device state a newer server value parses as. Not `active`, so every
 * active-only check fails closed instead of the whole command failing.
 */
export const NEXUS_DEVICE_STATE_UNKNOWN = 'unknown';

const isoTime = z.iso.datetime({ offset: true });
/** A profile the CLI does not know reads as none, never as a parse failure. */
const profile = z.enum(NEXUS_CLOUD_PROFILES).nullable().catch(null);
/** A device state; a value added by a newer server reads as `unknown` (not active). */
const deviceState = z
  .enum([...NEXUS_DEVICE_STATES, NEXUS_DEVICE_STATE_UNKNOWN])
  .catch(NEXUS_DEVICE_STATE_UNKNOWN);

/** `CredentialInfo` (§4.1): the credential that made the request. */
export const nexusCloudCredentialSchema = z.object({
  kind: z.enum(['device', 'session']),
  credentialId: z.string().nullable().optional(),
  profile: profile.optional(),
  scopes: z.array(z.string()).default([]),
  createdAt: isoTime.nullable().optional(),
  lastUsedAt: isoTime.nullable().optional(),
  /** When the credential expires if it is not used again; null for sessions. */
  idleExpiresAt: isoTime.nullable().optional(),
});

/** `DeviceView` (§4.1), as far as the CLI reports it. E2 sends a subset. */
export const nexusCloudDeviceSchema = z.object({
  deviceId: z.string(),
  name: z.string(),
  platform: z.string().optional(),
  arch: z.string().nullable().optional(),
  cliVersion: z.string().nullable().optional(),
  createdAt: isoTime.optional(),
  lastSeenAt: isoTime.nullable().optional(),
  state: deviceState,
  signedOutAt: isoTime.nullable().optional(),
  /** Base64 device certificate; null until the device holds a key grant. */
  certificate: z.string().nullable().optional(),
  /** The current credential's profile, or null with none (signed out or revoked). */
  profile: profile.optional(),
  /** True for the device whose credential made this request. */
  current: z.boolean().default(false),
  projects: z.number().int().nonnegative().optional(),
  replicas: z.number().int().nonnegative().optional(),
  lastSyncAt: isoTime.nullable().optional(),
  lastPresenceAt: isoTime.nullable().optional(),
});

/** `OrganizationSummary` (§4.1). */
export const nexusCloudOrganizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string().nullable().optional(),
  role: z.string().optional(),
  personal: z.boolean().optional(),
});

/** `AccountUser` (§4.1). */
export const nexusCloudUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable().optional(),
});

/** `Whoami` (E2 `GET /v1/whoami`). */
export const nexusCloudWhoamiSchema = z.object({
  serverTime: isoTime.optional(),
  user: nexusCloudUserSchema,
  organizations: z.array(nexusCloudOrganizationSchema).default([]),
  credential: nexusCloudCredentialSchema,
  /** The calling device; null for a session caller. */
  device: nexusCloudDeviceSchema.nullable(),
});

/** `ListDevicesViewResult` (E5 `GET /v1/devices`), one page. */
export const nexusCloudDevicePageSchema = z.object({
  devices: z.array(nexusCloudDeviceSchema),
  nextCursor: z.string().max(512).nullable().default(null),
  truncated: z.boolean().default(false),
});

/** Path-free replica presence (`ReplicaPresence`), with the R4 `sync` flag; other fields kept as sent. */
export const nexusCloudPresenceSchema = z.looseObject({
  observedAt: isoTime.optional(),
  sync: z.object({ enabled: z.boolean() }).optional(),
});

/** `ReplicaRow` (§4.1). */
export const nexusCloudReplicaSchema = z.object({
  projectId: z.string(),
  replicaId: z.string(),
  deviceId: z.string(),
  deviceName: z.string(),
  deviceState: deviceState.optional(),
  attachedAt: isoTime.optional(),
  lastSyncAt: isoTime.nullable(),
  presence: nexusCloudPresenceSchema.nullable(),
  presenceAt: isoTime.nullable(),
});

/** `DeviceCounts` (§4.1): distinct devices holding a replica. */
export const nexusCloudDeviceCountsSchema = z.object({
  active: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

/** The project fields every project view carries (`Project`, §4.1). */
const projectFields = {
  projectId: z.string(),
  label: z.string().nullable(),
  organizationId: z.string(),
  organizationName: z.string().optional(),
  remoteUrl: z.string().nullable().optional(),
  createdAt: isoTime.optional(),
};

/** `ProjectListItem` (§4.1, E13). */
export const nexusCloudProjectListItemSchema = z.object({
  ...projectFields,
  role: z.string(),
  streamId: z.string().optional(),
  headSeq: z.number().int().nonnegative().nullable().optional(),
  openConflicts: z.number().int().nonnegative().optional(),
  replicas: z.array(nexusCloudReplicaSchema).default([]),
  devices: nexusCloudDeviceCountsSchema.optional(),
  replicaCount: z.number().int().nonnegative().optional(),
  lastSyncAt: isoTime.nullable().optional(),
  lastPresenceAt: isoTime.nullable().optional(),
  /** This project's replica list was cut at 50 (T12858). */
  replicasTruncated: z.boolean().default(false),
});

/** `ListProjectsResult` (E13 `GET /v1/projects`), one page. */
export const nexusCloudProjectPageSchema = z.object({
  projects: z.array(nexusCloudProjectListItemSchema),
  nextCursor: z.string().max(512).nullable().default(null),
  /** Anything in the page was cut (the project list or a replica list). */
  truncated: z.boolean().default(false),
  /** The project list itself was cut at 1000 (T12858). */
  projectsTruncated: z.boolean().default(false),
});

/** `ProjectDetail` (E14 `GET /v1/projects/:projectId`). */
export const nexusCloudProjectDetailSchema = z.object({
  project: z.object({ ...projectFields, deletedAt: isoTime.nullable().optional() }),
  role: z.string(),
  canTrash: z.boolean().optional(),
  openConflicts: z.number().int().nonnegative(),
  /** At most 50, oldest attachment first. */
  replicas: z.array(nexusCloudReplicaSchema),
  devices: nexusCloudDeviceCountsSchema,
  replicaCount: z.number().int().nonnegative().optional(),
  lastSyncAt: isoTime.nullable().optional(),
  /** `replicas` was cut at 50. */
  truncated: z.boolean().default(false),
  stream: z
    .object({
      streamId: z.string(),
      headSeq: z.number().int().nonnegative(),
      headCheckpointId: z.string().nullable(),
    })
    .nullable(),
});

/** `ListReplicasResult` (E15 `GET /v1/projects/:projectId/replicas`), one page. */
export const nexusCloudReplicaPageSchema = z.object({
  replicas: z.array(nexusCloudReplicaSchema),
  devices: nexusCloudDeviceCountsSchema.optional(),
  nextCursor: z.string().max(512).nullable().default(null),
  truncated: z.boolean().default(false),
});

// ---------- status (E3, §4.4) ----------

/** E3 check ids, in their contract order (§4.1 `StatusCheckId`). */
export const NEXUS_STATUS_CHECK_IDS = [
  'credential.valid',
  'device.registered',
  'device.active',
  'device.certified',
  'project.registered',
  'project.writable',
  'replica.attached',
  'presence.fresh',
  'replica.synced',
  'conflicts.none',
] as const;

/** One of {@link NEXUS_STATUS_CHECK_IDS}. */
export type NexusStatusCheckId = (typeof NEXUS_STATUS_CHECK_IDS)[number];

/** The server's verdicts (§4.1 `StatusVerdict`). */
export const NEXUS_STATUS_VERDICTS = ['ok', 'attention', 'not-linked', 'not-registered'] as const;

/** `cleo cloud status` verdicts: the server's plus the local `not-signed-in` (§4.4). */
export const CLOUD_STATUS_VERDICTS = [...NEXUS_STATUS_VERDICTS, 'not-signed-in'] as const;

/** One of {@link CLOUD_STATUS_VERDICTS}. */
export type CloudStatusVerdict = (typeof CLOUD_STATUS_VERDICTS)[number];

const knownCheckId = z.enum(NEXUS_STATUS_CHECK_IDS);

/** `StatusCheck` (§4.1). Only required checks drive the verdict. */
export const nexusCloudStatusCheckSchema = z.object({
  id: z.enum(NEXUS_STATUS_CHECK_IDS),
  ok: z.boolean(),
  required: z.boolean(),
  detail: z.string(),
});

/** `NexusStatus` (E3 `GET /v1/status`). */
export const nexusCloudStatusSchema = z.object({
  serverTime: isoTime.optional(),
  apiVersion: z.string().optional(),
  user: nexusCloudUserSchema,
  credential: nexusCloudCredentialSchema,
  device: nexusCloudDeviceSchema.nullable(),
  project: z
    .object({
      projectId: z.string(),
      registered: z.boolean(),
      organizationId: z.string().nullable(),
      organizationName: z.string().nullable(),
      role: z.string().nullable(),
    })
    .nullable(),
  replica: z
    .object({
      replicaId: z.string(),
      attached: z.boolean(),
      attachedElsewhere: z.boolean(),
      attachedAt: isoTime.nullable(),
      lastSyncAt: isoTime.nullable(),
      presenceAt: isoTime.nullable(),
      lastReplicaSeq: z.number().int().nonnegative().nullable().optional(),
    })
    .nullable(),
  stream: z
    .object({
      streamId: z.string(),
      headSeq: z.number().int().nonnegative(),
      headCheckpointId: z.string().nullable(),
      openConflicts: z.number().int().nonnegative(),
      devices: nexusCloudDeviceCountsSchema,
    })
    .nullable(),
  /** Check ids added by a newer server are dropped, never a parse failure. */
  checks: z.array(nexusCloudStatusCheckSchema.extend({ id: z.string() })).transform((list) =>
    list.flatMap((c) => {
      const id = knownCheckId.safeParse(c.id);
      return id.success ? [{ ...c, id: id.data }] : [];
    }),
  ),
  /** A verdict added by a newer server reads as `attention`: never `ok` by accident. */
  verdict: z.enum(NEXUS_STATUS_VERDICTS).catch('attention'),
});

/** Parsed `CredentialInfo`. */
export type NexusCloudCredential = z.infer<typeof nexusCloudCredentialSchema>;
/** Parsed `DeviceView`. */
export type NexusCloudDevice = z.infer<typeof nexusCloudDeviceSchema>;
/** Parsed `Whoami`. */
export type NexusCloudWhoami = z.infer<typeof nexusCloudWhoamiSchema>;
/** Parsed `ReplicaRow`. */
export type NexusCloudReplica = z.infer<typeof nexusCloudReplicaSchema>;
/** Parsed `DeviceCounts`. */
export type NexusCloudDeviceCounts = z.infer<typeof nexusCloudDeviceCountsSchema>;
/** Parsed `ProjectListItem`. */
export type NexusCloudProjectListItem = z.infer<typeof nexusCloudProjectListItemSchema>;
/** Parsed `ProjectDetail`. */
export type NexusCloudProjectDetail = z.infer<typeof nexusCloudProjectDetailSchema>;
/** Parsed `StatusCheck`. */
export type NexusCloudStatusCheck = z.infer<typeof nexusCloudStatusCheckSchema>;
/** Parsed `NexusStatus`. */
export type NexusCloudStatus = z.infer<typeof nexusCloudStatusSchema>;

// ---------- the cloud.* envelope payloads ----------

/** A non-fatal problem a `cleo cloud` read reports next to its data. */
export interface CloudWarning {
  /** Stable code, e.g. `W_NEXUS_STATUS_COMPOSED`. */
  code: string;
  /** Human message (never a secret). */
  message: string;
}

/** How a list read paged through the server's cursors (§4.0.3). */
export interface CloudPaging {
  /** Pages fetched. */
  pages: number;
  /** A server hard ceiling cut a response (`truncated` on any page). */
  truncated: boolean;
  /** The client stopped at its page budget while the server still had a `nextCursor`. */
  pageLimitReached: boolean;
}

/** `cleo cloud whoami` (operation `cloud.whoami`). */
export interface CloudWhoamiResult extends NexusCloudWhoami {
  /** API origin asked. */
  apiUrl: string;
  /** Non-fatal problems (logout retries, upgrades). */
  warnings: CloudWarning[];
}

/** `cleo cloud devices` (operation `cloud.devices.list`). */
export interface CloudDevicesResult {
  /** API origin asked. */
  apiUrl: string;
  /** The `state` filter sent, or `null` for the server default (`active` for device callers). */
  state: NexusDeviceListState | null;
  /** Every device across the pages followed, newest first. */
  devices: NexusCloudDevice[];
  /** `devices.length`. */
  count: number;
  /** Paging facts. */
  paging: CloudPaging;
  /** Non-fatal problems. */
  warnings: CloudWarning[];
}

/** `cleo cloud projects` (operation `cloud.projects.list`). */
export interface CloudProjectsResult {
  /** API origin asked. */
  apiUrl: string;
  /** The organization filter sent, or `null`. */
  organizationId: string | null;
  /** Every project across the pages followed, newest first. */
  projects: NexusCloudProjectListItem[];
  /** `projects.length`. */
  count: number;
  /** Paging facts; `truncated` covers project and replica cuts. */
  paging: CloudPaging & {
    /** The project list itself was cut at the server's ceiling. */
    projectsTruncated: boolean;
  };
  /** Non-fatal problems. */
  warnings: CloudWarning[];
}

/**
 * A replica this device retired: the store file it named was replaced (a
 * vault restore or pull) or rolled back, so a new replica took its place
 * (journal spec §1.5). The server lists it as history until S4's signed
 * `retire` transaction announces it (T13109).
 */
export interface CloudRetiredReplica {
  /** The retired replica id. */
  replicaId: string;
  /** The replica that replaced it. */
  successor: string;
  /** When it was retired on this device. */
  retiredAt: string;
  /** The rebind reason(s), e.g. `vault-restore`; `null` when not recorded. */
  reason: string | null;
}

/** `cleo cloud projects show [<id>]` (operation `cloud.projects.show`). */
export interface CloudProjectShowResult extends NexusCloudProjectDetail {
  /** API origin asked. */
  apiUrl: string;
  /** The project id asked for. */
  projectId: string;
  /** `true` when the id came from the current project rather than the command line. */
  currentProject: boolean;
  /**
   * Paging of the replica list: when E14 cut `replicas` at 50, the rest were
   * fetched from E15 and `replicas` holds them all (up to the page budget).
   */
  replicaPaging: CloudPaging;
  /** Listed replicas this device retired (from its local registry), newest first. */
  retiredHere: CloudRetiredReplica[];
  /** Non-fatal problems. */
  warnings: CloudWarning[];
}

/** `CloudStatusSummary` (§4.4): the facts an agent checks. */
export interface CloudStatusSummary {
  /** A device credential is stored for the origin. */
  signedIn: boolean;
  /** `device.registered` and `device.active` passed. */
  registered: boolean;
  /** The credential's profile. */
  profile: (typeof NEXUS_CLOUD_PROFILES)[number] | null;
  /** The project is registered (and, for the current project, the local link entry exists). */
  linked: boolean;
  /** `replica.attached` passed. */
  replicaAttached: boolean;
  /** Active devices holding this project (`stream.devices.active`). */
  devices: number;
  /** The replica's last presence report. */
  lastPresenceAt: string | null;
  /** The replica's last journal sync. */
  lastSyncAt: string | null;
  /** The project stream's head. */
  headSeq: number | null;
  /** Open conflicts on the project stream. */
  openConflicts: number | null;
}

/** `CloudStatusResult.local` (§4.4): what this machine knows. Locations only, never a secret. */
export interface CloudStatusLocal {
  /** API origin. */
  apiUrl: string;
  /** A device credential is stored for the origin. */
  signedIn: boolean;
  /** This machine's Nexus device id, when enrolled. */
  nexusDeviceId: string | null;
  /** The stored credential's profile. */
  profile: (typeof NEXUS_CLOUD_PROFILES)[number] | null;
  /** The project asked about (`--project`, else the current project), or `null`. */
  projectId: string | null;
  /** The active replica id of the current project's store (read-only; never bound here). */
  replicaId: string | null;
  /**
   * Earlier replicas of the current project's store that this device retired
   * (from its local registry), newest first: the server still lists them.
   */
  retiredReplicas: CloudRetiredReplica[];
  /** `.cleo/nexus-link.json` when it holds an entry for the origin, else `null`. */
  linkPath: string | null;
  /** The device credential store (`nexus-device.json`). */
  credentialsPath: string;
}

/** `CloudStatusResult` (§4.4): the data of the `cloud.status` envelope. */
export interface CloudStatusResult {
  /** The remote verdict, downgraded by local facts the server cannot see. */
  verdict: CloudStatusVerdict;
  /** The facts an agent checks. */
  summary: CloudStatusSummary;
  /** Local state. */
  local: CloudStatusLocal;
  /** E3's answer (or the same shape composed from E2/E14/E15), or `null` when not signed in. */
  remote: NexusCloudStatus | null;
  /** This device's global store on the account's home stream (T12952); absent when not signed in. */
  global?: CloudStatusGlobalStore;
  /** Non-fatal problems. */
  warnings: CloudWarning[];
}

/** `cleo cloud status`: this device's global store (the main brain) on Cleo Nexus (T12952). */
export interface CloudStatusGlobalStore {
  /** The server lists home-stream replicas. */
  supported: boolean;
  /** This device's global store is attached. */
  attached: boolean;
  /** Its replica id. */
  replicaId: string | null;
  /** When its presence was last reported. */
  presenceAt: string | null;
  /** Devices with a global store attached to the account. */
  devices: number;
}

/** `details` of the `E_NEXUS_UNREACHABLE` failure of `cleo cloud status` (§4.4 "Offline"). */
export interface CloudStatusOfflineDetails {
  /** Local state. */
  local: CloudStatusLocal;
  /** The summary with every remote field null or false. */
  summary: CloudStatusSummary;
  /** Warnings collected before the server stopped answering. */
  warnings: CloudWarning[];
}

// ---------- error mapping (§4.0.4) ----------

/** `details.reason` values of a 401 (§4.0.4 `UnauthenticatedReason`). */
export const NEXUS_UNAUTHENTICATED_REASONS = [
  'missing',
  'invalid',
  'credential-revoked',
  'credential-expired',
  'device-signed-out',
  'device-revoked',
  'session-bearer-retired',
  'session-used',
] as const;

/** `details.reason` values of a 403 (§4.0.4 `ForbiddenReason`). */
export const NEXUS_FORBIDDEN_REASONS = [
  'insufficient-scope',
  'session-required',
  'device-required',
  'device-mismatch',
  'not-self',
  'project-role',
  'route-undeclared',
  'bearer-session-required',
  'session-not-fresh',
  'device-limit',
  'device-flow-session-required',
  'device-not-enrolled',
] as const;

/** `details.revokedReason` values of a 401 `credential-revoked` (§4.0.4, v2.11). */
export const NEXUS_REVOKED_REASONS = ['signed-out', 'revoked', 'rotated', 'reenrolled'] as const;

/** One mapped failure. `message: null` keeps the server's message. */
export interface NexusErrorMapping {
  /** The CLI's stable code. */
  readonly code: NexusAccountErrorCode;
  /** The CLI's message, or `null` to report the server's. */
  readonly message: string | null;
  /** The remedy, or `null` to report the server's `details.remedy` (if any). */
  readonly fix: string | null;
}

const LOGIN = 'run `cleo login nexus`';
const COMPROMISED: NexusErrorMapping = {
  code: 'E_NEXUS_CREDENTIAL_COMPROMISED',
  message:
    "this device's credential was replaced or revoked elsewhere, possibly used from another machine",
  fix: 'revoke this device on cleocode.dev and sign in again with `cleo login nexus`',
};
const DEVICE_REVOKED: NexusErrorMapping = {
  code: 'E_NEXUS_DEVICE_REVOKED',
  message: 'this device was revoked',
  fix: 'run `cleo login nexus` to enrol this machine as a new device',
};
const SESSION_EXPIRED_LOGIN: NexusErrorMapping = {
  code: 'E_NEXUS_SESSION_EXPIRED',
  message: 'the session is too old for this request',
  fix: 'run `cleo login nexus` (needs a browser: on a headless machine a human must complete the login)',
};
const SERVER_REFUSED: NexusErrorMapping = {
  code: 'E_NEXUS_REQUEST_FAILED',
  message: null,
  fix: null,
};

/**
 * 401 `credential-revoked`, by `details.revokedReason` (§4.0.4 v2.11). An
 * absent or unknown reason maps as `rotated`: a revocation the CLI cannot
 * explain (R2).
 */
export const NEXUS_REVOKED_REASON_ERRORS: Readonly<
  Record<(typeof NEXUS_REVOKED_REASONS)[number], NexusErrorMapping>
> = {
  reenrolled: {
    code: 'E_NEXUS_NOT_SIGNED_IN',
    message: "this device's credential was replaced by a newer login of the same device",
    fix: LOGIN,
  },
  'signed-out': {
    code: 'E_NEXUS_NOT_SIGNED_IN',
    message: 'this device was signed out and later signed in again with another credential',
    fix: LOGIN,
  },
  revoked: DEVICE_REVOKED,
  rotated: COMPROMISED,
};

/** 401 `E_UNAUTHENTICATED`, by `details.reason` (§4.0.4). Unknown reasons map as `invalid`. */
export const NEXUS_UNAUTHENTICATED_ERRORS: Readonly<
  Record<(typeof NEXUS_UNAUTHENTICATED_REASONS)[number], NexusErrorMapping>
> = {
  missing: {
    code: 'E_NEXUS_NOT_SIGNED_IN',
    message: 'not signed in to Cleo Nexus (the credential is missing or invalid)',
    fix: LOGIN,
  },
  invalid: {
    code: 'E_NEXUS_NOT_SIGNED_IN',
    message: 'not signed in to Cleo Nexus (the credential is missing or invalid)',
    fix: LOGIN,
  },
  // Resolved by `details.revokedReason` through NEXUS_REVOKED_REASON_ERRORS.
  'credential-revoked': COMPROMISED,
  'credential-expired': {
    code: 'E_NEXUS_SESSION_EXPIRED',
    message: 'the device credential expired after 90 days without use',
    fix: LOGIN,
  },
  'device-signed-out': {
    code: 'E_NEXUS_DEVICE_SIGNED_OUT',
    message: 'this device was signed out',
    fix: LOGIN,
  },
  'device-revoked': DEVICE_REVOKED,
  'session-bearer-retired': {
    code: 'E_NEXUS_SESSION_EXPIRED',
    message: 'bearer sessions are no longer accepted',
    fix: 'run `cleo login nexus` with the current CLI',
  },
  'session-used': {
    code: 'E_NEXUS_SESSION_EXPIRED',
    message: 'the 9.24 session was already used by another enrolment',
    fix: LOGIN,
  },
};

/** 403 `E_FORBIDDEN`, by `details.reason` (§4.0.4). Unknown reasons are reported as sent. */
export const NEXUS_FORBIDDEN_ERRORS: Readonly<
  Record<(typeof NEXUS_FORBIDDEN_REASONS)[number], NexusErrorMapping>
> = {
  'insufficient-scope': {
    code: 'E_NEXUS_INSUFFICIENT_SCOPE',
    message: "this device's credential lacks the scope for that request",
    fix: 'run `cleo login nexus` without --read-only to enrol with the full device profile',
  },
  'session-required': SERVER_REFUSED,
  'device-required': SERVER_REFUSED,
  'device-mismatch': SERVER_REFUSED,
  'not-self': SERVER_REFUSED,
  'project-role': SERVER_REFUSED,
  'route-undeclared': SERVER_REFUSED,
  'bearer-session-required': SESSION_EXPIRED_LOGIN,
  'session-not-fresh': SESSION_EXPIRED_LOGIN,
  'device-limit': {
    code: 'E_NEXUS_REQUEST_FAILED',
    message: 'the account has reached its device limit',
    fix: 'revoke unused devices on cleocode.dev, then retry',
  },
  'device-flow-session-required': {
    code: 'E_NEXUS_SESSION_EXPIRED',
    message:
      'this session was not issued to the CLI by `cleo login nexus`, so it cannot enrol a device',
    fix: SESSION_EXPIRED_LOGIN.fix,
  },
  'device-not-enrolled': {
    code: 'E_NEXUS_NOT_SIGNED_IN',
    message: 'this device is not enrolled with Cleo Nexus',
    fix: LOGIN,
  },
};

/**
 * 409 `E_CONFLICT` reasons the CLI reports with their own code (§4.0.4). Every
 * other conflict is either handled inside its flow or reported as
 * `E_NEXUS_REQUEST_FAILED` with the server's message.
 */
export const NEXUS_CONFLICT_ERRORS: Readonly<
  Partial<Record<'replica-copied' | 'rotation-conflict', NexusErrorMapping>>
> = {
  'replica-copied': {
    code: 'E_NEXUS_REPLICA_COPIED',
    message: 'this project store is attached from another device (a copied store)',
    fix: null,
  },
  'rotation-conflict': COMPROMISED,
};

/** No answer at all (network error or timeout, §4.0.4). */
export const NEXUS_UNREACHABLE_ERROR: NexusErrorMapping = {
  code: 'E_NEXUS_UNREACHABLE',
  message: null,
  fix: 'check your network and retry',
};
