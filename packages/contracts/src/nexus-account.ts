/**
 * Cleo Nexus account contracts: the CLI's signed-in session with the Cleo
 * Nexus API (device-code login, logout, status, project link).
 *
 * The API is a better-auth app: the device-code grant (RFC 8628) issues a
 * session token that the bearer plugin accepts on every `/v1` route. These
 * types describe what CLEO emits and persists about that session. None of
 * them carries the token: results and status rows are secret-free by
 * construction, so they are safe in LAFS envelopes and logs.
 *
 * Not part of `./cloud`: that directory mirrors the server's
 * `@cleo-nexus/shared` contract one-to-one. The `/v1/account/me` subset
 * below is read-only and client-side.
 *
 * This file is types + zod schemas + const data only (arch gate 10).
 *
 * @task T12712
 * @epic T12322
 */

import { z } from 'zod';

/** Production Cleo Nexus API origin. */
export const NEXUS_DEFAULT_API_URL = 'https://api.cleocode.dev';

/** The OAuth client id the Nexus API accepts for the device-code grant. */
export const NEXUS_CLI_CLIENT_ID = 'cleo-cli';

/**
 * The reserved `cleo login` target for a Cleo Nexus account. It is checked
 * before the LLM provider registry, so no provider can shadow it.
 */
export const NEXUS_LOGIN_TARGET = 'nexus';

/** Stable error codes of the Nexus account flows. */
export const NEXUS_ACCOUNT_ERROR_CODES = [
  'E_NEXUS_INVALID_API_URL',
  'E_NEXUS_NOT_SIGNED_IN',
  'E_NEXUS_SESSION_EXPIRED',
  'E_NEXUS_DEVICE_CODE_START_FAILED',
  'E_NEXUS_UNTRUSTED_VERIFICATION_URI',
  'E_NEXUS_DEVICE_CODE_EXPIRED',
  'E_NEXUS_ACCESS_DENIED',
  'E_NEXUS_DEVICE_CODE_FAILED',
  'E_NEXUS_REVOKE_FAILED',
  'E_NEXUS_REQUEST_FAILED',
  'E_NEXUS_NOT_A_PROJECT',
  'E_NEXUS_INVALID_LABEL',
  // Device credentials (cleo-nexus device contract §3.3, §4.0.4; T12868).
  /** No answer from the API (network error or timeout). */
  'E_NEXUS_UNREACHABLE',
  /** `cleo login nexus` while a revoke of this device is unconfirmed (§3.3, v2.9). */
  'E_NEXUS_REVOKE_PENDING',
  /** The device was signed out (E9, E11): 401 `device-signed-out`. */
  'E_NEXUS_DEVICE_SIGNED_OUT',
  /** The device was revoked (E10, E12): 401 `device-revoked`. */
  'E_NEXUS_DEVICE_REVOKED',
  /** A credential replaced or revoked elsewhere, or a `rotation-conflict` (R2). */
  'E_NEXUS_CREDENTIAL_COMPROMISED',
  /** The device credential lacks the scope (a read-only device): 403 `insufficient-scope`. */
  'E_NEXUS_INSUFFICIENT_SCOPE',
  /** A replica attach from a second device: 409 `replica-copied`. */
  'E_NEXUS_REPLICA_COPIED',
  /** Another cleo process holds the device file or an upgrade in flight; retry. */
  'E_NEXUS_BUSY',
  /** Several accounts hold a device credential on one origin and none was named. */
  'E_NEXUS_ACCOUNT_AMBIGUOUS',
  /** An option that needs device credentials (`--read-only`) with `CLEO_NEXUS_DEVICE=0`. */
  'E_NEXUS_DEVICE_REQUIRED',
  /** `.cleo/nexus-link.json` is in a format this CLEO cannot update (written by a newer CLEO). */
  'E_NEXUS_LINK_FILE_UNSUPPORTED',
  // Cloud vault (encrypted snapshots, T12336 / T12337 / T12338).
  /** Another device holds this stream's write lease (`--force` takes it and labels a fork). */
  'E_NEXUS_VAULT_LEASE_HELD',
  /** Another device pushed a newer snapshot than this machine last pushed or restored: pull first. */
  'E_NEXUS_VAULT_BEHIND',
  /** Local data changed since the last push or restore; pulling would overwrite it. */
  'E_NEXUS_VAULT_LOCAL_CHANGES',
  /** A snapshot's counts or hashes do not match its manifest; nothing was activated. */
  'E_NEXUS_VAULT_VERIFY_FAILED',
  /** The account encryption key could not be obtained for this device. */
  'E_NEXUS_VAULT_KEY_UNAVAILABLE',
  /** The project is not linked to Cleo Nexus (`cleo project link`). */
  'E_NEXUS_VAULT_NOT_LINKED',
  /** The cloud holds no snapshot to restore. */
  'E_NEXUS_VAULT_EMPTY',
  /**
   * The Cleo Nexus server predates account key escrow (cleo-nexus T082), so it cannot hold a
   * vault (T13049). Nothing was written.
   */
  'E_NEXUS_VAULT_UNSUPPORTED',
  /** The server refused the snapshot (lineage or regression check). */
  'E_NEXUS_VAULT_REFUSED',
  /**
   * The stream moved past what this CLEO's vault writes (T13034): it takes only checkpoint/v3
   * snapshots (the server's `E_STREAM_VERSION`), or it holds data of a newer sync schema.
   * Pull, restore and verify still work; nothing was written.
   */
  'E_NEXUS_VAULT_STREAM_UPGRADED',
  /** Another CLEO process is writing to the store a restore would replace. */
  'E_NEXUS_VAULT_STORE_BUSY',
  /** A project restore target already holds a different project. */
  'E_NEXUS_VAULT_TARGET_OCCUPIED',
  // Change-journal push (`cleo sync enable push`, T12343 S4-1b).
  /** The store is not fit to reach genesis (a precondition failed); nothing was cut. */
  'E_NEXUS_SYNC_REFUSED',
  /** Another device already started this stream's change journal: this store joins it by pulling. */
  'E_NEXUS_SYNC_STREAM_JOURNALED',
  // Projects by name (`cleo cloud restore <name>`, T13102).
  /** No project of the account has that name, label or id. */
  'E_NEXUS_PROJECT_NOT_FOUND',
  /** Several of the account's projects have that name or label; the error lists them. */
  'E_NEXUS_PROJECT_AMBIGUOUS',
] as const;

