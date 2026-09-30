/**
 * Cleo Nexus device logout: `cleo logout nexus [--revoke]` behind
 * `CLEO_NEXUS_DEVICE=1` (cleo-nexus device contract §3.5, review M3, T12844).
 *
 * A logout never reports success while a credential may still be live:
 *
 * 1. Under the lock, the live credentials move into `pendingSignOut`
 *    (`--revoke`: `pendingRevoke`), newest first: `pending`, then `current`
 *    ({@link applyBeginSignOut}, {@link applyBeginRevoke}). From then on they
 *    are used for nothing but that request. The lock is released.
 * 2. E9 (`POST /v1/devices/self/sign-out`) or E10 (`DELETE /v1/devices/self`)
 *    is sent with each credential in turn, newest first, with one attempt and
 *    a {@link NEXUS_REVOKE_TIMEOUT_MS} timeout.
 * 3. Only 200, or 401 `device-signed-out` / `device-revoked`, counts as done
 *    (a revoke accepts only `device-revoked`: a signed-out device is not a
 *    revoked one). A 401 for any other reason means that credential is stale,
 *    so the next one is tried. A network error, timeout, 429, 5xx or a route
 *    the server does not have yet stops and keeps the slot.
 * 4. On a confirmed answer the lock is re-taken and the slot is cleared only
 *    if it still holds the credential that was answered (compare-and-swap). A
 *    confirmed revoke removes this (origin, user) entry, keys included; the
 *    store keeps the file while other entries remain.
 *
 * Unsettled slots, and the `retired` requests of replaced devices, are
 * retried by every later logout and, best effort, by `cleo login nexus` and
 * every command that needs a device credential ({@link settleNexusDeviceEnds}).
 *
 * No function here logs, and no result or error carries a token.
 *
 * @task T12870
 * @epic T12323
 */

import type {
  NexusDeviceEndOutcome,
  NexusDeviceLogoutResult,
  NexusDeviceLogoutRow,
  NexusLogoutResult,
} from '@cleocode/contracts';
import { z } from 'zod';
import { type FetchLike, Http, NexusError } from './http.js';
import { logoutFromNexus, NEXUS_REVOKE_TIMEOUT_MS, resolveNexusApiUrl } from './nexus-auth.js';
import { FileNexusTokenStore, type NexusTokenStore, nexusOriginKey } from './nexus-credentials.js';
import {
  applyBeginRevoke,
  applyBeginSignOut,
  applyRetiredSettled,
  applySignOutConfirmed,
  type NexusDeviceEntry,
  type NexusDeviceSlotCredential,
  NexusDeviceStore,
  UnreadableNexusDevice,
} from './nexus-device.js';

/** Options for {@link logoutNexusDevice} and {@link settleNexusDeviceEnds}. */
export interface NexusDeviceLogoutOptions {
  /** API URL; defaults to `$CLEO_NEXUS_API_URL`, then production. */
  apiUrl?: string;
  /** `fetch` override. */
  fetch?: FetchLike;
  /** The device store; defaults to `<cleoHome>/nexus-device.json`. */
  deviceStore?: NexusDeviceStore;
  /** The 9.24 session store (`nexus-credentials.json`). */
  store?: NexusTokenStore;
  /** Clock, for a slot's `requestedAt`. */
  now?: () => Date;
  /** Timeout of each E9 or E10 call; default {@link NEXUS_REVOKE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Options for {@link logoutNexusDevice}. */
export interface NexusDeviceLogoutRunOptions extends NexusDeviceLogoutOptions {
  /** `--revoke`: hard-revoke the device (E10) instead of signing it out (E9). */
  revoke?: boolean;
}

/** Resolved dependencies. */
interface Ctx {
  readonly apiUrl: string;
  readonly origin: string;
  readonly fetch: FetchLike;
  readonly devices: NexusDeviceStore;
  readonly now: () => Date;
  readonly timeoutMs: number;
}

/** One unsettled request, read from the file. Holds tokens: never print it. */
interface EndRequest {
  readonly userId: string;
  readonly deviceId: string;
  readonly action: 'sign-out' | 'revoke';
  readonly retired: boolean;
  readonly credentials: readonly NexusDeviceSlotCredential[];
}

/** What one credential's call established. */
type CallAnswer = 'done' | 'stale' | 'unanswered';

function context(opts: NexusDeviceLogoutOptions): Ctx {
  const apiUrl = resolveNexusApiUrl(opts.apiUrl);
  return {
    apiUrl,
    origin: nexusOriginKey(apiUrl),
    fetch: opts.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init)),
    devices: opts.deviceStore ?? new NexusDeviceStore(),
    now: opts.now ?? (() => new Date()),
    timeoutMs: opts.timeoutMs ?? NEXUS_REVOKE_TIMEOUT_MS,
  };
}

