/**
 * `cleo cloud activity`: what this account's devices did on Cleo Nexus and
 * when (snapshots pushed or refused, leases taken, forced or released,
 * projects linked, devices enrolled or signed out), newest first.
 *
 * Reads E18 `GET /v1/account/activity` (the caller's own events) with the
 * device credential and names each device from the account's device list.
 * `--project` keeps the events whose target is that project or its stream.
 *
 * @task T12951
 * @epic T12323
 */

import type { CloudActivityResult } from '@cleocode/contracts';
import { nexusActivityPageSchema, nexusCloudDevicePageSchema } from '@cleocode/contracts';
import type { z } from 'zod';
import { connectNexusCloud, type NexusCloudOptions, nexusQueryPath } from './nexus-cloud.js';

/** Largest page `GET /v1/account/activity` serves. */
export const NEXUS_ACTIVITY_PAGE_MAX = 200;

/** Options of {@link nexusCloudActivity}. */
export interface NexusCloudActivityOptions extends NexusCloudOptions {
  /** Events to return (1..200, default 50). */
  limit?: number;
  /** Page before this event id (from a previous `nextBefore`). */
  before?: string;
  /** Keep only events about this server project id. */
  projectId?: string;
  /** Keep only events by this device id. */
  deviceId?: string;
  /** Pages to follow while filling `limit` under a filter; default 5. */
  maxPages?: number;
}

/**
 * List this account's recent cloud activity.
 *
 * @param opts - Paging, project filter and overrides.
 * @returns Events newest first, each with its device's name.
 */
export async function nexusCloudActivity(
  opts: NexusCloudActivityOptions = {},
): Promise<CloudActivityResult> {
  const conn = await connectNexusCloud(opts);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), NEXUS_ACTIVITY_PAGE_MAX);
  const project = opts.projectId;
  const about = (target: string | null | undefined) =>
    project === undefined ||
    (typeof target === 'string' &&
      (target === `project:${project}` ||
        target.endsWith(`:${project}`) ||
        target.includes(project)));
  const wanted = (e: { target?: string | null; actorDeviceId?: string | null }) =>
    about(e.target) && (opts.deviceId === undefined || e.actorDeviceId === opts.deviceId);
  // Follow `nextBefore` until `limit` matching events are found, the server
  // has no more, or the page budget is spent.
  const events: Array<z.infer<typeof nexusActivityPageSchema>['events'][number]> = [];
  let before = opts.before;
  let nextBefore: string | null = null;
  for (let pageNo = 0; pageNo < (opts.maxPages ?? 5); pageNo++) {
    const page = await conn.get(
      nexusQueryPath('/v1/account/activity', { limit: String(NEXUS_ACTIVITY_PAGE_MAX), before }),
      nexusActivityPageSchema,
    );
    for (const e of page.events) {
      if (events.length < limit && wanted(e)) events.push(e);
    }
    nextBefore =
      page.nextBefore === null || page.nextBefore === undefined ? null : String(page.nextBefore);
    if (events.length >= limit || nextBefore === null) break;
    before = nextBefore;
  }
  // Stopped inside a page: the next page starts after the last event returned.
  const last = events.at(-1);
  if (events.length >= limit && last !== undefined) nextBefore = String(last.id);
  let names = new Map<string, string>();
  try {
    const devices = await conn.get('/v1/devices?limit=100', nexusCloudDevicePageSchema);
    names = new Map(devices.devices.map((d) => [d.deviceId, d.name]));
  } catch {
    // Names are a convenience; ids are still shown.
  }
  return {
    apiUrl: conn.apiUrl,
    projectId: project ?? null,
    items: events.map((e) => ({
      at: e.at,
      action: e.action,
      target: e.target ?? null,
      deviceId: e.actorDeviceId ?? null,
      deviceName: e.actorDeviceId ? (names.get(e.actorDeviceId) ?? null) : null,
      thisDevice: e.actorDeviceId === conn.device.deviceId,
    })),
    nextBefore,
    warnings: conn.warnings,
  };
}
