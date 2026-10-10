/**
 * Cloud contract mirrors of cleo-nexus #38 (`DeviceScope`, `StatusQuery`;
 * T13282) and #39 (`GetCheckpointResult`; T13283): the shapes the server
 * validates, so a client that parses with them agrees with it.
 *
 * @task T13282
 * @task T13283
 */

import { describe, expect, it } from 'vitest';
import {
  DeviceScope,
  GetCheckpointResult,
  ListCheckpointsResult,
  StatusQuery,
} from '../cloud/index.js';

const PROJECT = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const REPLICA = '0198a1b2-0000-7000-8000-0000000000a1';

describe('DeviceScope and StatusQuery (T13282)', () => {
  it('DeviceScope is the eight §2.3 scopes and nothing else', () => {
    expect(DeviceScope.options).toEqual([
      'account:read',
      'devices:read',
      'projects:read',
      'projects:write',
      'sync:read',
      'sync:write',
      'keys:read',
      'keys:write',
    ]);
    expect(DeviceScope.safeParse('admin').success).toBe(false);
  });

  it('StatusQuery: both optional, replicaId requires projectId and must be a UUIDv7', () => {
    expect(StatusQuery.safeParse({}).success).toBe(true);
    expect(StatusQuery.safeParse({ projectId: PROJECT }).success).toBe(true);
    expect(StatusQuery.safeParse({ projectId: PROJECT, replicaId: REPLICA }).success).toBe(true);
    const orphan = StatusQuery.safeParse({ replicaId: REPLICA });
    expect(orphan.success).toBe(false);
    expect(orphan.error?.issues[0]?.message).toBe('replicaId requires projectId');
    // A UUIDv4 is not a replica id.
    expect(
      StatusQuery.safeParse({
        projectId: PROJECT,
        replicaId: '0198a1b2-0000-4000-8000-0000000000a1',
      }).success,
    ).toBe(false);
  });
});

describe('GetCheckpointResult (T13283)', () => {
  it('is one checkpoint shaped exactly as a list item', () => {
    const listItem = ListCheckpointsResult.shape.checkpoints.element;
    expect(GetCheckpointResult.shape.checkpoint).toBe(listItem);
    expect(Object.keys(GetCheckpointResult.shape)).toEqual(['checkpoint']);
    expect(GetCheckpointResult.safeParse({ checkpoints: [] }).success).toBe(false);
  });
});