/** E9 answers `{ deviceId, state }`; E10 answers `{ revoked }`. Only the status matters. */
const endAnswerSchema = z.looseObject({});

/**
 * Send E9 or E10 with one credential: one attempt, a plain timeout, no lock held.
 *
 * @returns `done` for 200 or a 401 reason that proves the device state,
 *   `stale` for any other 401 (this credential is dead, not the device),
 *   `unanswered` for everything else, with the reason in `detail`.
 */
async function callEnd(
  ctx: Ctx,
  action: EndRequest['action'],
  token: string,
): Promise<{ answer: CallAnswer; detail: string }> {
  const timed: FetchLike = (input, init) =>
    ctx.fetch(input, { ...init, signal: AbortSignal.timeout(ctx.timeoutMs) });
  const http = new Http({ baseUrl: ctx.apiUrl, token, fetch: timed, maxAttempts: 1 });
  try {
    if (action === 'sign-out') {
      await http.request('POST', '/v1/devices/self/sign-out', endAnswerSchema, {});
    } else {
      await http.request('DELETE', '/v1/devices/self', endAnswerSchema);
    }
    return { answer: 'done', detail: 'HTTP 200' };
  } catch (err) {
    if (!(err instanceof NexusError)) {
      return { answer: 'unanswered', detail: err instanceof Error ? err.message : String(err) };
    }
    const reason = err.details?.['reason'];
    if (err.status === 401) {
      const proves =
        reason === 'device-revoked' || (action === 'sign-out' && reason === 'device-signed-out');
      return {
        answer: proves ? 'done' : 'stale',
        detail: `HTTP 401 ${typeof reason === 'string' ? reason : err.code}`,
      };
    }
    return {
      answer: 'unanswered',
      detail: err.code === 'E_NETWORK' ? 'no answer' : `HTTP ${err.status} ${err.code}`,
    };
  }
}

/** Every unsettled request of one entry: its own slot first, then its `retired` items. */
function requestsOf(userId: string, entry: NexusDeviceEntry): EndRequest[] {
  const out: EndRequest[] = [];
  const own = entry.pendingRevoke ?? entry.pendingSignOut;
  if (own) {
    out.push({
      userId,
      deviceId: entry.deviceId,
      action: entry.pendingRevoke ? 'revoke' : 'sign-out',
      retired: false,
      credentials: own.credentials,
    });
  }
  for (const r of entry.retired ?? []) {
    out.push({
      userId,
      deviceId: r.deviceId,
      action: r.kind,
      retired: true,
      credentials: r.credentials,
    });
  }
  return out;
}

/** The credentials a request's slot holds now, or `null` when the slot is gone. */
function slotNow(
  entry: NexusDeviceEntry | null,
  req: EndRequest,
): NexusDeviceSlotCredential[] | null {
  if (entry === null) return null;
  if (req.retired) {
    const item = (entry.retired ?? []).find(
      (r) => r.deviceId === req.deviceId && r.kind === req.action,
    );
    return item ? item.credentials : null;
  }
  if (entry.deviceId !== req.deviceId) return null;
  const slot = req.action === 'revoke' ? entry.pendingRevoke : entry.pendingSignOut;
  return slot ? slot.credentials : null;
}