/** One of {@link NEXUS_ACCOUNT_ERROR_CODES}. */
export type NexusAccountErrorCode = (typeof NEXUS_ACCOUNT_ERROR_CODES)[number];

/** The signed-in user, as `/v1/account/me` reports it. */
export const nexusAccountUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable().optional(),
});

/** A user's organization membership, as `/v1/account/me` reports it. */
export const nexusAccountOrganizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string().nullable().optional(),
  role: z.string().optional(),
  /** `true` for the personal organization created at sign-up. */
  personal: z.boolean().optional(),
});

/**
 * The subset of `GET /v1/account/me` the CLI reads. Unknown fields are
 * ignored (zod strips them), so the server can grow the payload freely.
 */
export const nexusAccountMeSchema = z.object({
  user: nexusAccountUserSchema,
  organizations: z.array(nexusAccountOrganizationSchema).default([]),
});

/** Parsed `GET /v1/account/me` subset. */
export type NexusAccountMe = z.infer<typeof nexusAccountMeSchema>;

/** A signed-in user (no secrets). */
export type NexusAccountUser = z.infer<typeof nexusAccountUserSchema>;

/** An organization reference (no secrets). */
export type NexusAccountOrganization = z.infer<typeof nexusAccountOrganizationSchema>;

/**
 * Session state for one API origin.
 *
 * - `signed-in`      — a token is stored and, when checked live, the API accepted it.
 * - `unverified`     — a token is stored but the API could not be reached.
 * - `expired`        — the API answered 401: the session expired or was revoked.
 * - `not-signed-in`  — no token is stored for the origin.
 */
export type NexusSessionState = 'signed-in' | 'unverified' | 'expired' | 'not-signed-in';

/** Secret-free status row for `cleo status` and `cleo auth list`. */
export interface NexusAccountStatus {
  /** API origin the row describes, e.g. `https://api.cleocode.dev`. */
  apiUrl: string;
  /** Session state. */
  state: NexusSessionState;
  /** Signed-in user's email, when known. */
  email: string | null;
  /** Primary organization (the personal one, else the first), when known. */
  organization: string | null;
  /** ISO time the stored token expires, when the server said so. */
  expiresAt: string | null;
  /** One human line: "signed in as a@b.c (Org)", "session expired", "not signed in". */
  summary: string;
}

/** The enrolled device, as `cleo login nexus` reports it (device contract §3.3 step 10). */
export interface NexusLoginDevice {
  /** The Nexus device id (UUIDv7, scoped to this CLEO home, origin and user). */
  deviceId: string;
  /** Display name the server holds. */
  name: string;
  /** Server-side state (`active` right after a login). */
  state: string;
  /** Credential profile: `device` or `read-only`. */
  profile: string | null;
  /** `true` when E1 created the device row, `false` when it re-enrolled it. */
  created: boolean | null;
}

