/**
 * Cloud contract mirror of cleo-nexus #41 (T123 replica retirement, contract
 * v2.28; T13284): the E31 request and answer, the stored retirement, and the
 * `retiredAt` / `successor` fields home replicas gain, as the server validates
 * them.
 *
 * @task T13284
 */

import { describe, expect, it } from 'vitest';
import {
  AttachHomeReplicaResult,
  HomeReplica,
  ListHomeReplicasResult,
  ReplicaRetirement,
  RetireReplicaRequest,
  RetireReplicaResult,
} from '../cloud/index.js';
import { NEXUS_REPLICA_RETIREMENT_REASONS } from '../nexus-vault.js';

const DEVICE = '0192f1c2-7d3e-4abc-8def-0000000000b0';
const R1 = '0192f1c2-7d3e-7abc-8def-0000000000a1';
const R2 = '0192f1c2-7d3e-7abc-8def-0000000000b1';
const STREAM = 'project:0192f1c2-7d3e-7abc-8def-0123456789ab';
const SIG = Buffer.alloc(64, 7).toString('base64');

const request = {
  deviceId: DEVICE,
  successor: R2,
  lastReplicaSeq: 4,
  txnId: `${R1}:17`,
  signature: SIG,
};

describe('RetireReplicaRequest (T13284)', () => {
  it('takes a successor, lastReplicaSeq and txn id, each nullable', () => {
    expect(RetireReplicaRequest.safeParse(request).success).toBe(true);
    expect(
      RetireReplicaRequest.safeParse({
        ...request,
        successor: null,
        lastReplicaSeq: null,
        txnId: null,
      }).success,
    ).toBe(true);
  });

  it('refuses a negative or fractional lastReplicaSeq and a malformed txn id', () => {
    expect(RetireReplicaRequest.safeParse({ ...request, lastReplicaSeq: -1 }).success).toBe(false);
    expect(RetireReplicaRequest.safeParse({ ...request, lastReplicaSeq: 1.5 }).success).toBe(false);
    for (const txnId of [
      R1,
      `${R1}:`,
      `${R1}:01`,
      `${R1}:-1`,
      `not-a-uuid:3`,
      `${R1}:12345678901234567`,
    ]) {
      expect(RetireReplicaRequest.safeParse({ ...request, txnId }).success).toBe(false);
    }
    // Any UUID may emit the transaction (the successor on a rebind), not only a v7 replica id.
    expect(RetireReplicaRequest.safeParse({ ...request, txnId: `${DEVICE}:0` }).success).toBe(true);
  });

  it('a successor must be a replica id (UUIDv7)', () => {
    expect(RetireReplicaRequest.safeParse({ ...request, successor: DEVICE }).success).toBe(false);
  });
});

describe('ReplicaRetirement and RetireReplicaResult (T13284)', () => {
  const stored = {
    streamId: STREAM,
    replicaId: R1,
    successor: R2,
    lastReplicaSeq: null,
    signerDeviceId: DEVICE,
    txnId: null,
    signature: SIG,
    retiredAt: '2026-10-06T07:00:00.000Z',
  };

  it('is the stored record, wrapped as { retirement }', () => {
    expect(ReplicaRetirement.safeParse(stored).success).toBe(true);
    expect(RetireReplicaResult.safeParse({ retirement: stored }).success).toBe(true);
    expect(RetireReplicaResult.safeParse(stored).success).toBe(false);
    const { retiredAt: _retiredAt, ...undated } = stored;
    expect(ReplicaRetirement.safeParse(undated).success).toBe(false);
  });
});

describe('home replicas carry retiredAt and successor (T13284)', () => {
  const replica = {
    replicaId: R1,
    deviceId: DEVICE,
    deviceState: 'active',
    attachedAt: '2026-10-01T00:00:00.000Z',
    lastSyncAt: null,
    presence: null,
    presenceAt: null,
  };

  it('parses an older server without them, and a retired replica with them', () => {
    expect(HomeReplica.safeParse(replica).success).toBe(true);
    const retired = { ...replica, retiredAt: '2026-10-06T07:00:00.000Z', successor: R2 };
    expect(HomeReplica.parse(retired)).toMatchObject({
      retiredAt: retired.retiredAt,
      successor: R2,
    });
    expect(HomeReplica.safeParse({ ...replica, retiredAt: null, successor: null }).success).toBe(
      true,
    );
    expect(HomeReplica.safeParse({ ...replica, successor: DEVICE }).success).toBe(false);
  });

  it('the attach answer and the list follow HomeReplica', () => {
    expect(AttachHomeReplicaResult).toBe(HomeReplica);
    expect(ListHomeReplicasResult.shape.replicas.element).toBe(HomeReplica);
  });
});

describe('E31 refusal reasons (T13284)', () => {
  it('are the seven server reasons', () => {
    expect([...NEXUS_REPLICA_RETIREMENT_REASONS].sort()).toEqual(
      [
        'not-pinned-or-owner',
        'replica-retired',
        'retire-below-head',
        'retired',
        'successor-other-user',
        'successor-retired',
        'successor-taken',
      ].sort(),
    );
  });
});
