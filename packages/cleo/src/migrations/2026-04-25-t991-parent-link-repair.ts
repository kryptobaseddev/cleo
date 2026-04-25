/**
 * One-shot migration: repair T991 BRAIN Integrity epic parent-child DB links.
 *
 * ## Background
 *
 * The T991 epic shipped all 8 child tasks (T992-T999) in v2026.4.98, but the
 * `parent_id` column was never populated in tasks.db. The Council 2026-04-24
 * audit (T1216/T1227) confirmed `schema-artifact-not-work-defect` — all work
 * is real; only the DB relationship is missing.
 *
 * ## Git evidence
 *
 * Release commit: `18128e3cec6b61f7486c136fb9a2cd956c51b37c`
 * Subject: `chore(release): v2026.4.98 — T991 + T1000 + T1007 Tier 2 + T1013 hygiene`
 *
 * Individual child commits:
 *   - T993: `738d4bd1a` — feat(core/T993): Check A0 title-prefix blocklist in verifyAndStore gate
 *   - T994: `fb59ba1fa` — feat(core/T994): correlateOutcomes Step 9a.5 + trackMemoryUsage lifecycle wiring
 *   - T995: `8493fc351` — feat(core/T995): Step 9f hard-sweeper DELETE prune_candidate=1 AND quality<0.2
 *   - T996: `0de82f872` — feat(sentient/T996): dream cycle migrated to tick loop
 *   - T997: `71c2f2ff1` + `0c417d0ce` — feat/fix(cleo/T997): promote-explain CLI + registry registration
 *   - T998: `9abc54d2e` — feat(T998): nexus_relations plasticity columns + strengthenNexusCoAccess Step 6b
 *   - T999: `fe6dcd26a` — feat(core/T999): memory-bridge mode flag (cli default)
 *
 * T992 evidence: documented in CHANGELOG.md under release v2026.4.98.
 *
 * ## Repair strategy
 *
 * Use `cleo update <id> --parent T991` for each child — the canonical write path
 * per AGENTS.md (no direct SQLite). Each call is idempotent: re-running when
 * parent_id is already T991 produces no change.
 *
 * ## Usage
 *
 * Run the companion script directly:
 *   ```
 *   node scripts/repair-t991-parent-links.mjs
 *   node scripts/repair-t991-parent-links.mjs --dry-run
 *   ```
 *
 * @task T1419
 * @epic T991
 * @see scripts/repair-t991-parent-links.mjs
 */

/** The parent epic task ID. */
export const PARENT_EPIC_ID = 'T991' as const;

/**
 * Child task IDs that should be linked as children of T991.
 * Source: CHANGELOG v2026.4.98 + Council audit T1227 verdict.
 */
export const CHILD_TASK_IDS = [
  'T992',
  'T993',
  'T994',
  'T995',
  'T996',
  'T997',
  'T998',
  'T999',
] as const;

export type ChildTaskId = (typeof CHILD_TASK_IDS)[number];

/** Git evidence anchors supporting the parent-child relationships. */
export const GIT_EVIDENCE = {
  releaseCommit: '18128e3cec6b61f7486c136fb9a2cd956c51b37c',
  releaseTag: 'v2026.4.98',
  childCommits: {
    T993: '738d4bd1adbea2a9ee45f12ba51ab652320f529e',
    T994: 'fb59ba1fa1852d4b7c9f00cdf96d497fe0b45b1f',
    T995: '8493fc351563ce3e0da023fe4a8b0dd23a4d7ee4',
    T996: '0de82f872878eedf8b33a5496d5fdaf7976723c6',
    T997a: '71c2f2ff160ae68fca5d3002d771ea5724fc4dc1',
    T997b: '0c417d0cea6165f8e25a30aca65b7c7f4555ca85',
    T998: '9abc54d2e31d59fa1fdeae4827879019c5cb848c',
    T999: 'fe6dcd26afa01ff123926c9243dc5c654b781b07',
  },
} as const;

/** Result of a single parent-link repair operation. */
export interface RepairResult {
  taskId: ChildTaskId;
  /** Previous parentId — null means the link was absent (expected). */
  previousParentId: string | null;
  /** Whether the repair write was skipped (already correct). */
  skipped: boolean;
  success: boolean;
  error?: string;
}

/** Aggregate result across all children. */
export interface MigrationSummary {
  parentEpic: typeof PARENT_EPIC_ID;
  results: RepairResult[];
  repaired: number;
  skipped: number;
  failed: number;
  /** True only when repaired + skipped === CHILD_TASK_IDS.length and failed === 0. */
  allChildrenLinked: boolean;
}
