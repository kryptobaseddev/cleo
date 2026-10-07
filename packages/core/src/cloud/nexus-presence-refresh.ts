/**
 * Keep this machine's cloud presence fresh during normal CLI use (T13289).
 *
 * Presence (`PUT /v1/projects/:id/replicas/:id/presence`) used to be sent only
 * when a project was linked, so `cleo cloud status` reported a linked machine
 * as stale 24 hours later. This refresh piggybacks on ordinary commands: at
 * most once an hour per project, best-effort, with a short timeout, started
 * alongside the command and never awaited by it. No daemon, timer or
 * background process — the cloud features need nothing but the CLI and
 * Cleo Nexus.
 *
 * It only ever sends for a project this machine linked: the link's replica
 * attached from THIS device's credential. Nothing else is read or sent; the
 * body is the same path-free presence the attach sends.
 *
 * @task T13289
 * @epic T12322
 */

import { createHash } from 'node:crypto';
import { mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NexusProjectLink } from '@cleocode/contracts';
import { getCleoHome } from '../paths.js';
import { trackBackgroundOp } from '../store/background-ops.js';
import type { FetchLike } from './http.js';
import { sendProjectPresence } from './nexus-attach.js';
import { isNexusDeviceEnabled, NexusDeviceStore, SealedNexusDevice } from './nexus-device.js';
import { readNexusProjectLinks } from './nexus-link.js';

/** At most one presence refresh per project per hour. */
export const NEXUS_PRESENCE_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/** The refresh's request timeout: short, so a slow network never holds a command up. */
export const NEXUS_PRESENCE_REFRESH_TIMEOUT_MS = 3_000;

/** Environment switch that turns the refresh off (`1`). */
export const NEXUS_PRESENCE_REFRESH_ENV = 'CLEO_DISABLE_PRESENCE_REFRESH';

/** How one refresh attempt ended. */
export type NexusPresenceRefreshOutcome =
  | 'disabled'
  | 'not-linked'
  | 'throttled'
  | 'no-credential'
  | 'sent'
  | 'failed';

/** Options for {@link refreshProjectPresence}. */
export interface RefreshProjectPresenceOptions {
  /** The project root (the CLI passes the resolved current project). */
  projectRoot: string;
  /** CLEO version reported in presence. */
  cliVersion: string;
  /** CLEO home (throttle stamps). @defaultValue getCleoHome() */
  cleoHome?: string;
  /** Clock. */
  now?: () => Date;
  /** `fetch` override. */
  fetch?: FetchLike;
  /** Device store override. */
  deviceStore?: Pick<NexusDeviceStore, 'list'>;
  /** Environment. @defaultValue process.env */
  env?: NodeJS.ProcessEnv;
}

/** The throttle stamp of a project root under the CLEO home. */
function stampPath(cleoHome: string, projectRoot: string): string {
  const key = createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
  return join(cleoHome, 'nexus-presence', `${key}.stamp`);
}

/** A link attached from a device, i.e. one this machine can refresh. */
function attachedLinks(
  projectRoot: string,
): Array<NexusProjectLink & { replicaId: string; nexusDeviceId: string }> {
  return readNexusProjectLinks(projectRoot).links.filter(
    (l): l is NexusProjectLink & { replicaId: string; nexusDeviceId: string } =>
      typeof l.replicaId === 'string' &&
      l.replicaId !== '' &&
      typeof l.nexusDeviceId === 'string' &&
      l.nexusDeviceId !== '',
  );
}

/**
 * Refresh the cloud presence of this machine's linked project once, if due.
 * Never throws: every failure is an outcome. The throttle stamp is written
 * before the request, so a failing network is retried an hour later, not on
 * every command.
 *
 * @param opts - Project root, CLI version and overrides.
 * @returns How it ended.
 */
export async function refreshProjectPresence(
  opts: RefreshProjectPresenceOptions,
): Promise<NexusPresenceRefreshOutcome> {
  try {
    const env = opts.env ?? process.env;
    if (env[NEXUS_PRESENCE_REFRESH_ENV] === '1' || !isNexusDeviceEnabled(env)) return 'disabled';
    const links = attachedLinks(opts.projectRoot);
    if (links.length === 0) return 'not-linked';
    const now = (opts.now ?? (() => new Date()))();
    const stamp = stampPath(opts.cleoHome ?? getCleoHome(), opts.projectRoot);
    try {
      if (now.getTime() - statSync(stamp).mtimeMs < NEXUS_PRESENCE_REFRESH_INTERVAL_MS) {
        return 'throttled';
      }
    } catch {
      // No stamp yet: due.
    }
    mkdirSync(join(stamp, '..'), { recursive: true });
    writeFileSync(stamp, now.toISOString());
    utimesSync(stamp, now, now);

    // The device file is unsealed with the machine key and global salt under
    // the CLEO home: plain 0600 files, no OS keychain and no child process, so
    // this background read can never raise a prompt (T13308).
    const devices = await (opts.deviceStore ?? new NexusDeviceStore()).list();
    // Every origin at once, so a project linked to several Nexus origins still
    // costs at most one timeout at teardown (T13308). `currentBearer()` only, as
    // every other request: a pending rotation token may not be known to the
    // server yet, and falling back would cost a second request.
    const sends = links.flatMap((link) => {
      const origin = new URL(link.apiUrl).origin;
      const device = devices.find(
        (d): d is SealedNexusDevice =>
          d instanceof SealedNexusDevice &&
          d.origin === origin &&
          d.deviceId === link.nexusDeviceId,
      );
      const bearer = device?.currentBearer() ?? null;
      if (device === undefined || bearer === null) return [];
      return [
        sendProjectPresence({
          apiUrl: link.apiUrl,
          bearer,
          deviceId: device.deviceId,
          projectId: link.remoteProjectId,
          projectRoot: opts.projectRoot,
          replicaId: link.replicaId,
          cliVersion: opts.cliVersion,
          timeoutMs: NEXUS_PRESENCE_REFRESH_TIMEOUT_MS,
          ...(opts.now ? { now: opts.now } : {}),
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
        }),
      ];
    });
    if (sends.length === 0) return 'no-credential';
    const settled = await Promise.allSettled(sends);
    const outcome: NexusPresenceRefreshOutcome = settled.some((r) => r.status === 'fulfilled')
      ? 'sent'
      : 'failed';
    return outcome;
  } catch {
    return 'failed';
  }
}

/**
 * Start {@link refreshProjectPresence} in the background, alongside the
 * command, without awaiting it: registered with the background-op registry
 * so the CLI's teardown can drain it within its deadline instead of
 * abandoning a half-sent request.
 *
 * @param opts - As for {@link refreshProjectPresence}.
 */
export function startProjectPresenceRefresh(opts: RefreshProjectPresenceOptions): void {
  void trackBackgroundOp(() => refreshProjectPresence(opts));
}