/**
 * A step of the account setup `cleo login nexus` runs right after enrolment
 * (T13100), named when it fails:
 *
 * - `connect`: open the vault connection with the new device credential;
 * - `escrow-read`: read the escrowed account master key (`GET /v1/account/keys/escrow`);
 * - `escrow-mint`: on the account's first device, create the master key and escrow it
 *   (`PUT /v1/account/keys/escrow`; a 409 means another device won, and its key is read);
 * - `certify`: certify this device under the master key (`PUT /v1/devices/:id/key`);
 * - `trust`: evaluate and record the signer trust state (`GET /v1/devices/trust`,
 *   `<cleoHome>/nexus-vault.json`).
 */
export type NexusAccountSetupStep = 'connect' | 'escrow-read' | 'escrow-mint' | 'certify' | 'trust';

/**
 * What `cleo login nexus` did to make the account ready for encrypted backups
 * (T13100). Holds no key.
 *
 * - `ready`: this device holds the account master key and is certified under it;
 * - `unsupported`: the server has no account key escrow; the login still succeeded;
 * - `skipped`: a read-only device, which never mints or certifies;
 * - `failed`: the login succeeded but the setup did not; `step` and `fix` say where and what to do.
 */
export type NexusAccountSetup =
  | {
      status: 'ready';
      /**
       * `fetched`: the escrowed key was opened; `minted`: this device created and escrowed it;
       * `adopted`: another device escrowed first (409) and its key was read, never re-minted.
       */
      escrow: 'fetched' | 'minted' | 'adopted';
      /** `new`: this login certified the device; `existing`: it already was. */
      certificate: 'new' | 'existing';
      /** Version of the account master key. */
      keyVersion: number;
      /** One human line. */
      summary: string;
    }
  | {
      status: 'unsupported';
      /** `E_NEXUS_VAULT_UNSUPPORTED`. */
      code: NexusAccountErrorCode;
      /** The remedy. */
      fix: string;
      /** One human line. */
      summary: string;
    }
  | {
      status: 'skipped';
      /** One human line. */
      summary: string;
    }
  | {
      status: 'failed';
      /** The step that failed. */
      step: NexusAccountSetupStep;
      /** Stable error code (a {@link NexusAccountErrorCode} when the flow raised one). */
      code: string;
      /** What went wrong. */
      message: string;
      /** The remedy. */
      fix: string;
      /** One human line naming the step and the remedy. */
      summary: string;
    };

/** Result of `cleo login nexus` (never carries the token). */
export interface NexusLoginResult {
  /** API origin the session belongs to. */
  apiUrl: string;
  /** The signed-in user, when `/v1/account/me` answered. */
  user: NexusAccountUser | null;
  /** Primary organization, when known. */
  organization: NexusAccountOrganization | null;
  /** ISO time the token expires, when the server said so. */
  expiresAt: string | null;
  /** Absolute path of the credential store the token was written to. */
  credentialsPath: string;
  /** Non-fatal problems, e.g. the account lookup failed after a good login. */
  warnings: string[];
  /** The enrolled device; present only with device credentials (the default; off with `CLEO_NEXUS_DEVICE=0`). */
  device?: NexusLoginDevice;
  /** Scopes of the stored device credential; present only with device credentials. */
  scopes?: string[];
  /** The account key setup run right after enrolment (T13100); present only with device credentials. */
  account?: NexusAccountSetup;
}

/** Result of `cleo logout nexus`. */
export interface NexusLogoutResult {
  /** API origin the session belonged to. */
  apiUrl: string;
  /** `true` when a stored token existed and was deleted locally. */
  removedLocally: boolean;
  /**
   * Server-side revocation outcome: `revoked` (the API ended the session),
   * `already-invalid` (the API reported it was already gone), `failed`
   * (network or server error: the local token is deleted anyway), or
   * `skipped` (nothing was stored).
   */
  revocation: 'revoked' | 'already-invalid' | 'failed' | 'skipped';
  /** Non-fatal problems. */
  warnings: string[];
}

/**
 * What happened to one device's sign-out (E9) or revoke (E10) in
 * `cleo logout nexus [--revoke]` with device credentials (the default; `CLEO_NEXUS_DEVICE=0` turns them off) (cleo-nexus
 * device contract §3.5, M3). Holds no secret.
 *
 * - `confirmed`: the server answered 200, or 401 `device-signed-out` /
 *   `device-revoked` (a revoke accepts only `device-revoked`);
 * - `pending`: no usable answer (network, timeout, 429, 5xx, or a route the
 *   server does not have yet); the credentials stay in their slot and the
 *   next `cleo logout nexus`, `cleo login nexus` or cloud command retries;
 * - `unconfirmed`: every credential held was refused as stale, so the CLI
 *   cannot finish it; the slot is kept, and a sign-out or revoke of the
 *   device on cleocode.dev lets the next retry confirm it;
 * - `signed-out`: a revoke found the device already signed out (E10 401
 *   `device-signed-out`). Its credentials are dead, so the CLI cannot revoke
 *   it; the revoke slot is cleared (never retried) and the device must be
 *   revoked on cleocode.dev.
 */
