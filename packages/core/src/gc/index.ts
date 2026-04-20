/**
 * @cleocode/core/gc — Autonomous GC daemon public API.
 *
 * Provides transcript cleanup, disk-pressure monitoring, GC state
 * management, and daemon lifecycle (spawn/stop/status).
 *
 * @see ADR-047 — Autonomous GC and Disk Safety
 * @package @cleocode/core
 */

export * from './daemon.js';
export * from './runner.js';
export * from './state.js';
export * from './transcript.js';
