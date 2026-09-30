/**
 * The change journal's foundation (T12342, slice S1): the hybrid logical
 * clock, its persisted row, the store-level `sync.*` flags, the lazily
 * applied sync schema, replica binding and the device replica registry.
 *
 * Nothing here runs on a hot path yet, and every write is behind a flag that
 * is off by default. Capture (S2), sealing (S3), push (S4) and pull (S5)
 * build on these modules.
 *
 * @task T12342
 * @module store/sync
 */

export * from './clock-store.js';
export * from './flags.js';
export * from './hlc.js';
export * from './replica.js';
export * from './replica-registry.js';
export * from './schema.js';
export * from './skew-hold.js';
