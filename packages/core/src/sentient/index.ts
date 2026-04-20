/**
 * @cleocode/core/sentient — Tier-1/Tier-2 sentient daemon public API.
 *
 * Provides the autonomous loop logic: tick execution, Tier-2 proposal
 * generation, state management, rate limiting, and ingesters.
 *
 * @see ADR-054 — Sentient Loop Tier-1
 * @package @cleocode/core
 */

export * from './daemon.js';
export * from './ingesters/brain-ingester.js';
export * from './ingesters/nexus-ingester.js';
export * from './ingesters/test-ingester.js';
export * from './proposal-rate-limiter.js';
export * from './propose-tick.js';
export * from './state.js';
export * from './tick.js';
