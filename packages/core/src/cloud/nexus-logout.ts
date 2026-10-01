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
 * 3. Done means proved: 200, or a 401 whose reason proves the device state
 *    (`device-signed-out`, `device-revoked`, or `credential-revoked` with
 *    `revokedReason` `signed-out` / `revoked`). A revoke needs proof of a
 *    revoke; a signed-out device is not a revoked one. Any other 401 means
 *    that credential is dead, so the next one is tried. A network error,
 *    timeout, 429, 5xx or a route the server does not have yet stops the run:
 *    the slot is kept and every remaining request is left for the next run
 *    without another call.
 * 4. The lock is re-taken and the slot is changed only if it still holds the
 *    credential that was answered (compare-and-swap):
 *    - a sign-out (confirmed, or every credential dead) clears
 *      `pendingSignOut` and keeps the device keys for the next login;
 *    - a revoke that ended (confirmed, found the device signed out, or every
 *      credential dead) forgets the device locally ({@link applyForgetDevice}),
 *      so no later login re-activates the id the user asked to burn. The
 *      entry is deleted, or kept stripped while `retired` requests of other
 *      devices remain; the store keeps the file while other entries remain.
 *    Only a confirmed request is reported `confirmed`; the others name the
 *    web remedy.
 *
 * Unsettled slots, and the `retired` requests of replaced devices, are
 * retried by every later logout and, best effort with a shorter timeout, by
 * `cleo login nexus` and `cleo project link` ({@link retryNexusDeviceEnds}).
 * Retired requests are sent before the entry's own request.
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
  applyForgetDevice,
  applyRetiredSettled,
  applySignOutConfirmed,
  isForgottenDevice,
  type NexusDeviceEntry,
  type NexusDeviceSlotCredential,
  NexusDeviceStore,
  UnreadableNexusDevice,
} from './nexus-device.js';

/**
 * Timeout of each E9/E10 call when a login or a link only retries on the way
 * ({@link retryNexusDeviceEnds}); an explicit logout uses {@link NEXUS_REVOKE_TIMEOUT_MS}.
 */
export const NEXUS_END_RETRY_TIMEOUT_MS = 2_000;

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

/**
 * What one credential's call established. `signed-out` is a revoke's proof
 * that the device is signed out, not revoked: none of its credentials can
 * revoke it any more (contract v2.13 §E10).
 */
type CallAnswer = 'done' | 'signed-out' | 'stale' | 'unanswered';

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
 * What a 401 proves about the device (§4.0.4): `revoked`, `signed-out`, or
 * nothing (`null`: only this credential is dead).
 */
function provenState(
  details: Record<string, unknown> | undefined,
): 'revoked' | 'signed-out' | null {
  const reason = details?.['reason'];
  const revokedReason = details?.['revokedReason'];
  if (reason === 'device-revoked') return 'revoked';
  if (reason === 'device-signed-out') return 'signed-out';
  if (reason === 'credential-revoked' && revokedReason === 'revoked') return 'revoked';
  if (reason === 'credential-revoked' && revokedReason === 'signed-out') return 'signed-out';
  return null;
}

