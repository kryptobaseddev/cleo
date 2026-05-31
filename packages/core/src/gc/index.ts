/**
 * @cleocode/core/gc — Autonomous GC daemon public API.
 *
 * Provides transcript cleanup, disk-pressure monitoring, GC state
 * management, and daemon lifecycle (spawn/stop/status).
 *
 * @see ADR-047 — Autonomous GC and Disk Safety
 * @package @cleocode/core
 */

// T9621 — auditOrphans promoted to @cleocode/core/gc for doctor.ts CORE-first migration.
// Read-only audit counterparts to pruneOrphanWorktrees / pruneOrphanTempDirs.
export {
  auditOrphanTempDirs,
  auditOrphanWorktrees,
} from '../validation/doctor/checks.js';
export * from './daemon.js';
export * from './gc-subsystem.js';
export * from './runner.js';
export * from './state.js';
export * from './transcript.js';
