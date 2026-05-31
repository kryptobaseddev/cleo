/**
 * Consolidated **shared** target schema — barrel for domains MIRRORED across
 * BOTH cleo.db scopes.
 *
 * SG-DB-SUBSTRATE-V2 · saga T11242 · epic T11245 (E2) · task T11360.
 *
 * Per owner decision D1″, the `brain_*` memory family is the ONE domain that
 * lives in BOTH the PROJECT-scope `cleo.db` (this project's local memory) and
 * the GLOBAL-scope `cleo.db` (cross-project memory) — same DDL, two physical DB
 * files, data partitioned by scope. To avoid duplication, its prefixed,
 * E10-typed target tables are authored ONCE under `cleo-shared/` and re-exported
 * by BOTH scope barrels:
 *   - `cleo-project/index.ts` re-exports this barrel (wired by T11360).
 *   - `cleo-global/index.ts` (T11361) MUST also re-export this barrel — import,
 *     never copy.
 *
 * @task T11360
 * @epic T11245
 * @saga T11242
 * @see ./brain.ts (the mirrored brain_* family + mirroring contract)
 */

export * from './brain.js';