/**
 * Send E9 or E10 with one credential: one attempt, a plain timeout, no lock held.
 *
 * @returns `done` for 200 or a 401 that proves the requested state,
 *   `signed-out` for a revoke that proves only a sign-out, `stale` for any
 *   other 401, `unanswered` for everything else, with the reason in `detail`.
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
    if (err.status === 401) {
      const reason = err.details?.['reason'];
      const detail = `HTTP 401 ${typeof reason === 'string' ? reason : err.code}`;
      const state = provenState(err.details);
      if (state === 'revoked' || (state === 'signed-out' && action === 'sign-out')) {
        return { answer: 'done', detail };
      }
      return { answer: state === 'signed-out' ? 'signed-out' : 'stale', detail };
    }
    return {
      answer: 'unanswered',
      detail: err.code === 'E_NETWORK' ? 'no answer' : `HTTP ${err.status} ${err.code}`,
    };
  }
}

/** Every unsettled request of one entry: its `retired` items first, then its own slot. */
function requestsOf(userId: string, entry: NexusDeviceEntry): EndRequest[] {
  const out: EndRequest[] = [];
  for (const r of entry.retired ?? []) {
    out.push({
      userId,
      deviceId: r.deviceId,
      action: r.kind,
      retired: true,
      credentials: r.credentials,
    });
  }
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

/** How a settle under the lock went. */
interface Settled {
  /** `false` when the slot changed since it was read (CAS miss): nothing was written. */
  readonly applied: boolean;
  /** `true` when the (origin, user) entry was deleted. */
  readonly removed: boolean;
}

/**
 * End a request under the lock, only if its slot still holds `token` (CAS):
 * clear a sign-out slot, settle a retired item, or forget the device after a
 * revoke. An entry left with nothing to keep is deleted.
 */
async function settleEnded(ctx: Ctx, req: EndRequest, token: string): Promise<Settled> {
  return ctx.devices.update((tx) => {
    const entry = tx.get(ctx.apiUrl, req.userId);
    const creds = slotNow(entry, req);
    if (entry === null || creds === null || !creds.some((c) => c.token === token)) {
      return { applied: false, removed: false };
    }
    const next = req.retired
      ? applyRetiredSettled(entry, req.deviceId, req.action)
      : req.action === 'sign-out'
        ? applySignOutConfirmed(entry)
        : applyForgetDevice(entry);
    if (isForgottenDevice(next)) {
      const removed = tx.delete(ctx.apiUrl, req.userId, {
        deviceId: entry.deviceId,
        credentialId: entry.current?.credentialId ?? null,
      });
      return { applied: true, removed };
    }
    tx.set(ctx.apiUrl, req.userId, next);
    return { applied: true, removed: false };
  });
}

/** Try each credential of one request, newest first, and end it when it can be ended. */
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
  const web =
    req.action === 'revoke'
      ? `revoke device ${req.deviceId} on cleocode.dev (Devices)`
      : `sign out or revoke device ${req.deviceId} on cleocode.dev (Devices)`;
  const end = async (token: string, outcome: NexusDeviceEndOutcome, note: string | null) => {
    const settled = await settleEnded(ctx, req, token);
    if (!settled.applied) {
      warnings.push(
        `${what}: the local entry changed while the request was in flight (a login or another logout?); this machine may hold a newer credential. Run \`cleo logout nexus${req.action === 'revoke' ? ' --revoke' : ''}\` again`,
      );
    } else if (note !== null) {
      warnings.push(note);
    }
    return row(outcome, settled.removed);
  };
  for (const c of req.credentials) {
    const { answer, detail } = await callEnd(ctx, req.action, c.token);
    if (answer === 'done') return end(c.token, 'confirmed', null);
    if (answer === 'signed-out') {
      return end(
        c.token,
        'signed-out',
        `device ${req.deviceId} is signed out but not revoked, and a signed-out device's credentials cannot revoke it; this machine forgot the device, so the next login enrols a new one. To burn the old id, ${web}`,
      );
    }
    if (answer === 'unanswered') {
      warnings.push(
        `${what} not confirmed (${detail}); it was kept and is retried by the next \`cleo logout nexus\`, \`cleo login nexus\` or \`cleo project link\``,
      );
      return row('pending');
    }
  }
  // Every credential is dead: retrying can never succeed, so the request ends here.
  const first = req.credentials[0];
  if (first === undefined) return row('unconfirmed');
  return end(
    first.token,
    'unconfirmed',
    `${what} not confirmed: the server refused every credential this machine held for it as no longer valid, so none is live and none was kept${req.action === 'revoke' && !req.retired ? '; this machine forgot the device' : ''}. To make sure, ${web}`,
  );
}