/**
 * Settle a confirmed request under the lock, only if its slot still holds the
 * credential the server answered (CAS).
 *
 * @returns `true` when a confirmed revoke removed the entry.
 */
async function settleConfirmed(ctx: Ctx, req: EndRequest, token: string): Promise<boolean> {
  return ctx.devices.update((tx) => {
    const entry = tx.get(ctx.apiUrl, req.userId);
    const creds = slotNow(entry, req);
    if (entry === null || creds === null || !creds.some((c) => c.token === token)) return false;
    if (req.retired) {
      tx.set(ctx.apiUrl, req.userId, applyRetiredSettled(entry, req.deviceId, req.action));
      return false;
    }
    if (req.action === 'sign-out') {
      tx.set(ctx.apiUrl, req.userId, applySignOutConfirmed(entry));
      return false;
    }
    return tx.delete(ctx.apiUrl, req.userId, {
      deviceId: entry.deviceId,
      credentialId: entry.current?.credentialId ?? null,
    });
  });
}

/** Try each credential of one request, newest first, and settle it when confirmed. */
async function settleRequest(
  ctx: Ctx,
  req: EndRequest,
  warnings: string[],
): Promise<NexusDeviceLogoutRow> {
  const row = (outcome: NexusDeviceEndOutcome, removedLocally = false): NexusDeviceLogoutRow => ({
    userId: req.userId,
    deviceId: req.deviceId,
    action: req.action,
    retired: req.retired,
    outcome,
    removedLocally,
  });
  const what = `${req.action === 'revoke' ? 'revoke' : 'sign-out'} of device ${req.deviceId}`;
  for (const c of req.credentials) {
    const { answer, detail } = await callEnd(ctx, req.action, c.token);
    if (answer === 'done') return row('confirmed', await settleConfirmed(ctx, req, c.token));
    if (answer === 'unanswered') {
      warnings.push(
        `${what} not confirmed (${detail}); it was kept and is retried by the next \`cleo logout nexus\`, \`cleo login nexus\` or cloud command`,
      );
      return row('pending');
    }
  }
  warnings.push(
    `${what} not confirmed: the server refused every credential this machine holds for it; ${req.action === 'revoke' ? 'revoke' : 'sign out or revoke'} this device on cleocode.dev, then run \`cleo logout nexus${req.action === 'revoke' ? ' --revoke' : ''}\` again to confirm it`,
  );
  return row('unconfirmed');
}

/** Every unsettled request on the origin, plus a warning per entry this machine cannot open. */
async function unsettled(ctx: Ctx, warnings: string[]): Promise<EndRequest[]> {
  const out: EndRequest[] = [];
  for (const d of await ctx.devices.list()) {
    if (d.origin !== ctx.origin) continue;
    if (d instanceof UnreadableNexusDevice) {
      warnings.push(
        `the device entry for user ${d.userId}${d.deviceId ? ` (device ${d.deviceId})` : ''} cannot be opened on this machine (${d.reason}); sign it out or revoke it on cleocode.dev`,
      );
      continue;
    }
    out.push(...requestsOf(d.userId, d.unseal()));
  }
  return out;
}

/** Sort rows by user, then device, for a stable envelope. */
function byUserThenDevice(a: NexusDeviceLogoutRow, b: NexusDeviceLogoutRow): number {
  return a.userId.localeCompare(b.userId) || a.deviceId.localeCompare(b.deviceId);
}

/**
 * Retry every unsettled sign-out and revoke on the origin (contract §3.5,
 * L2): each entry's `pendingSignOut` or `pendingRevoke`, and the `retired`
 * requests of devices it replaced. Never throws for a server that cannot be
 * reached; the rows and warnings say what is still open.
 *
 * @param opts - API URL, stores and test overrides.
 * @returns One row per request tried, and the warnings.
 */
