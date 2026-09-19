import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeTempDirSync } from '../../__tests__/test-cleanup.js';
import { getBrainEntryCodeAnchors } from '../../nexus/living-brain.js';
import { getBrainDb, getBrainNativeDb, resetBrainDbState } from '../../store/memory-sqlite.js';
import { getNexusDb, resetNexusDbState } from '../../store/nexus-sqlite.js';
import { getDb } from '../../store/sqlite.js';
import { tasks } from '../../store/tasks-schema.js';
import {
  isCurrentDecisionCodeEvidence,
  linkDecisionToCodeEvidence,
} from '../decision-cross-link.js';
import { listCodeLinks, queryCodeForMemory } from '../graph-memory-bridge.js';

describe('explicit decision code evidence', () => {
  let root: string;
  let priorDir: string | undefined;
  let priorHome: string | undefined;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cleo-decision-evidence-'));
    mkdirSync(join(root, '.cleo'));
    mkdirSync(join(root, 'src'));
    priorDir = process.env.CLEO_DIR;
    priorHome = process.env.CLEO_HOME;
    process.env.CLEO_DIR = join(root, '.cleo');
    process.env.CLEO_HOME = join(root, 'home');
    await getBrainDb(root);
    await getNexusDb(root);
    const db = getBrainNativeDb(root);
    if (!db) throw new Error('Missing canonical store');
    db.prepare(
      "INSERT INTO main.brain_decisions (id, type, decision, rationale, confidence, confirmation_state, context_task_id) VALUES ('D448', 'architecture', 'Use rushDueAt for rush orders', 'Task verification provides the file evidence.', 'high', 'accepted', 'T448')",
    ).run();
    db.prepare(
      "INSERT INTO main.nexus_nodes (id, kind, name, label, file_path) VALUES ('src/rush.ts', 'file', 'rush.ts', 'rush.ts', 'src/rush.ts'), ('src/rush.ts::rushDueAt', 'function', 'rushDueAt', 'rushDueAt', 'src/rush.ts')",
    ).run();
    writeFileSync(join(root, 'src/rush.ts'), 'export function rushDueAt() {}');
    const taskDb = await getDb(root);
    taskDb
      .insert(tasks)
      .values({ id: 'T448', title: 'Rush evidence', type: 'task', filesJson: '["src/rush.ts"]' })
      .run();
  });
  afterEach(() => {
    resetBrainDbState();
    resetNexusDbState();
    if (priorDir === undefined) delete process.env.CLEO_DIR;
    else process.env.CLEO_DIR = priorDir;
    if (priorHome === undefined) delete process.env.CLEO_HOME;
    else process.env.CLEO_HOME = priorHome;
    removeTempDirSync(root);
  });
  it('backfills explicit decision-to-task-to-file provenance without claiming individual symbol changes', async () => {
    const preview = await linkDecisionToCodeEvidence(root, 'D448');
    expect(preview.findings).toEqual([]);
    expect(preview.links).toHaveLength(1);
    expect(preview.links[0]).toMatchObject({
      targetId: 'src/rush.ts',
      taskId: 'T448',
      precision: 'file',
    });
    expect(preview.links[0]?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'D448', source: 'memory' }),
        expect.objectContaining({ source: 'task' }),
      ]),
    );
    expect(preview.applied).toBe(0);
    expect((await linkDecisionToCodeEvidence(root, 'D448', { apply: true })).applied).toBe(1);
    expect((await linkDecisionToCodeEvidence(root, 'D448', { apply: true })).applied).toBe(0);
    const links = await queryCodeForMemory(root, 'decision:D448');
    expect(links.codeNodes.map((node) => node.nexusNodeId)).toEqual(['src/rush.ts']);
    expect(links.codeNodes[0]?.provenance?.precision).toBe('file');
  });
  it('returns ambiguous candidates and missing-target findings instead of selecting a checkout', async () => {
    getBrainNativeDb(root)
      ?.prepare(
        "INSERT INTO main.nexus_nodes (id, kind, name, label, file_path) VALUES ('other/rush.ts::rushDueAt', 'function', 'rushDueAt', 'rushDueAt', 'other/rush.ts')",
      )
      .run();
    const report = await linkDecisionToCodeEvidence(root, 'D448', {
      symbols: ['rushDueAt', 'missingSymbol'],
    });
    expect(report.findings).toHaveLength(2);
    expect(report.findings[0]?.affectedRecordIds).toEqual(
      expect.arrayContaining(['src/rush.ts::rushDueAt', 'other/rush.ts::rushDueAt']),
    );
    expect(report.findings[1]?.description).toContain('No indexed symbol');
    const exact = await linkDecisionToCodeEvidence(root, 'D448', {
      symbols: ['src/rush.ts::rushDueAt'],
    });
    expect(exact.links).toContainEqual(
      expect.objectContaining({ targetId: 'src/rush.ts::rushDueAt', precision: 'symbol' }),
    );
  });
  it('invalidates a link when its explicit task evidence changes', async () => {
    await linkDecisionToCodeEvidence(root, 'D448', { apply: true });
    getBrainNativeDb(root)
      ?.prepare("UPDATE main.tasks_tasks SET files_json = '[]' WHERE id = 'T448'")
      .run();
    expect((await queryCodeForMemory(root, 'decision:D448')).codeNodes).toEqual([]);
  });

  it('filters stale source and graph generations while retaining and archiving historical provenance', async () => {
    await linkDecisionToCodeEvidence(root, 'D448', { apply: true });
    const db = getBrainNativeDb(root);
    if (!db) throw new Error('Missing store');
    const row = db
      .prepare("SELECT provenance FROM main.brain_page_edges WHERE from_id = 'decision:D448'")
      .get();
    if (typeof row?.provenance !== 'string') throw new Error('Missing provenance');
    expect(isCurrentDecisionCodeEvidence(db, row.provenance)).toBe(true);
    writeFileSync(join(root, 'src/rush.ts'), 'export function rushDueAt() { return 1; }');
    expect((await queryCodeForMemory(root, 'decision:D448')).codeNodes).toEqual([]);
    expect(await listCodeLinks(root)).toEqual([]);
    expect((await getBrainEntryCodeAnchors('decision:D448', root)).nexusNodes).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM main.brain_page_edges WHERE from_id = 'decision:D448'",
        )
        .get()?.count,
    ).toBe(1);
    expect((await linkDecisionToCodeEvidence(root, 'D448', { apply: true })).applied).toBe(1);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM main._nexus_meta WHERE key LIKE 'decision_link_history:%'",
        )
        .get()?.count,
    ).toBe(1);
    db.prepare(
      "INSERT INTO main._nexus_meta (key, value) VALUES ('graph_generation', 'replacement-generation') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run();
    expect((await queryCodeForMemory(root, 'decision:D448')).codeNodes).toEqual([]);
  });
});