/** Every unsettled request on the origin, plus a warning per entry this machine cannot open. */
async function unsettled(
  ctx: Ctx,
  warnings: string[],
  warnUnreadable: boolean,
): Promise<EndRequest[]> {
  const out: EndRequest[] = [];
  for (const d of await ctx.devices.list()) {
    if (d.origin !== ctx.origin) continue;
    if (d instanceof UnreadableNexusDevice) {
      if (!warnUnreadable) continue;
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
  opts: NexusDeviceLogoutOptions & { warnUnreadable?: boolean } = {},
): Promise<{ devices: NexusDeviceLogoutRow[]; warnings: string[] }> {
  const ctx = context(opts);
  const warnings: string[] = [];
  const devices: NexusDeviceLogoutRow[] = [];
  let unreachable = false;
  for (const req of await unsettled(ctx, warnings, opts.warnUnreadable ?? true)) {
    if (unreachable) {
      // The server already failed to answer in this run: leave the rest for
      // the next run rather than wait out one timeout per request.
      devices.push({
        userId: req.userId,
        deviceId: req.deviceId,
        action: req.action,
        retired: req.retired,
        outcome: 'pending',
        removedLocally: false,
      });
      continue;
    }
    const r = await settleRequest(ctx, req, warnings);
    if (r.outcome === 'pending') unreachable = true;
    devices.push(r);
  }
  const skipped = devices.filter((d) => d.outcome === 'pending').length - 1;
  if (unreachable && skipped > 0) {
    warnings.push(
      `${skipped} more unsettled sign-out or revoke request(s) were not sent because Cleo Nexus did not answer; they are retried next time`,
    );
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
    const settled = await settleNexusDeviceEnds({
      timeoutMs: NEXUS_END_RETRY_TIMEOUT_MS,
      ...opts,
      warnUnreadable: false,
    });
    warnings.push(...settled.warnings);
  } catch (err) {
    warnings.push(
      `could not retry an unsettled Cleo Nexus sign-out (${err instanceof Error ? err.message : String(err)}); \`cleo logout nexus\` retries it`,
    );
  }
}

/**
 * Under the lock, move every readable entry on the origin into its
 * sign-out or revoke slot. A revoke of an entry with no credential left
 * (already signed out) cannot be sent, so the device is forgotten locally
 * and the web remedy is returned.
 *
 * @returns Warnings for the result envelope.
 */
async function beginEnds(ctx: Ctx, action: 'sign-out' | 'revoke'): Promise<string[]> {
  const begin = action === 'revoke' ? applyBeginRevoke : applyBeginSignOut;
  return ctx.devices.update((tx) => {
    const notes: string[] = [];
    for (const k of tx.keys()) {
      if (k.origin !== ctx.origin || !k.readable) continue;
      const entry = tx.get(ctx.apiUrl, k.userId);
      if (entry === null) continue;
      const next = begin(entry, ctx.now());
      if (action === 'revoke' && next.pendingRevoke === null && next.keys !== null) {
        const forgotten = applyForgetDevice(next);
        if (isForgottenDevice(forgotten)) {
          tx.delete(ctx.apiUrl, k.userId, { deviceId: entry.deviceId, credentialId: null });
        } else {
          tx.set(ctx.apiUrl, k.userId, forgotten);
        }
        notes.push(
          `device ${next.deviceId} holds no credential (it is signed out), so it cannot be revoked from here; this machine forgot it, so the next login enrols a new device. To burn the old id, revoke device ${next.deviceId} on cleocode.dev (Devices)`,
        );
        continue;
      }
      tx.set(ctx.apiUrl, k.userId, next);
    }
    return [...tx.warnings, ...notes];
  });
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
 * A device file that cannot be read or locked is reported as a warning, and
 * the 9.24 session is still signed out.
 */
export async function logoutNexusDevice(
  opts: NexusDeviceLogoutRunOptions = {},
): Promise<NexusDeviceLogoutResult> {
  const ctx = context(opts);
  const action = opts.revoke === true ? 'revoke' : 'sign-out';
  const warnings: string[] = [];
  let devices: NexusDeviceLogoutRow[] = [];
  try {
    warnings.push(...(await beginEnds(ctx, action)));
    const settled = await settleNexusDeviceEnds({
      ...opts,
      apiUrl: ctx.apiUrl,
      deviceStore: ctx.devices,
    });
    devices = settled.devices;
    warnings.push(...settled.warnings);
  } catch (err) {
    // A broken device file must not stop the 9.24 session sign-out below.
    warnings.push(
      `the device credentials could not be signed out (${err instanceof Error ? err.message : String(err)}); fix the device file and run \`cleo logout nexus\` again`,
    );
  }

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
  return { apiUrl: ctx.apiUrl, action, devices, session, warnings };
}
