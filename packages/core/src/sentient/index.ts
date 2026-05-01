/**
 * @cleocode/core/sentient — Tier-1/Tier-2/Tier-3 sentient daemon public API.
 *
 * Provides the autonomous loop logic: tick execution, Tier-2 proposal
 * generation, state management, rate limiting, ingesters, and Tier-3
 * cryptographic primitives (KMS adapter, signed event chain, baseline capture).
 *
 * @see ADR-054 — Sentient Loop Tier-1
 * @package @cleocode/core
 */

export * from './allowlist.js';
export * from './baseline.js';
export * from './daemon.js';
export * from './events.js';
export * from './ingesters/brain-ingester.js';
export * from './ingesters/nexus-ingester.js';
export * from './ingesters/test-ingester.js';
export * from './kms.js';
export * from './ops.js';
export * from './proposal-dedup.js';
export * from './proposal-rate-limiter.js';
export * from './propose-tick.js';
export * from './stage-drift-tick.js';
export * from './state.js';
export * from './tick.js';
