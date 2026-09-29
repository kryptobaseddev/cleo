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
  'E_NEXUS_DEVICE_CODE_EXPIRED',
  'E_NEXUS_ACCESS_DENIED',
  'E_NEXUS_DEVICE_CODE_FAILED',
  'E_NEXUS_REVOKE_FAILED',
  'E_NEXUS_REQUEST_FAILED',
  'E_NEXUS_NOT_A_PROJECT',
  'E_NEXUS_INVALID_LABEL',
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
 * The binding of a local CLEO project to its Nexus registration, persisted in
 * the project's machine-local `.cleo/nexus-link.json`, keyed by API origin.
 */
export interface NexusProjectLink {
  /** API origin the project is registered with. */
  apiUrl: string;
  /** The local CLEO project id (`.cleo/project-info.json`). */
  localProjectId: string;
  /** The project id the server returned (the server keys projects by the CLEO id). */
  remoteProjectId: string;
  /** Owning organization id. */
  organizationId: string;
  /** Plaintext label sent to the server, or `null` when none was sent. */
  label: string | null;
  /** Journal stream id for the project. */
  streamId: string;
  /** ISO time of the last successful link. */
  linkedAt: string;
}

/** Result of `cleo project link`. */
export interface NexusProjectLinkResult {
  /** The persisted binding. */
  link: NexusProjectLink;
  /**
   * `true` when this project was already bound to the same remote project on
   * this API origin (a repeat link). Linking is idempotent either way.
   */
  alreadyLinked: boolean;
  /** Absolute path of the local binding file. */
  linkPath: string;
}
