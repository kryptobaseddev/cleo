/**
 * Regression test: brain.db fresh init MUST NOT emit "Adding missing column" warnings.
 *
 * T9166 added statement-breakpoints to 7 brain migration.sql files so that
 * Drizzle applies every ALTER TABLE column on fresh databases, meaning the
 * ensureColumns() safety-net never fires for columns already delivered by the
 * canonical migrations. This test locks in that fix by:
 *
 *   1. Initialising a fresh brain.db in an isolated tmpdir.
 *   2. Capturing every `warn` call emitted by the logger during init.
 *   3. Asserting that NO captured message contains "Adding missing column".
 *   4. Verifying via PRAGMA table_info that all safety-net-inventory columns
 *      exist on the tables that T9166 and its predecessors cover:
 *      - brain_decisions: peer_id, peer_scope, provenance_class,
 *                         adr_number, adr_path, supersedes, superseded_by,
 *                         confirmation_state, decided_by, validator_run_at
 *      - brain_patterns:  peer_id, peer_scope, provenance_class
 *      - brain_learnings: peer_id, peer_scope, provenance_class
 *      - brain_observations: peer_id, peer_scope, provenance_class,
 *                            source_ids, times_derived, level, tree_id,
 *                            stability_score
 *      - brain_retrieval_log: session_id, reward_signal, retrieval_order,
 *                             delta_ms
 *      - brain_plasticity_events: session_id, weight_before, weight_after,
 *                                 retrieval_log_id, reward_signal, delta_t_ms
 *      - brain_page_edges: provenance, last_reinforced_at, reinforcement_count,
 *                          plasticity_class, last_depressed_at, depression_count,
 *                          stability_score
 *
 * If the "Adding missing column" warning reappears on a fresh DB it means a new
 * column was added to ensureColumns() without a corresponding forward migration —
 * fix the migration, not this test.
 *
 * @task T9179
 * @task T9166
 * @epic T9163
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Native SQLite handle (node:sqlite is CJS-only in current Node versions)
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    opts?: { readonly?: boolean },
  ) => import('node:sqlite').DatabaseSync;
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('brain.db fresh init — zero "Adding missing column" warnings', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-brain-no-repair-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('emits zero "Adding missing column" warnings on a brand-new brain.db', async () => {
    // ------------------------------------------------------------------
    // 1. Reset module registry so mocks below apply cleanly to this test.
    // ------------------------------------------------------------------
    vi.resetModules();

    const cleoHome = join(tempDir, 'cleo-home');
    mkdirSync(cleoHome, { recursive: true });

    // ------------------------------------------------------------------
    // 2. Mock paths.js so brain.db is written to our isolated tmpdir.
    // ------------------------------------------------------------------
    vi.doMock('../../paths.js', () => ({
      getCleoHome: () => cleoHome,
      // memory-sqlite.ts (under test) resolves brain.db via the canonical
      // resolveCleoDir SSoT helper (T11262). With the tempDir cwd it must
      // return join(tempDir, '.cleo') so brain.db lands in our isolated tree.
      resolveCleoDir: (cwd?: string) => (cwd ? join(cwd, '.cleo') : join(cleoHome, '.cleo')),
      getCleoDirAbsolute: (cwd?: string) => (cwd ? join(cwd, '.cleo') : join(cleoHome, '.cleo')),
      getProjectRoot: () => tempDir,
    }));

    // ------------------------------------------------------------------
    // 3. Set up a capturing logger mock BEFORE importing memory-sqlite.js,
    //    so every getLogger() call inside that module (and migration-manager)
    //    returns spies whose `warn` calls we can inspect.
    // ------------------------------------------------------------------
    const capturedWarnings: string[] = [];

    vi.doMock('../../logger.js', () => ({
      getLogger: (_subsystem?: string) => ({
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn((...args: unknown[]) => {
          // Pino logger: warn(obj, msg) or warn(msg).
          // Collect whichever argument is a string so we catch the message
          // regardless of call signature.
          for (const arg of args) {
            if (typeof arg === 'string') {
              capturedWarnings.push(arg);
            }
          }
        }),
      }),
    }));

    // ------------------------------------------------------------------
    // 4. Import memory-sqlite AFTER mocks are in place (vi.resetModules()
    //    above ensures a fresh module graph).
    // ------------------------------------------------------------------
    const { getBrainDb, resetBrainDbState } = await import('../memory-sqlite.js');
    resetBrainDbState();

    try {
      // ------------------------------------------------------------------
      // 5. Initialize a fresh brain.db — this is the path under test.
      // ------------------------------------------------------------------
      const db = await getBrainDb(tempDir);
      expect(db).toBeTruthy();

      // ------------------------------------------------------------------
      // 6. PRIMARY: no "Adding missing column" warning must have fired.
      //    The T9166 fix ensures all ALTER TABLE columns arrive via their
      //    canonical migration statements, not via ensureColumns(), so this
      //    string should never appear on a fresh database.
      // ------------------------------------------------------------------
      const repairWarnings = capturedWarnings.filter((msg) =>
        msg.includes('Adding missing column'),
      );
      expect(
        repairWarnings,
        `Expected zero "Adding missing column" warnings on fresh brain.db but got:\n  ${repairWarnings.join('\n  ')}`,
      ).toHaveLength(0);

      // ------------------------------------------------------------------
      // 7. SECONDARY: verify required columns exist via PRAGMA table_info.
      //    E6-L2 (T11522): the brain domain now lives inside the consolidated
      //    `cleo.db` (openDualScopeDb), not a standalone `brain.db`.
      // ------------------------------------------------------------------
      const dbPath = join(tempDir, '.cleo', 'cleo.db');
      const nativeDb = new DatabaseSync(dbPath, { readonly: true });

      try {
        type ColInfo = { name: string };

        const colNames = (table: string): string[] => {
          const rows = nativeDb.prepare(`PRAGMA table_info(${table})`).all() as ColInfo[];
          return rows.map((c) => c.name);
        };

        // brain_decisions — peer isolation + provenance_class + ADR governance columns
        const decisionCols = colNames('brain_decisions');
        expect(decisionCols).toContain('peer_id');
        expect(decisionCols).toContain('peer_scope');
        expect(decisionCols).toContain('provenance_class');
        expect(decisionCols).toContain('adr_number');
        expect(decisionCols).toContain('adr_path');
        expect(decisionCols).toContain('supersedes');
        expect(decisionCols).toContain('superseded_by');
        expect(decisionCols).toContain('confirmation_state');
        expect(decisionCols).toContain('decided_by');
        expect(decisionCols).toContain('validator_run_at');

        // brain_patterns — peer isolation + provenance_class
        const patternCols = colNames('brain_patterns');
        expect(patternCols).toContain('peer_id');
        expect(patternCols).toContain('peer_scope');
        expect(patternCols).toContain('provenance_class');

        // brain_learnings — peer isolation + provenance_class
        const learningCols = colNames('brain_learnings');
        expect(learningCols).toContain('peer_id');
        expect(learningCols).toContain('peer_scope');
        expect(learningCols).toContain('provenance_class');

        // brain_observations — peer isolation + provenance_class + deriver + stability
        const obsCols = colNames('brain_observations');
        expect(obsCols).toContain('peer_id');
        expect(obsCols).toContain('peer_scope');
        expect(obsCols).toContain('provenance_class');
        expect(obsCols).toContain('source_ids');
        expect(obsCols).toContain('times_derived');
        expect(obsCols).toContain('level');
        expect(obsCols).toContain('tree_id');
        expect(obsCols).toContain('stability_score');

        // brain_retrieval_log — STDP plasticity columns (T673-M1)
        const retrievalCols = colNames('brain_retrieval_log');
        expect(retrievalCols).toContain('session_id');
        expect(retrievalCols).toContain('reward_signal');
        expect(retrievalCols).toContain('retrieval_order');
        expect(retrievalCols).toContain('delta_ms');

        // brain_plasticity_events — observability columns (T673-M2)
        const plasticityEventCols = colNames('brain_plasticity_events');
        expect(plasticityEventCols).toContain('session_id');
        expect(plasticityEventCols).toContain('weight_before');
        expect(plasticityEventCols).toContain('weight_after');
        expect(plasticityEventCols).toContain('retrieval_log_id');
        expect(plasticityEventCols).toContain('reward_signal');
        expect(plasticityEventCols).toContain('delta_t_ms');

        // brain_page_edges — provenance (T626) + plasticity tracking (T673-M3)
        const edgeCols = colNames('brain_page_edges');
        expect(edgeCols).toContain('provenance');
        expect(edgeCols).toContain('last_reinforced_at');
        expect(edgeCols).toContain('reinforcement_count');
        expect(edgeCols).toContain('plasticity_class');
        expect(edgeCols).toContain('last_depressed_at');
        expect(edgeCols).toContain('depression_count');
        expect(edgeCols).toContain('stability_score');
      } finally {
        nativeDb.close();
      }
    } finally {
      resetBrainDbState();
    }
  });
});
