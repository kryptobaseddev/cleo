import { z } from 'zod';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LEGACY_PROJECT_ID = /^[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * A CLEO project id, read from `.cleo/project-id` (write-once, ADR-094 / T12325).
 * New projects use a UUID. Older projects carry a 12-hex id. Paths are never identity.
 */
export const ProjectId = z
  .string()
  .refine(
    (s) => UUID.test(s) || LEGACY_PROJECT_ID.test(s),
    'expected a UUID or legacy 12-hex project id',
  );
export type ProjectId = z.infer<typeof ProjectId>;

/** A replica is one `cleo.db` store (per store, not per machine; worktree copies are separate replicas). */
export const ReplicaId = z.string().regex(UUID_V7, 'expected a UUIDv7 replica id');
export type ReplicaId = z.infer<typeof ReplicaId>;

export const DeviceId = z.string().regex(UUID, 'expected a UUID device id');
export type DeviceId = z.infer<typeof DeviceId>;

export const Sha256Hex = z.string().regex(SHA256_HEX, 'expected lowercase hex sha256');
export type Sha256Hex = z.infer<typeof Sha256Hex>;

/**
 * A journal stream. `project:<projectId>` carries portable·project ops. `home:<userId>` carries
 * portable·personal ops for one account.
 */
export const StreamId = z
  .string()
  .regex(
    /^(project:[0-9a-f-]{12,36}|home:[A-Za-z0-9_-]{8,64})$/,
    'expected project:<id> or home:<userId>',
  );
export type StreamId = z.infer<typeof StreamId>;

/**
 * Hybrid logical clock, encoded so that lexical order is causal order:
 * 13-digit zero-padded wall millis, 6-digit counter, and the replica id, joined by '-'. Example:
 * 1790545492500-000003-0192f1c2-....
 */
export const Hlc = z.string().regex(/^\d{13}-\d{6}-[0-9a-f-]{36}$/, 'expected an encoded HLC');
export type Hlc = z.infer<typeof Hlc>;

/** Base64 (standard alphabet, padded). Used for ciphertext and wrapped keys on the wire. */
export const Base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'expected base64');