export async function settleNexusDeviceEnds(
  opts: NexusDeviceLogoutOptions = {},
): Promise<{ devices: NexusDeviceLogoutRow[]; warnings: string[] }> {
  const ctx = context(opts);
  const warnings: string[] = [];
  const devices: NexusDeviceLogoutRow[] = [];
  for (const req of await unsettled(ctx, warnings)) {
    devices.push(await settleRequest(ctx, req, warnings));
  }
  return { devices: devices.sort(byUserThenDevice), warnings };
}

/**
 * Best-effort {@link settleNexusDeviceEnds} for flows that only retry on the
 * way (login, commands that need a credential): a store or network failure
 * becomes a warning and never fails the caller.
 *
 * @param opts - API URL, stores and test overrides.
 * @param warnings - Receives the warnings.
 */
export async function retryNexusDeviceEnds(
  opts: NexusDeviceLogoutOptions,
  warnings: string[],
): Promise<void> {
  try {
    warnings.push(...(await settleNexusDeviceEnds(opts)).warnings);
  } catch (err) {
    warnings.push(
      `could not retry an unsettled Cleo Nexus sign-out (${err instanceof Error ? err.message : String(err)}); \`cleo logout nexus\` retries it`,
    );
  }
}

/**
 * `cleo logout nexus [--revoke]` with device credentials (contract §3.5, M3).
 *
 * Every readable entry on the origin is moved to `pendingSignOut` (or
 * `pendingRevoke`), then every unsettled request on the origin is sent,
 * including ones left by earlier runs. A leftover 9.24 session for the origin
 * is signed out too. The device keys stay after a sign-out, so a later login
 * reuses the device id; a confirmed revoke removes the entry.
 *
 * @param opts - API URL, `revoke`, stores and test overrides.
 * @returns The per-device outcomes. A row that is not `confirmed` is also
 *   named in `warnings`; the result never claims a sign-out the server did
 *   not confirm.
 * @throws {NexusDeviceStoreError} When the store cannot be read or locked.
 */
export async function logoutNexusDevice(
  opts: NexusDeviceLogoutRunOptions = {},
): Promise<NexusDeviceLogoutResult> {
  const ctx = context(opts);
  const action = opts.revoke === true ? 'revoke' : 'sign-out';
  const begin = action === 'revoke' ? applyBeginRevoke : applyBeginSignOut;
  const begun = await ctx.devices.update((tx) => {
    const notes: string[] = [];
    for (const k of tx.keys()) {
      if (k.origin !== ctx.origin || !k.readable) continue;
      const entry = tx.get(ctx.apiUrl, k.userId);
      if (entry === null) continue;
      const next = begin(entry, ctx.now());
      tx.set(ctx.apiUrl, k.userId, next);
      if (action === 'revoke' && next.pendingRevoke === null) {
        // Already signed out: no credential is left to send E10 with.
        notes.push(
          `device ${next.deviceId} holds no credential, so it cannot be revoked from here; revoke it on cleocode.dev`,
        );
      }
    }
    return [...tx.warnings, ...notes];
  });
  const settled = await settleNexusDeviceEnds({
    ...opts,
    apiUrl: ctx.apiUrl,
    deviceStore: ctx.devices,
  });
  const warnings = [...begun, ...settled.warnings];

  let session: NexusLogoutResult | null = null;
  const sessions = opts.store ?? new FileNexusTokenStore();
  if ((await sessions.get(ctx.apiUrl)) !== null) {
    session = await logoutFromNexus({
      apiUrl: ctx.apiUrl,
      store: sessions,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    warnings.push(...session.warnings);
  }
  return { apiUrl: ctx.apiUrl, action, devices: settled.devices, session, warnings };
}
