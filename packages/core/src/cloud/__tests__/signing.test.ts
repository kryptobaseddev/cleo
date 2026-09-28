/**
 * Golden vectors for every canonical encoding and signed message (docs/security/e2e-keys.md, "Byte-level
 * encoding"). Fixed inputs, exact outputs: a client in any language must reproduce these. The same vectors
 * run in CLEO core (packages/core/src/cloud/__tests__/signing.test.ts); a change to any output is a
 * protocol change and needs a new domain version.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  checkpointEndorsementMessage,
  checkpointSigningMessage,
  deviceCertificateMessage,
  deviceGrantMessage,
  deviceRevocationMessage,
  manifestCanonical,
  replicasCanonical,
  revocationPinsCanonical,
  segmentMetaCanonical,
  segmentSigningMessage,
} from '../signing.js';

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const R1 = '0192f1c2-7d3e-7abc-8def-0000000000a1';
const R2 = '0192f1c2-7d3e-7abc-8def-0000000000b1';
const D1 = '0192f1c2-7d3e-4abc-8def-0000000000a0';
const D2 = '0192f1c2-7d3e-4abc-8def-0000000000b0';
const U = '0192f1c2-7d3e-4abc-8def-000000000001';
const S = 'project:0192f1c2-7d3e-7abc-8def-0123456789ab';
const CP = '0192f1c2-7d3e-7abc-8def-00000000c001';
const K1 = '11'.repeat(32);
const K2 = '22'.repeat(32);

// Inputs deliberately list keys out of order: the canonical form sorts them.
const meta = {
  schemaVersion: 1,
  opCount: 3,
  hlcMin: `1790545492500-000000-${R1}`,
  hlcMax: `1790545492501-000002-${R1}`,
  deltas: {
    tasks_tasks: { created: 2, deleted: 0 },
    brain_observations: { deleted: 1, created: 0 },
  },
};
const manifest = {
  schemaVersion: 1,
  tables: {
    tasks_tasks: { rows: 3, hash: 'a'.repeat(64) },
    brain_observations: { hash: 'b'.repeat(64), rows: 0 },
  },
};
const replicas = {
  [R2]: { lastReplicaSeq: 0, deviceId: D2 },
  [R1]: { deviceId: D1, lastReplicaSeq: 4 },
};
const pins = { replicas: { [R1]: 4 }, checkpoints: { [S]: 3 } };

const VECTORS = {
  segmentMetaCanonical:
    '{"deltas":{"brain_observations":{"created":0,"deleted":1},"tasks_tasks":{"created":2,"deleted":0}},"hlcMax":"1790545492501-000002-0192f1c2-7d3e-7abc-8def-0000000000a1","hlcMin":"1790545492500-000000-0192f1c2-7d3e-7abc-8def-0000000000a1","opCount":3,"schemaVersion":1}',
  metaHash: 'f8121d46298b7cfde8466c7007201ce06180f0a694670fe705666868093c0c0c',
  segmentSigningMessageText: `cleo-nexus/segment/v2\n${S}\n${R1}\n${D1}\n4\n${'d'.repeat(64)}\nf8121d46298b7cfde8466c7007201ce06180f0a694670fe705666868093c0c0c`,
  segmentSigningMessage: 'dd3541fa7da6fa6fc4a93697d8eb973e09e2f04c04a4bf861ff995fc98280397',
  manifestCanonical: `{"schemaVersion":1,"tables":{"brain_observations":{"hash":"${'b'.repeat(64)}","rows":0},"tasks_tasks":{"hash":"${'a'.repeat(64)}","rows":3}}}`,
  replicasCanonical: `{"${R1}":{"deviceId":"${D1}","lastReplicaSeq":4},"${R2}":{"deviceId":"${D2}","lastReplicaSeq":0}}`,
  revocationPinsCanonical: `{"checkpoints":{"${S}":3},"replicas":{"${R1}":4}}`,
  checkpointSigningMessage: '87f6647494362c88931c2c808be2295972a40d61c3fd23f5bb0a7ae683305123',
  checkpointEndorsementMessage: 'a4c9aa0f433afb18c7761ae1001af5d52ffb834c5ed4e0db3605e8dee5189140',
  deviceCertificateMessage: '40e25957c834f4d8b948b18d871798f6f6e5a070f736cff05dfa1056b7c9771c',
  deviceGrantMessage: '26c529bf144caa716aef4789e25ebb1b9f28667a7142041ffec7af9c714e302a',
  deviceRevocationMessage: '47050984f8fa28f476dad3ba1ac8719079bb131b849eae09f764db6e466a3b3c',
};

const checkpointParts = {
  streamId: S,
  checkpointId: CP,
  parentCheckpointId: null,
  replicaId: R1,
  deviceId: D1,
  coversSeq: 5,
  manifestHash: sha(manifestCanonical(manifest)),
  replicasHash: sha(replicasCanonical(replicas)),
  blobSha256: 'c'.repeat(64),
  sizeBytes: 1234,
};

describe('golden vectors: canonical encodings and signed messages', () => {
  it('canonical JSON: sorted keys at every level, no whitespace', () => {
    expect(segmentMetaCanonical(meta)).toBe(VECTORS.segmentMetaCanonical);
    expect(sha(segmentMetaCanonical(meta))).toBe(VECTORS.metaHash);
    expect(manifestCanonical(manifest)).toBe(VECTORS.manifestCanonical);
    expect(replicasCanonical(replicas)).toBe(VECTORS.replicasCanonical);
    expect(revocationPinsCanonical(pins)).toBe(VECTORS.revocationPinsCanonical);
  });

  it('signed messages: UTF-8 lines joined by LF, no trailing newline', () => {
    const seg = segmentSigningMessage({
      streamId: S,
      replicaId: R1,
      deviceId: D1,
      replicaSeq: 4,
      segmentHash: 'd'.repeat(64),
      metaHash: VECTORS.metaHash,
    });
    expect(new TextDecoder().decode(seg)).toBe(VECTORS.segmentSigningMessageText);
    expect(sha(seg)).toBe(VECTORS.segmentSigningMessage);
    expect(sha(checkpointSigningMessage(checkpointParts))).toBe(VECTORS.checkpointSigningMessage);
    expect(sha(checkpointEndorsementMessage(D2, checkpointParts))).toBe(
      VECTORS.checkpointEndorsementMessage,
    );
    expect(
      sha(
        deviceCertificateMessage({
          userId: U,
          deviceId: D1,
          encryptionPublicKeyHex: K1,
          signingPublicKeyHex: K2,
          keyVersion: 1,
        }),
      ),
    ).toBe(VECTORS.deviceCertificateMessage);
    expect(
      sha(
        deviceGrantMessage({
          userId: U,
          recipientDeviceId: D1,
          recipientEncryptionPublicKeyHex: K1,
          recipientSigningPublicKeyHex: K2,
          keyVersion: 1,
          sealedMasterKeyHash: 'e'.repeat(64),
          certificateHex: 'f'.repeat(64),
          signerDeviceId: D2,
        }),
      ),
    ).toBe(VECTORS.deviceGrantMessage);
    expect(
      sha(
        deviceRevocationMessage({
          userId: U,
          revokedDeviceId: D1,
          revokedSigningPublicKeyHex: K2,
          pinsHash: sha(revocationPinsCanonical(pins)),
          signerDeviceId: D2,
        }),
      ),
    ).toBe(VECTORS.deviceRevocationMessage);
  });
});
