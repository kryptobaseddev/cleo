/**
 * @cleocode/core/doctor — Programmatic primitives for `cleo doctor` flows.
 *
 * Today this module owns the worktree-orphan audit + prune surface
 * introduced by T9790 (E-DOCS-WORKTREE-CLEANUP). Future doctor probes
 * should live here too, keeping `cleo doctor` itself a thin CLI shell
 * over CORE primitives.
 *
 * @see ../../validation/doctor/checks.ts — the older, validation-suite
 *   style probes (auditOrphanWorktrees / auditOrphanTempDirs) that pre-date
 *   this module and are kept for backwards compatibility.
 *
 * @task T9790
 * @epic T9790
 */

export type { PruneOptions, ScanOptions } from './worktree-orphans.js';
export { pruneWorktreeOrphans, scanWorktreeOrphans } from './worktree-orphans.js';