export type NexusDeviceEndOutcome = 'confirmed' | 'pending' | 'unconfirmed' | 'signed-out';

/** One device row of a {@link NexusDeviceLogoutResult}. */
export interface NexusDeviceLogoutRow {
  /** Nexus user id of the entry. */
  userId: string;
  /** The device the request ended. */
  deviceId: string;
  /** `sign-out` (E9) or `revoke` (E10). */
  action: 'sign-out' | 'revoke';
  /** `true` for a replaced device's leftover request retried from `retired`. */
  retired: boolean;
  /** Server-side outcome. */
  outcome: NexusDeviceEndOutcome;
  /** `true` when a confirmed revoke removed the (origin, user) entry from `nexus-device.json`. */
  removedLocally: boolean;
}

/** Result of `cleo logout nexus [--revoke]` with device credentials. Holds no secret. */
export interface NexusDeviceLogoutResult {
  /** API origin. */
  apiUrl: string;
  /** `sign-out` or `revoke` (`--revoke`). */
  action: 'sign-out' | 'revoke';
  /** One row per device request settled or retried in this run, sorted by user then device. */
  devices: NexusDeviceLogoutRow[];
  /** The 9.24 session sign-out, when a leftover session was found for the origin. */
  session: NexusLogoutResult | null;
  /** Non-fatal problems: every non-`confirmed` row is named here. */
  warnings: string[];
}

/**
 * The binding of a local CLEO project to its Nexus registration, persisted in
 * the project's machine-local `.cleo/nexus-link.json`, keyed by API origin.
 */
export interface NexusProjectLink {
  /** API origin the project is registered with. */
  apiUrl: string;
  /** The local CLEO project id (the tracked `.cleo/project-id`). */
  localProjectId: string;
  /** The project id the server returned (the server keys projects by the CLEO id). */
  remoteProjectId: string;
  /** Owning organization id. */
  organizationId: string;
  /** Plaintext display-name label the server holds, or `null` when it has none. */
  label: string | null;
  /** Journal stream id for the project. */
  streamId: string;
  /** ISO time of the last successful link. */
  linkedAt: string;
  /**
   * This store's replica id as attached on the server (device contract
   * §3.6, §3.7). A cache, not the source of truth: the store's active
   * `_sync_replica` row is. Absent before the first device-credential link.
   */
  replicaId?: string;
  /** The Nexus device id that attached {@link NexusProjectLink.replicaId}. */
  nexusDeviceId?: string;
  /** ISO time the replica was last attached or confirmed. */
  attachedAt?: string;
}

/**
 * What `cleo project link` did for this machine's copy of the project with a
 * device credential (contract §3.6 steps 3 to 5). Holds no path or secret.
 */
export interface NexusReplicaAttachment {
  /** The store's replica id (UUIDv7), now attached on the server. */
  replicaId: string;
  /** The Nexus device that holds it. */
  deviceId: string;
  /** The retired replica id when this link rebound the store (a copy, or a re-enrolled device). */
  reboundFrom: string | null;
  /** Server time the presence report was received, or `null` when sending it failed (see warnings). */
  presenceAt: string | null;
}

/** Result of `cleo project link`. */
export interface NexusProjectLinkResult {
  /** The persisted binding. */
  link: NexusProjectLink;
  /**
   * `true` when the server already had this project id (HTTP 200; its label
   * was updated to the one sent), `false` when this call registered it (201).
   * Linking is idempotent either way.
   */
  alreadyLinked: boolean;
  /** Absolute path of the local binding file. */
  linkPath: string;
  /**
   * The replica attach and presence report, with device credentials; `null`
   * with the 9.24 session (`CLEO_NEXUS_DEVICE=0`), which cannot attach.
   */
  replica: NexusReplicaAttachment | null;
  /**
   * Why this machine's copy was not attached, when device mode tried and
   * failed (for example `E_NEXUS_REPLICA_COPIED`); `null` otherwise. The same
   * text is also in {@link NexusProjectLinkResult.warnings}.
   */
  attachError: { code: string; message: string; fix: string | null } | null;
  /**
   * The project data key version the server holds from this registration
   * (onboarding B): `1` when the link sent a new project's first key with it,
   * `null` when it sent none (the project already existed, the server does
   * not take keys at registration, or this device has no account key; see
   * {@link NexusProjectLinkResult.warnings}). With `null`, the first
   * `cleo cloud push` creates the key.
   */
  initialKeyVersion: number | null;
  /** Non-fatal problems (for example, presence could not be sent). */
  warnings: string[];
}
