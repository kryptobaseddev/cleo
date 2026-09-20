import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { KnowledgeRepairProposal } from '@cleocode/contracts';
import type { OperationExecutionContext } from '@cleocode/contracts/jobs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeTempDirSync } from '../../__tests__/test-cleanup.js';
import { scanBrainGraphOrphans, scanBrainNoise } from '../../memory/brain-doctor.js';
import { incrementCitationCounts } from '../../memory/retrieval/increment-citation-counts.js';
import { generateProjectHash } from '../../nexus/hash.js';
import { getSymbolFullContext } from '../../nexus/living-brain.js';
import { DurableJobStore } from '../../store/background-jobs.js';
import { createOperationExecutionContext } from '../../store/background-ops.js';
import { getBrainAccessor } from '../../store/memory-accessor.js';
import { getBrainDb, getBrainNativeDb, resetBrainDbState } from '../../store/memory-sqlite.js';
import { getNexusDb, getNexusNativeDb, resetNexusDbState } from '../../store/nexus-sqlite.js';
import { closeAllDatabases, getDb } from '../../store/sqlite.js';
import {
  applyPreparedKnowledgeRepair,
  cancelPreparedKnowledgeRepair,
  createKnowledgeRepairInvocation,
  inspectPreparedKnowledgeRepair,
  listKnowledgeRepairReceipts,
  listPreparedKnowledgeRepairs,
  prepareKnowledgeRepair,
  prepareKnowledgeRollback,
  resumePreparedKnowledgeRepair,
  runKnowledgeDoctor,
} from '../knowledge.js';

describe('knowledge doctor transactional repair', () => {
  let root: string;
  let previousDir: string | undefined;
  let previousHome: string | undefined;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cleo-knowledge-doctor-'));
    mkdirSync(join(root, '.cleo'));
    previousDir = process.env['CLEO_DIR'];
    previousHome = process.env['CLEO_HOME'];
    process.env['CLEO_DIR'] = join(root, '.cleo');
    process.env['CLEO_HOME'] = join(root, 'home');
    await getBrainDb(root);
    await getNexusDb();
    const db = getBrainNativeDb(root);
    if (!db) throw new Error('Fixture database unavailable');
    db.prepare(
      "INSERT INTO main.brain_observations (id, type, title, narrative) VALUES ('O-stub', 'discovery', 'Task complete: T100', 'Task T100 completed with status: undefined')",
    ).run();
    db.prepare(
      "INSERT INTO main.brain_observations (id, type, title, narrative) VALUES ('O-incident', 'discovery', 'Image expiry incident', 'The signed image URL expired; regenerate it before rendering the exported image.')",
    ).run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetBrainDbState();
    resetNexusDbState();
    if (previousDir === undefined) delete process.env['CLEO_DIR'];
    else process.env['CLEO_DIR'] = previousDir;
    if (previousHome === undefined) delete process.env['CLEO_HOME'];
    else process.env['CLEO_HOME'] = previousHome;
    removeTempDirSync(root);
  });

  it('keeps explicit project graph, evidence, repair, and receipt reads isolated from ambient cwd', async () => {
    const other = join(root, 'other');
    mkdirSync(join(other, '.cleo'), { recursive: true });
    delete process.env['CLEO_DIR'];
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    await getBrainDb(other);
    await getNexusDb(other);
    const otherDb = getBrainNativeDb(other);
    const graph = getNexusNativeDb(other);
    if (!otherDb || !graph) throw new Error('Second project fixture unavailable');
    otherDb
      .prepare(
        "INSERT INTO main.brain_observations (id, type, title, narrative) VALUES ('O-other', 'discovery', 'Task complete: T200', 'Task T200 completed with status: undefined')",
      )
      .run();
    graph
      .prepare(
        "INSERT INTO main.nexus_nodes (id, kind, name, file_path, label, indexed_at) VALUES ('b.ts::onlyB', 'function', 'onlyB', 'b.ts', 'onlyB', ?)",
      )
      .run(new Date().toISOString());
    writeFileSync(join(other, 'b.ts'), 'export function onlyB() {}');
    const context = await getSymbolFullContext('onlyB', other);
    expect(context.nexus).toMatchObject({ symbolId: 'b.ts::onlyB' });
    const repaired = await runKnowledgeDoctor(other, { fix: true, budgetMs: 10000 });
    expect(repaired.receipts[0]?.state).toBe('repaired');
    expect(await listKnowledgeRepairReceipts(other)).toHaveLength(1);
    expect(await listKnowledgeRepairReceipts(root)).toEqual([]);
    expect(
      getBrainNativeDb(root)
        ?.prepare("SELECT invalid_at FROM main.brain_observations WHERE id = 'O-stub'")
        .get()?.invalid_at,
    ).toBeNull();
    expect(
      otherDb.prepare("SELECT invalid_at FROM main.brain_observations WHERE id = 'O-other'").get()
        ?.invalid_at,
    ).toBeTypeOf('string');
  });

  it('reports the full orphan count across both endpoints and preserves historical edges', async () => {
    const db = getBrainNativeDb(root);
    if (!db) throw new Error('Fixture database unavailable');
    db.prepare(
      "INSERT INTO main.brain_page_nodes (id, node_type, label) VALUES ('existing', 'observation', 'existing')",
    ).run();
    const insert = db.prepare(
      "INSERT INTO main.brain_page_edges (from_id, to_id, edge_type) VALUES (?, ?, 'supersedes')",
    );
    for (let index = 0; index < 26; index++) insert.run(`missing-source-${index}`, 'existing');
    insert.run('existing', 'missing-target-only');
    const finding = scanBrainGraphOrphans(db);
    expect(finding).toMatchObject({ pattern: 'orphan-edge', count: 27 });
    expect(finding?.sampleIds).toHaveLength(5);
    expect(finding?.sampleIds).toContain('existing->missing-target-only');
    const memory = await scanBrainNoise(root);
    expect(memory.findings.find((entry) => entry.pattern === 'orphan-edge')?.count).toBe(27);
    const doctor = await runKnowledgeDoctor(root, { dryRun: true, budgetMs: 10000 });
    expect(doctor.health.structure.status).toBe('findings');
    expect(
      doctor.health.findings.find((entry) => entry.id.startsWith('brain-orphan-edges:')),
    ).toMatchObject({
      repairClass: 'agent-resolvable',
      state: 'unresolved',
      recovery: null,
      proposedAction: { operation: 'memory.backfill.run' },
    });
    expect(db.prepare('SELECT COUNT(*) AS total FROM main.brain_page_edges').get()?.total).toBe(27);
  });

  it('recognizes canonical task and Nexus endpoints without inventing brain stubs', () => {
    const db = getBrainNativeDb(root);
    if (!db) throw new Error('Fixture database unavailable');
    db.prepare(
      "INSERT INTO main.tasks_tasks (id, title, status, type) VALUES ('T-link', 'Evidence task', 'pending', 'task')",
    ).run();
    db.prepare(
      "INSERT INTO main.brain_page_nodes (id, node_type, label) VALUES ('decision:D-link', 'decision', 'Evidence decision')",
    ).run();
    db.prepare(
      "INSERT INTO main.nexus_nodes (id, kind, name, file_path, label) VALUES ('src/live.ts::work', 'function', 'work', 'src/live.ts', 'work')",
    ).run();
    const insert = db.prepare(
      'INSERT INTO main.brain_page_edges (from_id, to_id, edge_type) VALUES (?, ?, ?)',
    );
    insert.run('task:T-link', 'src/live.ts::work', 'task_touches_symbol');
    insert.run('decision:D-link', 'src/live.ts::work', 'code_reference');
    insert.run('decision:D-link', 'src/live.ts::work', 'documents');
    insert.run('decision:D-link', 'src/live.ts::work', 'mentions');
    insert.run('decision:D-link', 'src/live.ts::work', 'conduit_mentions_symbol');
    insert.run('src/live.ts::work', 'decision:D-link', 'modified_by');
    expect(scanBrainGraphOrphans(db)).toBeNull();
    insert.run('task:T-link', 'src/deleted.ts::work', 'task_touches_symbol');
    expect(scanBrainGraphOrphans(db)).toMatchObject({
      count: 1,
      sampleIds: ['task:T-link->src/deleted.ts::work'],
    });
  });

  it('reports a graph scan failure without a clean structural assessment', async () => {
    const db = getBrainNativeDb(root);
    if (!db) throw new Error('Fixture database unavailable');
    db.exec('ALTER TABLE main.brain_page_edges RENAME TO broken_graph_fixture');
    const result = await runKnowledgeDoctor(root, { dryRun: true, budgetMs: 10000 });
    expect(result.health.structure.status).toBe('failed');
    expect((await scanBrainNoise(root)).structure?.status).toBe('failed');
  });

  it('previews without changing substantive history or storing receipts', async () => {
    const preview = await runKnowledgeDoctor(root, { fix: true, dryRun: true });
    expect(preview.proposals).toHaveLength(1);
    expect(preview.receipts).toEqual([]);
    expect(await listKnowledgeRepairReceipts(root)).toEqual([]);
    const observation = getBrainNativeDb(root)
      ?.prepare("SELECT invalid_at FROM main.brain_observations WHERE id = 'O-stub'")
      .get();
    expect(observation?.invalid_at).toBeNull();
  });

  it('quarantines only confirmed noise, verifies it, and reverses from the durable receipt', async () => {
    const repaired = await runKnowledgeDoctor(root, { fix: true });
    expect(repaired.receipts).toHaveLength(1);
    expect(repaired.receipts[0]?.state).toBe('repaired');
    const db = getBrainNativeDb(root);
    expect(
      db?.prepare("SELECT invalid_at FROM main.brain_observations WHERE id = 'O-stub'").get()
        ?.invalid_at,
    ).toBeTypeOf('string');
    expect(
      db?.prepare("SELECT invalid_at FROM main.brain_observations WHERE id = 'O-incident'").get()
        ?.invalid_at,
    ).toBeNull();
    expect(db?.prepare('SELECT COUNT(*) AS count FROM main.brain_observations').get()?.count).toBe(
      2,
    );
    const receiptId = repaired.receipts[0]?.id;
    if (!receiptId) throw new Error('Missing repair receipt');
    const restored = await runKnowledgeDoctor(root, { rollback: receiptId });
    expect(restored.receipts[0]?.state).toBe('unresolved');
    expect(
      db?.prepare("SELECT invalid_at FROM main.brain_observations WHERE id = 'O-stub'").get()
        ?.invalid_at,
    ).toBeNull();
    expect(await listKnowledgeRepairReceipts(root)).toEqual([]);
    await expect(runKnowledgeDoctor(root, { rollback: receiptId })).resolves.toBeDefined();
  });

  it('deduplicates concurrent callers and repeated automatic repair', async () => {
    const assessment = await runKnowledgeDoctor(root);
    const proposal = assessment.proposals[0];
    if (!proposal) throw new Error('Missing repair proposal');
    const [first, second] = await Promise.all([
      runKnowledgeDoctor(root, { proposal }),
      runKnowledgeDoctor(root, { proposal }),
    ]);
    expect(first.receipts[0]?.id).toBe(second.receipts[0]?.id);
    expect(await listKnowledgeRepairReceipts(root)).toHaveLength(1);
    expect((await runKnowledgeDoctor(root, { fix: true })).receipts).toEqual([]);
  });

  it('persists failed attempts and stops recurring automatic repair after three failures', async () => {
    const db = getBrainNativeDb(root);
    if (!db) throw new Error('Fixture database unavailable');
    db.exec(`CREATE TEMP TRIGGER reject_quarantine BEFORE UPDATE OF invalid_at ON main.brain_observations
      BEGIN SELECT RAISE(ABORT, 'injected quarantine failure'); END`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await runKnowledgeDoctor(root, { fix: true });
      expect(result.receipts[0]).toMatchObject({ state: 'failed', attempt });
      expect(
        db.prepare("SELECT invalid_at FROM main.brain_observations WHERE id = 'O-stub'").get()
          ?.invalid_at,
      ).toBeNull();
    }
    const deferred = await runKnowledgeDoctor(root, { fix: true });
    expect(deferred.receipts[0]).toMatchObject({ state: 'failed', attempt: 3 });
    expect(deferred.health.coverage.maintenanceState).toBe('pending');
    expect(deferred.health.coverage.reasons.join(' ')).toContain('failed three times');
    const readonly = await runKnowledgeDoctor(root);
    expect(readonly.receipts[0]).toMatchObject({ state: 'failed', attempt: 3 });
    expect(await listKnowledgeRepairReceipts(root)).toEqual([]);
  });

  it('never overwrites a concurrent successful receipt after a failed transaction rolls back', async () => {
    const db = getBrainNativeDb(root);
    if (!db) throw new Error('Fixture database unavailable');
    db.exec(`CREATE TEMP TRIGGER reject_quarantine BEFORE UPDATE OF invalid_at ON main.brain_observations
      BEGIN SELECT RAISE(ABORT, 'injected quarantine failure'); END`);
    const failed = await runKnowledgeDoctor(root, { fix: true });
    const receiptId = failed.receipts[0]?.id;
    if (!receiptId) throw new Error('Missing failed receipt');
    const other = new DatabaseSync(join(root, '.cleo', 'cleo.db'));
    const originalExec = db.exec.bind(db);
    let raced = false;
    const hook = vi.spyOn(db, 'exec').mockImplementation((sql) => {
      originalExec(sql);
      if (sql === 'ROLLBACK' && !raced) {
        raced = true;
        other.exec('BEGIN IMMEDIATE');
        other
          .prepare(
            "UPDATE main.brain_observations SET invalid_at = 'concurrent-success' WHERE id = 'O-stub'",
          )
          .run();
        other
          .prepare(
            "UPDATE main._nexus_meta SET value = json_set(value, '$.receipt.state', 'repaired', '$.receipt.attempt', 2, '$.postHash', 'concurrent-post-state') WHERE key = ?",
          )
          .run(`knowledge_repair:${receiptId}`);
        other.exec('COMMIT');
      }
    });
    try {
      const result = await runKnowledgeDoctor(root, { fix: true });
      expect(result.receipts[0]).toMatchObject({ state: 'repaired', attempt: 2 });
      expect(
        other
          .prepare(
            "SELECT json_extract(value, '$.postHash') AS hash FROM main._nexus_meta WHERE key = ?",
          )
          .get(`knowledge_repair:${receiptId}`)?.hash,
      ).toBe('concurrent-post-state');
      expect(
        other.prepare("SELECT invalid_at FROM main.brain_observations WHERE id = 'O-stub'").get()
          ?.invalid_at,
      ).toBe('concurrent-success');
    } finally {
      hook.mockRestore();
      other.close();
    }
  });

  it('never applies an automatic repair after the foreground deadline expires', async () => {
    const result = await runKnowledgeDoctor(root, { fix: true, budgetMs: 0 });
    expect(result.receipts).toEqual([]);
    expect(result.health.coverage.maintenanceState).toBe('pending');
    expect(
      getBrainNativeDb(root)
        ?.prepare("SELECT invalid_at FROM main.brain_observations WHERE id = 'O-stub'")
        .get()?.invalid_at,
    ).toBeNull();
  });

  it('rejects stale proposals without mutating or recording a successful receipt', async () => {
    const assessment = await runKnowledgeDoctor(root);
    const proposal = assessment.proposals[0];
    if (!proposal) throw new Error('Missing repair proposal');
    getBrainNativeDb(root)
      ?.prepare(
        "UPDATE main.brain_observations SET narrative = 'An incident analysis with meaningful details' WHERE id = 'O-stub'",
      )
      .run();
    await expect(runKnowledgeDoctor(root, { proposal })).rejects.toMatchObject({
      code: 'E_REPAIR_STALE',
    });
    expect(await listKnowledgeRepairReceipts(root)).toEqual([]);
  });

  it('refuses rollback that would overwrite changes made after repair', async () => {
    const repaired = await runKnowledgeDoctor(root, { fix: true });
    const receiptId = repaired.receipts[0]?.id;
    if (!receiptId) throw new Error('Missing repair receipt');
    getBrainNativeDb(root)
      ?.prepare(
        "UPDATE main.brain_observations SET narrative = 'A later substantive correction' WHERE id = 'O-stub'",
      )
      .run();
    await expect(runKnowledgeDoctor(root, { rollback: receiptId })).rejects.toMatchObject({
      code: 'E_REPAIR_STALE',
    });
  });

  async function sourcedProposal(): Promise<KnowledgeRepairProposal> {
    const accessor = await getBrainAccessor(root);
    await accessor.addDecision({
      id: 'D001',
      type: 'architecture',
      decision: 'Always fail closed',
      rationale: 'Historical',
      confidence: 'high',
    });
    await accessor.addDecision({
      id: 'D002',
      type: 'architecture',
      decision: 'Missing evidence is unknown',
      rationale: 'Owner correction',
      confidence: 'high',
    });
    getBrainNativeDb(root)
      ?.prepare("UPDATE main.brain_decisions SET confirmation_state = 'accepted'")
      .run();
    const text = 'Replace "Always fail closed" with "Missing evidence is unknown".';
    getBrainNativeDb(root)
      ?.prepare(
        "INSERT INTO main.brain_observations (id, type, title, narrative) VALUES ('O-source', 'discovery', 'Owner correction', ?)",
      )
      .run(text);
    const assessment = await runKnowledgeDoctor(root);
    return {
      id: 'repair-authority',
      findingId: 'authority:D001',
      projectId: assessment.health.coverage.projectId,
      expectedStateHash: assessment.stateHash,
      expectedRevision: assessment.health.coverage.assessedRevision,
      action: {
        operation: 'knowledge.supersede-decision',
        arguments: { previousId: 'D001', successorId: 'D002' },
        prerequisites: [],
      },
      evidence: [
        {
          id: 'O-source',
          projectId: assessment.health.coverage.projectId,
          source: 'memory',
          revision: null,
          precision: 'record',
          contentHash: createHash('sha256').update(text).digest('hex'),
          excerpt: text,
        },
      ],
    };
  }

  it('accepts sourced caller resolution without model credentials and preserves historical text', async () => {
    const proposal = await sourcedProposal();
    const result = await runKnowledgeDoctor(root, { proposal });
    expect(result.receipts[0]?.state).toBe('repaired');
    const accessor = await getBrainAccessor(root);
    expect((await accessor.getDecision('D001'))?.decision).toBe('Always fail closed');
    expect((await accessor.getDecision('D001'))?.supersededBy).toBe('D002');
    expect((await listKnowledgeRepairReceipts(root))[0]?.action?.arguments.successorId).toBe(
      'D002',
    );
    await runKnowledgeDoctor(root, { rollback: 'repair-authority' });
    expect((await accessor.getDecision('D001'))?.supersededBy).toBeNull();
  });

  it('accepts a caller-reviewed mapping to an original project file without generated decision IDs', async () => {
    const proposal = await sourcedProposal();
    const text =
      'This SUPERSEDES the previous rule that an unresolved finding becomes FAIL by default.';
    writeFileSync(join(root, 'directive.md'), text);
    proposal.evidence = [
      {
        ...proposal.evidence[0],
        id: 'directive.md',
        source: 'file',
        excerpt: text,
        contentHash: createHash('sha256').update(text).digest('hex'),
      },
    ];
    proposal.action.arguments = {
      previousId: 'D001',
      successorId: 'D002',
      authorityResolution: 'caller-reviewed',
      scope: proposal.projectId,
      previousContentHash: createHash('sha256').update('Always fail closed').digest('hex'),
      successorContentHash: createHash('sha256')
        .update('Missing evidence is unknown')
        .digest('hex'),
      sourceId: 'directive.md',
      sourcePolicyStatement: text,
      rationale: 'The owner distinguishes unknown evidence from an established failure.',
    };
    const result = await runKnowledgeDoctor(root, { proposal });
    expect(result.receipts[0]?.state).toBe('repaired');
    expect(result.receipts[0]?.reasons.join(' ')).toContain('Semantic relevance is attested');
  });

  it('rejects an unrelated genuine quote without an explicit caller-reviewed target mapping', async () => {
    const proposal = await sourcedProposal();
    const text = 'The signed image URL expired; regenerate it before rendering the exported image.';
    proposal.evidence = [
      {
        ...proposal.evidence[0],
        id: 'O-incident',
        excerpt: text,
        contentHash: createHash('sha256').update(text).digest('hex'),
      },
    ];
    await expect(runKnowledgeDoctor(root, { proposal })).rejects.toMatchObject({
      code: 'E_REPAIR_SOURCE',
    });
  });

  it('rejects a successor that has not been accepted', async () => {
    const proposal = await sourcedProposal();
    getBrainNativeDb(root)
      ?.prepare("UPDATE main.brain_decisions SET confirmation_state = 'proposed' WHERE id = 'D002'")
      .run();
    proposal.expectedStateHash = (await runKnowledgeDoctor(root)).stateHash;
    await expect(runKnowledgeDoctor(root, { proposal })).rejects.toMatchObject({
      code: 'E_REPAIR_AUTHORITY',
    });
  });

  it('rejects fabricated source excerpts and rolls back the whole attempted repair', async () => {
    const proposal = await sourcedProposal();
    proposal.evidence[0].excerpt = 'This text never appeared in the source';
    await expect(runKnowledgeDoctor(root, { proposal })).rejects.toMatchObject({
      code: 'E_REPAIR_SOURCE',
    });
    expect((await (await getBrainAccessor(root)).getDecision('D001'))?.supersededBy).toBeNull();
    expect(await listKnowledgeRepairReceipts(root)).toEqual([]);
  });
});

describe('durable sourced knowledge repair preparation', () => {
  let root: string;
  let context: OperationExecutionContext;
  let proposal: KnowledgeRepairProposal;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cleo-repair-preparation-'));
    mkdirSync(join(root, '.cleo'));
    vi.stubEnv('CLEO_ROOT', root);
    vi.stubEnv('CLEO_DIR', join(root, '.cleo'));
    vi.stubEnv('CLEO_HOME', join(root, 'home'));
    writeFileSync(
      join(root, '.cleo/project-info.json'),
      JSON.stringify({
        projectId: 'repair-A',
        projectHash: generateProjectHash(root),
        projectRoot: root,
      }),
    );
    await getBrainDb(root);
    await getNexusDb(root);
    const db = getBrainNativeDb(root)!;
    db.prepare(
      "INSERT INTO main.brain_observations (id,type,title,narrative) VALUES ('O-prepared','discovery','Task complete: T123','Task T123 completed with status: undefined')",
    ).run();
    await getDb(root);
    // The shared Vitest pragma default disables foreign keys; exercise repair
    // durability with the production constraint setting explicitly enabled.
    db.exec('PRAGMA foreign_keys=ON');
    expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    const report = await runKnowledgeDoctor(root, { dryRun: true, budgetMs: 10000 });
    expect(report.health.coverage.projectId).toBe('repair-A');
    expect(report.proposals).toHaveLength(1);
    proposal = report.proposals[0]!;
    context = createOperationExecutionContext(
      {
        projectId: 'repair-A',
        projectRoot: root,
        actor: 'preparation-test',
        operation: 'doctor.knowledge',
        idempotencyKey: proposal.id,
      },
      { budgetMs: 10000 },
    );
  });

  afterEach(async () => {
    context?.close();
    vi.useRealTimers();
    await closeAllDatabases();
    resetBrainDbState();
    resetNexusDbState();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    removeTempDirSync(root);
  });

  function persisted() {
    return JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1],{readOnly:true});process.stdout.write(JSON.stringify({jobs:db.prepare('SELECT id,status,result,error,proposal_json,proposal_hash,attempts FROM main.background_jobs').all(),decisions:db.prepare('SELECT id,decision,invalid_at,superseded_by,supersedes,confirmation_state FROM main.brain_decisions ORDER BY id').all(),observation:db.prepare(\"SELECT invalid_at,narrative FROM main.brain_observations WHERE id='O-prepared'\").get(),retryHistory:db.prepare(\"SELECT value FROM main._nexus_meta WHERE key LIKE 'knowledge_repair_retry:%'\").all(),attemptOutcomes:db.prepare(\"SELECT value FROM main._nexus_meta WHERE key LIKE 'knowledge_repair_attempt:%'\").all(),events:db.prepare(\"SELECT value FROM main._nexus_meta WHERE key LIKE 'knowledge_repair_event:%'\").all(),receipts:db.prepare(\"SELECT value FROM main._nexus_meta WHERE key LIKE 'knowledge_repair:%'\").all()}));db.close();",
          join(root, '.cleo/cleo.db'),
        ],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
  }

  it('discovers immutable principals across empty actor pages and mutable expired lease ownership', async () => {
    const otherProposal = { ...proposal, id: proposal.id + '-other' };
    const other = createOperationExecutionContext(
      { ...context.identity, actor: 'other-principal', idempotencyKey: otherProposal.id },
      { deadlineAt: context.deadlineAt, signal: context.signal },
    );
    try {
      const first = await prepareKnowledgeRepair(other, otherProposal);
      const second = await prepareKnowledgeRepair(context, proposal);
      const db = getBrainNativeDb(root)!;
      db.prepare('UPDATE main.background_jobs SET started_at=? WHERE id=?').run(1, first.jobId);
      db.prepare('UPDATE main.background_jobs SET started_at=? WHERE id=?').run(2, second.jobId);
      const borrower = new DurableJobStore(await getDb(root), {
        projectId: context.identity.projectId,
        actor: 'different-lease-owner',
      });
      borrower.claim(second.jobId, Date.now());
      db.prepare('UPDATE main.background_jobs SET lease_expires_at=0 WHERE id=?').run(second.jobId);
      const before = db.prepare('SELECT * FROM main.background_jobs ORDER BY id').all();
      const page = await listPreparedKnowledgeRepairs(context, { limit: 1 });
      expect(page).toMatchObject({
        status: 'current',
        entries: [],
        scannedCount: 1,
        excludedActorCount: 1,
        hasMoreCandidates: true,
        matchingTotal: null,
        nextCursor: { id: first.jobId },
      });
      if (!page.nextCursor) throw new Error('Missing candidate continuation');
      const next = await listPreparedKnowledgeRepairs(context, {
        limit: 1,
        after: page.nextCursor,
      });
      expect(next.entries).toHaveLength(1);
      expect(next.entries[0]).toMatchObject({
        jobId: second.jobId,
        proposalId: proposal.id,
        actor: context.identity.actor,
        claimedBy: 'different-lease-owner',
        status: 'running',
        attempts: 1,
        leaseExpiresAt: 0,
        receiptVerification: 'inspection-required',
        inspectArgv: [
          'doctor',
          'knowledge',
          '--inspect',
          second.jobId,
          '--actor',
          context.identity.actor,
          '--proposal-id',
          proposal.id,
        ],
      });
      expect(db.prepare('SELECT * FROM main.background_jobs ORDER BY id').all()).toEqual(before);
    } finally {
      other.close();
    }
  });

  it.each([
    'complete',
    'failed',
  ] as const)('discovers %s history without promoting status to current effects', async (status) => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    if (status === 'complete') await applyPreparedKnowledgeRepair(context, pending.jobId);
    else {
      await incrementCitationCounts(root, ['O-prepared']);
      await expect(applyPreparedKnowledgeRepair(context, pending.jobId)).rejects.toMatchObject({
        code: 'E_REPAIR_STALE',
      });
    }
    const before = persisted();
    const page = await listPreparedKnowledgeRepairs(context);
    expect(page.entries[0]).toMatchObject({
      jobId: pending.jobId,
      status,
      attempts: 1,
      receiptVerification: 'inspection-required',
    });
    expect(page.history).toBe('retained-inspection-required');
    const inspection = await inspectPreparedKnowledgeRepair(context, pending.jobId);
    expect(inspection.status).toBe(status);
    expect(status === 'complete' ? inspection.receipt : inspection.ledger.length).toBeTruthy();
    expect(persisted()).toEqual(before);
  });

  it.each([
    'hash',
    'schema',
    'scope',
    'result',
  ] as const)('discloses corrupt %s candidate without erasing or guessing its principal', async (corruption) => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const db = getBrainNativeDb(root)!;
    const row = db
      .prepare('SELECT proposal_json FROM main.background_jobs WHERE id=?')
      .get(pending.jobId);
    if (typeof row?.proposal_json !== 'string') throw new Error('Missing proposal');
    const body = JSON.parse(row.proposal_json);
    if (corruption === 'result')
      db.prepare('UPDATE main.background_jobs SET result=? WHERE id=?').run(
        'broken-json',
        pending.jobId,
      );
    else {
      if (corruption === 'schema') body.version = 99;
      if (corruption === 'scope') body.identity.projectRoot = join(root, 'different');
      const bytes = JSON.stringify(body);
      db.prepare('UPDATE main.background_jobs SET proposal_json=?,proposal_hash=? WHERE id=?').run(
        bytes,
        corruption === 'hash' ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'),
        pending.jobId,
      );
    }
    const before = persisted();
    const page = await listPreparedKnowledgeRepairs(context);
    expect(page).toMatchObject({
      status: 'partial',
      entries: [],
      scannedCount: 1,
      excludedActorCount: 0,
    });
    expect(page.diagnostics[0]?.jobId).toBe(pending.jobId);
    expect(page.diagnostics[0]?.message.length).toBeGreaterThan(0);
    expect(persisted()).toEqual(before);
  });

  it('keeps required read, payload and identity failures explicit instead of reporting an empty inventory', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    await expect(listPreparedKnowledgeRepairs(context, { maxPayloadBytes: 1 })).rejects.toThrow(
      'payload exceeds',
    );
    const store = vi.spyOn(DurableJobStore.prototype, 'listPage').mockImplementationOnce(() => {
      throw new Error('synthetic read fault');
    });
    await expect(listPreparedKnowledgeRepairs(context)).rejects.toThrow('synthetic read fault');
    store.mockRestore();
    const before = persisted();
    vi.stubEnv('CLEO_ROOT', join(root, 'unrelated'));
    vi.stubEnv('CLEO_DIR', join(root, 'unrelated', '.cleo'));
    expect((await listPreparedKnowledgeRepairs(context)).entries[0]?.jobId).toBe(pending.jobId);
    expect(persisted()).toEqual(before);
    writeFileSync(
      join(root, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'wrong', projectRoot: root }),
    );
    await expect(listPreparedKnowledgeRepairs(context)).rejects.toMatchObject({
      code: 'E_REPAIR_SCOPE',
    });
  });

  it('preserves the inventory caller deadline and rejects closed contexts before storage', async () => {
    const read = vi.spyOn(DurableJobStore.prototype, 'listPage');
    const page = await listPreparedKnowledgeRepairs(context);
    expect(page).toMatchObject({ status: 'current', entries: [], hasMoreCandidates: false });
    expect(read.mock.calls[0]?.[1]).toBe(context);
    context.close();
    read.mockClear();
    await expect(listPreparedKnowledgeRepairs(context)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it('applies prepared quarantine, scoped receipt and job completion atomically with fresh-process readback', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const receipt = await applyPreparedKnowledgeRepair(context, pending.jobId);
    expect(receipt).toMatchObject({
      state: 'repaired',
      attempt: 1,
      execution: {
        identity: context.identity,
        jobId: pending.jobId,
        proposalHash: pending.proposalHash,
        fencingEpoch: 1,
        generation: null,
      },
    });
    expect(receipt.execution?.resources[0]).toMatchObject({ id: 'O-prepared', role: 'affected' });
    expect(receipt.execution?.resources[0]?.afterHash).not.toBe(
      receipt.execution?.resources[0]?.beforeHash,
    );
    const state = persisted();
    expect(state.jobs[0]).toMatchObject({ status: 'complete', attempts: 1 });
    expect(state.observation.invalid_at).toEqual(expect.any(String));
    expect(JSON.parse(state.receipts[0].value).receipt).toEqual(receipt);
    const events = getBrainNativeDb(root)!
      .prepare(
        "SELECT key,value FROM main._nexus_meta WHERE key LIKE 'knowledge_repair_event:%' ORDER BY key",
      )
      .all();
    expect(events).toHaveLength(3);
    expect(await applyPreparedKnowledgeRepair(context, pending.jobId)).toEqual(receipt);
    expect(persisted().jobs[0].attempts).toBe(1);
    expect(
      getBrainNativeDb(root)!
        .prepare("SELECT key FROM main._nexus_meta WHERE key LIKE 'knowledge_repair_event:%'")
        .all(),
    ).toHaveLength(3);
  });

  it.each([
    'source',
    'generation',
    'identity',
  ] as const)('refuses prepared %s drift without changing source authority', async (change) => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const db = getBrainNativeDb(root)!;
    if (change === 'source')
      db.exec(
        "UPDATE main.brain_observations SET narrative='Useful new evidence' WHERE id='O-prepared'",
      );
    if (change === 'generation')
      db.prepare("INSERT INTO main._nexus_meta(key,value) VALUES ('graph_assessment',?)").run('{}');
    if (change === 'identity')
      writeFileSync(
        join(root, '.cleo/project-info.json'),
        JSON.stringify({ projectId: 'other', projectRoot: root }),
      );
    await expect(applyPreparedKnowledgeRepair(context, pending.jobId)).rejects.toThrow();
    expect(persisted().observation.invalid_at).toBeNull();
    expect(persisted().receipts).toEqual([]);
  });

  it.each([
    'domain-receipt',
    'terminal-job',
    'lifecycle',
  ] as const)('rolls back actual repair and receipt on %s persistence fault', async (fault) => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const db = getBrainNativeDb(root)!;
    if (fault === 'terminal-job')
      db.exec(
        "CREATE TEMP TRIGGER reject_terminal BEFORE UPDATE OF status ON main.background_jobs WHEN NEW.status='complete' BEGIN SELECT RAISE(ABORT,'terminal receipt fault'); END",
      );
    else
      db.exec(
        `CREATE TEMP TRIGGER reject_repair BEFORE INSERT ON main._nexus_meta WHEN NEW.key LIKE '${fault === 'domain-receipt' ? 'knowledge_repair:' : 'knowledge_repair_event:'}%' BEGIN SELECT RAISE(ABORT,'repair receipt fault'); END`,
      );
    await expect(applyPreparedKnowledgeRepair(context, pending.jobId)).rejects.toMatchObject({
      attemptFailure: {
        finalization: { state: fault === 'lifecycle' ? 'pending-finalization' : 'finalized' },
      },
    });
    const state = persisted();
    expect(state.jobs[0]).toMatchObject({
      status: fault === 'lifecycle' ? 'running' : 'failed',
      attempts: 1,
    });
    expect(state.observation.invalid_at).toBeNull();
    expect(state.receipts).toEqual([]);
    expect(state.events).toHaveLength(fault === 'lifecycle' ? 0 : 2);
    expect(state.attemptOutcomes).toHaveLength(fault === 'lifecycle' ? 0 : 1);
    if (fault !== 'lifecycle') {
      const attempt = JSON.parse(state.attemptOutcomes[0].value);
      expect(attempt).toMatchObject({
        jobId: pending.jobId,
        proposalId: proposal.id,
        status: 'failed',
        identity: context.identity,
        fencingEpoch: 1,
      });
      expect(JSON.parse(state.jobs[0].result)).toEqual(attempt);
      await expect(applyPreparedKnowledgeRepair(context, pending.jobId)).rejects.toThrow();
      expect(persisted().attemptOutcomes).toEqual(state.attemptOutcomes);
      expect(persisted().events).toEqual(state.events);
    }
  });

  it.each([
    'attempt-receipt',
    'terminal-state',
    'event-rewrite',
  ] as const)('retains pending finalization without partial outcome metadata on %s failure', async (fault) => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const db = getBrainNativeDb(root)!;
    expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    db.exec(
      "CREATE TEMP TRIGGER reject_actual_repair BEFORE UPDATE OF status ON main.background_jobs WHEN NEW.status='complete' BEGIN SELECT RAISE(ABORT,'observed apply failure'); END",
    );
    if (fault === 'attempt-receipt')
      db.exec(
        "CREATE TEMP TRIGGER reject_attempt BEFORE INSERT ON main._nexus_meta WHEN NEW.key LIKE 'knowledge_repair_attempt:%' BEGIN SELECT RAISE(ABORT,'attempt receipt fault'); END",
      );
    else if (fault === 'terminal-state')
      db.exec(
        "CREATE TEMP TRIGGER reject_failed_job BEFORE UPDATE OF status ON main.background_jobs WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'failed terminal fault'); END",
      );
    else
      db.exec(
        "CREATE TEMP TRIGGER rewrite_attempt_event AFTER INSERT ON main._nexus_meta WHEN NEW.key LIKE 'knowledge_repair_event:%' BEGIN UPDATE _nexus_meta SET value='{}' WHERE key=NEW.key; END",
      );
    await expect(applyPreparedKnowledgeRepair(context, pending.jobId)).rejects.toMatchObject({
      attemptFailure: { finalization: { state: 'pending-finalization' } },
    });
    const state = persisted();
    expect(state.jobs[0]).toMatchObject({ status: 'running', attempts: 1 });
    expect(state.observation.invalid_at).toBeNull();
    expect(state.receipts).toEqual([]);
    expect(state.attemptOutcomes).toEqual([]);
    expect(state.events).toEqual([]);
  });

  it('uses existing sourced authority rules through the prepared transaction and retains historical text', async () => {
    const db = getBrainNativeDb(root)!;
    db.exec(`INSERT INTO main.brain_decisions(id,type,decision,rationale,confidence,confirmation_state)
      VALUES ('D-old','architecture','Old rule','Historical evidence','high','accepted'),
      ('D-new','architecture','New rule','Sourced correction','high','accepted')`);
    const directive = 'Replace "Old rule" with "New rule".';
    db.prepare("UPDATE main.brain_observations SET narrative=? WHERE id='O-prepared'").run(
      directive,
    );
    const report = await runKnowledgeDoctor(root, { dryRun: true, budgetMs: 10000 });
    proposal = {
      ...proposal,
      expectedStateHash: report.stateHash,
      action: {
        operation: 'knowledge.supersede-decision',
        arguments: { previousId: 'D-old', successorId: 'D-new' },
        prerequisites: [],
      },
      evidence: [
        {
          id: 'O-prepared',
          projectId: 'repair-A',
          source: 'memory',
          revision: null,
          precision: 'record',
          excerpt: directive,
          contentHash: createHash('sha256').update(directive).digest('hex'),
        },
      ],
    };
    const pending = await prepareKnowledgeRepair(context, proposal);
    const receipt = await applyPreparedKnowledgeRepair(context, pending.jobId);
    expect(receipt.state).toBe('repaired');
    expect(
      db.prepare("SELECT decision,superseded_by FROM main.brain_decisions WHERE id='D-old'").get(),
    ).toMatchObject({ decision: 'Old rule', superseded_by: 'D-new' });
    expect(
      db.prepare("SELECT supersedes FROM main.brain_decisions WHERE id='D-new'").get()?.supersedes,
    ).toBe('D-old');
    const source = receipt.execution?.resources.find((resource) => resource.role === 'source');
    expect(source?.id).toBe('O-prepared');
    expect(source?.afterHash).toBe(source?.beforeHash);
    expect(
      receipt.execution?.resources.filter((resource) => resource.role === 'affected'),
    ).toHaveLength(2);
    expect(persisted().jobs[0].status).toBe('complete');
  });

  it('does not treat authentic JSON bytes as proof that the declared affected resources are complete', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    // A public generic outbox can persist arbitrary operation input; the domain
    // must independently validate its claimed action scope before writing.
    const store = new DurableJobStore(await getDb(root), { projectId: 'repair-A' });
    const otherContext = createOperationExecutionContext(
      { ...context.identity, idempotencyKey: 'incomplete-resources' },
      { budgetMs: 10000 },
    );
    try {
      const malformed = {
        ...pending.proposal,
        resources: [],
        id: 'incomplete-resources',
        identity: otherContext.identity,
      };
      store.defer('incomplete-job', 'doctor.knowledge', Date.now(), {
        projectId: 'repair-A',
        idempotencyKey: 'incomplete-resources',
        proposalJson: JSON.stringify(malformed),
      });
      await expect(applyPreparedKnowledgeRepair(otherContext, 'incomplete-job')).rejects.toThrow(
        'resource or generation changed',
      );
      expect(persisted().observation.invalid_at).toBeNull();
      expect(persisted().receipts).toEqual([]);
    } finally {
      otherContext.close();
    }
  });

  it('allows a later explicit bounded attempt without expiring the immutable prepared proposal', async () => {
    const identity = context.identity;
    context.close();
    context = createOperationExecutionContext(identity);
    const originalDeadline = context.deadlineAt;
    const pending = await prepareKnowledgeRepair(context, proposal);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(originalDeadline + 10000);
    await expect(applyPreparedKnowledgeRepair(context, pending.jobId)).rejects.toThrow();
    expect(persisted().jobs[0]).toMatchObject({ status: 'pending', attempts: 0 });
    context.close();
    context = createOperationExecutionContext(identity);
    expect(context.deadlineAt - Date.now()).toBe(2000);
    const receipt = await applyPreparedKnowledgeRepair(context, pending.jobId);
    expect(receipt).toMatchObject({
      state: 'repaired',
      execution: { proposalHash: pending.proposalHash },
    });
    expect(persisted().jobs[0]).toMatchObject({ status: 'complete', attempts: 1 });
    expect(persisted().jobs[0].proposal_json).toBe(JSON.stringify(pending.proposal));
  });

  it('does not renew the deadline after claim within one foreground attempt', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const originalDeadline = context.deadlineAt;
    const claim = DurableJobStore.prototype.claim;
    vi.spyOn(DurableJobStore.prototype, 'claim').mockImplementation(function (
      this: DurableJobStore,
      ...args
    ) {
      const lease = claim.apply(this, args);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(originalDeadline + 1);
      return lease;
    });
    await expect(applyPreparedKnowledgeRepair(context, pending.jobId)).rejects.toMatchObject({
      attemptFailure: { finalization: { state: 'pending-finalization', deadlineExceeded: true } },
    });
    expect(context.deadlineAt).toBe(originalDeadline);
    expect(persisted().observation.invalid_at).toBeNull();
    expect(persisted().receipts).toEqual([]);
    expect(persisted().attemptOutcomes).toEqual([]);
    expect(persisted().jobs[0]).toMatchObject({ status: 'running', attempts: 1 });
  });

  it('retains the original deadline and rolls back when cancellation arrives after claiming', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const claim = DurableJobStore.prototype.claim;
    vi.spyOn(DurableJobStore.prototype, 'claim').mockImplementation(function (
      this: DurableJobStore,
      ...args
    ) {
      const lease = claim.apply(this, args);
      context.close();
      return lease;
    });
    await expect(applyPreparedKnowledgeRepair(context, pending.jobId)).rejects.toMatchObject({
      attemptFailure: { attempt: { status: 'cancelled' }, finalization: { state: 'finalized' } },
    });
    expect(persisted().jobs[0]).toMatchObject({ status: 'cancelled', attempts: 1 });
    expect(persisted().observation.invalid_at).toBeNull();
    expect(persisted().receipts).toEqual([]);
    expect(persisted().attemptOutcomes).toHaveLength(1);
    expect(persisted().events).toHaveLength(2);
  });

  it('rechecks complete resource images after claim, including fields absent from the old state digest', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const claim = DurableJobStore.prototype.claim;
    vi.spyOn(DurableJobStore.prototype, 'claim').mockImplementation(function (
      this: DurableJobStore,
      ...args
    ) {
      const lease = claim.apply(this, args);
      getBrainNativeDb(root)!.exec(
        "UPDATE main.brain_observations SET type='change' WHERE id='O-prepared'",
      );
      return lease;
    });
    await expect(applyPreparedKnowledgeRepair(context, pending.jobId)).rejects.toThrow(
      'resource or generation changed',
    );
    expect(persisted().observation.invalid_at).toBeNull();
    expect(persisted().receipts).toEqual([]);
    expect(
      getBrainNativeDb(root)!
        .prepare("SELECT type FROM main.brain_observations WHERE id='O-prepared'")
        .get()?.type,
    ).toBe('change');
  });

  it('refuses a stolen lease after claim without writing a repair receipt', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const taskDb = await getDb(root);
    const claim = DurableJobStore.prototype.claim;
    const spy = vi.spyOn(DurableJobStore.prototype, 'claim').mockImplementationOnce(function (
      this: DurableJobStore,
      ...args
    ) {
      const lease = claim.apply(this, args);
      getBrainNativeDb(root)!
        .prepare('UPDATE main.background_jobs SET lease_expires_at=0 WHERE id=?')
        .run(pending.jobId);
      claim.call(
        new DurableJobStore(taskDb, { projectId: context.identity.projectId }),
        pending.jobId,
        Date.now(),
      );
      return lease;
    });
    await expect(applyPreparedKnowledgeRepair(context, pending.jobId)).rejects.toThrow('not owned');
    spy.mockRestore();
    expect(persisted().jobs[0]).toMatchObject({ status: 'running', attempts: 2 });
    expect(persisted().observation.invalid_at).toBeNull();
    expect(persisted().receipts).toEqual([]);
  });

  it('does not borrow or roll back a caller transaction through the prepared service', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const db = getBrainNativeDb(root)!;
    db.exec("BEGIN; INSERT INTO main._nexus_meta(key,value) VALUES ('caller-owned','kept')");
    try {
      await expect(applyPreparedKnowledgeRepair(context, pending.jobId)).rejects.toThrow(
        'another caller owns',
      );
      expect(
        db.prepare("SELECT value FROM main._nexus_meta WHERE key='caller-owned'").get()?.value,
      ).toBe('kept');
      db.exec('ROLLBACK');
      expect(persisted().jobs[0].status).toBe('pending');
      expect(persisted().observation.invalid_at).toBeNull();
    } finally {
      // The explicit successful rollback above must leave the shared handle usable.
      expect(db.prepare('SELECT 1 AS ready').get()?.ready).toBe(1);
    }
  });

  it('returns the verified committed receipt when cancellation arrives after the atomic commit', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const apply = DurableJobStore.prototype.completeAtomically;
    vi.spyOn(DurableJobStore.prototype, 'completeAtomically').mockImplementation(function (
      this: DurableJobStore,
      ...args
    ) {
      const receipt = apply.apply(this, args);
      context.close();
      return receipt;
    });
    expect(await applyPreparedKnowledgeRepair(context, pending.jobId)).toMatchObject({
      state: 'repaired',
    });
    expect(context.signal.aborted).toBe(true);
    expect(persisted().jobs[0].status).toBe('complete');
    expect(persisted().observation.invalid_at).not.toBeNull();
  });

  it('captures repair scope before awaits despite contradictory ROOT and DIR changes', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const applying = applyPreparedKnowledgeRepair(context, pending.jobId);
    const other = join(root, 'other');
    vi.stubEnv('CLEO_ROOT', other);
    vi.stubEnv('CLEO_DIR', join(other, '.cleo'));
    expect(await applying).toMatchObject({ state: 'repaired', projectId: 'repair-A' });
    expect(persisted().jobs[0].status).toBe('complete');
    expect(() => readFileSync(join(other, '.cleo/cleo.db'))).toThrow();
  });

  it('persists the exact scoped proposal before execution and verifies it from a fresh process', async () => {
    const result = await prepareKnowledgeRepair(context, proposal);
    expect(result).toMatchObject({
      jobStatus: 'pending',
      deadlineAt: context.deadlineAt,
      deadlineExceeded: false,
    });
    expect(result.proposal).toMatchObject({
      projectId: 'repair-A',
      identity: { projectRoot: root, actor: 'preparation-test' },
      databasePath: join(root, '.cleo/cleo.db'),
      expectedGeneration: null,
    });
    expect(result.proposal.resources).toEqual([
      {
        kind: 'observation',
        id: 'O-prepared',
        role: 'affected',
        beforeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    const state = persisted();
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]).toMatchObject({
      id: result.jobId,
      status: 'pending',
      attempts: 0,
      proposal_hash: result.proposalHash,
    });
    expect(JSON.parse(state.jobs[0].proposal_json)).toEqual(result.proposal);
    expect(createHash('sha256').update(state.jobs[0].proposal_json).digest('hex')).toBe(
      result.proposalHash,
    );
    expect(state.observation.invalid_at).toBeNull();
    expect(state.receipts).toEqual([]);
  });

  it('reassesses read-touched resources with a new identity while preserving the stale attempt', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const native = getBrainNativeDb(root)!;
    const before = native
      .prepare("SELECT * FROM main.brain_observations WHERE id='O-prepared'")
      .get();
    await incrementCitationCounts(root, ['O-prepared']);
    const touched = native
      .prepare("SELECT * FROM main.brain_observations WHERE id='O-prepared'")
      .get();
    expect(touched?.citation_count).toBe(Number(before?.citation_count) + 1);
    expect(touched?.narrative).toBe(before?.narrative);
    await expect(applyPreparedKnowledgeRepair(context, pending.jobId)).rejects.toMatchObject({
      code: 'E_REPAIR_STALE',
    });
    const failed = persisted();
    expect(failed.jobs[0].status).toBe('failed');
    await expect(resumePreparedKnowledgeRepair(context, pending.jobId)).rejects.toMatchObject({
      code: 'E_REPAIR_STALE',
    });
    expect(persisted().jobs).toEqual(failed.jobs);
    const reassessed = await runKnowledgeDoctor(root, { dryRun: true, budgetMs: 10000 });
    const fresh = reassessed.proposals[0]!;
    expect(fresh.expectedStateHash).toBe(proposal.expectedStateHash);
    expect(fresh.id).not.toBe(proposal.id);
    expect(
      (await runKnowledgeDoctor(root, { dryRun: true, budgetMs: 10000 })).proposals[0],
    ).toEqual(fresh);
    context.close();
    context = createOperationExecutionContext(
      { ...context.identity, idempotencyKey: fresh.id },
      { budgetMs: 10000 },
    );
    const prepared = await prepareKnowledgeRepair(context, fresh);
    expect(prepared.jobId).not.toBe(pending.jobId);
    expect(prepared.proposal.resources[0]?.beforeHash).toBe(
      createHash('sha256').update(JSON.stringify(touched)).digest('hex'),
    );
    expect((await prepareKnowledgeRepair(context, fresh)).jobId).toBe(prepared.jobId);
    const receipt = await applyPreparedKnowledgeRepair(context, prepared.jobId);
    expect(receipt.state).toBe('repaired');
    expect(await applyPreparedKnowledgeRepair(context, prepared.jobId)).toEqual(receipt);
    const after = persisted();
    expect(after.jobs).toHaveLength(2);
    expect(after.jobs).toContainEqual(failed.jobs[0]);
    expect(after.attemptOutcomes).toEqual(failed.attemptOutcomes);
    expect(after.receipts).toHaveLength(1);
    expect(after.observation.invalid_at).not.toBeNull();
    expect(after.observation.narrative).toBe(before?.narrative);
  });

  it('binds assessed identity to full guarded images including timestamp-only changes', async () => {
    const db = getBrainNativeDb(root)!;
    const initial = db
      .prepare("SELECT updated_at FROM main.brain_observations WHERE id='O-prepared'")
      .get();
    db.prepare(
      "UPDATE main.brain_observations SET updated_at='2000-01-01 00:00:00' WHERE id='O-prepared'",
    ).run();
    const changed = await runKnowledgeDoctor(root, { dryRun: true, budgetMs: 10000 });
    expect(changed.stateHash).toBe(proposal.expectedStateHash);
    expect(changed.proposals[0]?.id).not.toBe(proposal.id);
    db.prepare("UPDATE main.brain_observations SET updated_at=? WHERE id='O-prepared'").run(
      initial?.updated_at ?? null,
    );
    expect(
      (await runKnowledgeDoctor(root, { dryRun: true, budgetMs: 10000 })).proposals[0],
    ).toEqual(proposal);
  });

  it('retains original immutable inputs on exact retry and refuses conflicting key reuse', async () => {
    const first = await prepareKnowledgeRepair(context, proposal);
    getBrainNativeDb(root)!
      .prepare(
        "UPDATE main.brain_observations SET narrative='Changed after preparation' WHERE id='O-prepared'",
      )
      .run();
    const repeated = await prepareKnowledgeRepair(context, proposal);
    expect(repeated.jobId).toBe(first.jobId);
    expect(repeated.proposal).toEqual(first.proposal);
    await expect(
      prepareKnowledgeRepair(context, { ...proposal, findingId: 'different-finding' }),
    ).rejects.toThrow('different immutable inputs');
    expect(persisted().jobs).toHaveLength(1);
  });

  it('captures proposal and explicit project before awaits despite mutable input and ROOT/DIR', async () => {
    const pending = prepareKnowledgeRepair(context, proposal);
    proposal.findingId = 'mutated-after-start';
    const other = join(root, 'other');
    vi.stubEnv('CLEO_ROOT', other);
    vi.stubEnv('CLEO_DIR', join(other, '.cleo'));
    const result = await pending;
    expect(result.proposal.findingId).not.toBe('mutated-after-start');
    expect(result.proposal.identity.projectRoot).toBe(root);
    expect(persisted().jobs).toHaveLength(1);
    expect(() => readFileSync(join(other, '.cleo/cleo.db'))).toThrow();
  });

  it('rejects stale source state without inserting pending work', async () => {
    getBrainNativeDb(root)!
      .prepare(
        "UPDATE main.brain_observations SET narrative='Useful incident detail' WHERE id='O-prepared'",
      )
      .run();
    await expect(prepareKnowledgeRepair(context, proposal)).rejects.toThrow(
      'preconditions changed',
    );
    expect(persisted().jobs).toEqual([]);
  });

  it('rolls back an injected pending insert failure without changing source or fabricating receipts', async () => {
    getBrainNativeDb(root)!.exec(
      "CREATE TEMP TRIGGER reject_prepared_job AFTER INSERT ON main.background_jobs BEGIN SELECT RAISE(ABORT,'proposal persistence fault'); END",
    );
    await expect(prepareKnowledgeRepair(context, proposal)).rejects.toThrow();
    const state = persisted();
    expect(state.jobs).toEqual([]);
    expect(state.observation.invalid_at).toBeNull();
    expect(state.receipts).toEqual([]);
  });

  it('refuses cancelled preparation before any durable pending work', async () => {
    context.close();
    await expect(prepareKnowledgeRepair(context, proposal)).rejects.toThrow();
    expect(persisted().jobs).toEqual([]);
  });

  it('refuses borrowed transactions without rolling back the caller', async () => {
    const db = getBrainNativeDb(root)!;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        "UPDATE main.brain_observations SET title='caller-owned' WHERE id='O-prepared'",
      ).run();
      // Use a proposal reflecting the caller's uncommitted image, so transaction refusal,
      // rather than the stale-source precondition, is the independent oracle.
      const state = {
        decisions: db
          .prepare(
            'SELECT id, decision, rationale, invalid_at, superseded_by, supersedes, confirmation_state FROM main.brain_decisions ORDER BY id',
          )
          .all(),
        observations: db
          .prepare(
            'SELECT id, title, narrative, invalid_at, verified FROM main.brain_observations ORDER BY id',
          )
          .all(),
      };
      proposal.expectedStateHash = createHash('sha256').update(JSON.stringify(state)).digest('hex');
      await expect(prepareKnowledgeRepair(context, proposal)).rejects.toThrow(
        'another caller owns',
      );
      expect(
        db.prepare("SELECT title FROM main.brain_observations WHERE id='O-prepared'").get()?.title,
      ).toBe('caller-owned');
    } finally {
      db.exec('ROLLBACK');
    }
    expect(persisted().jobs).toEqual([]);
  });

  it('captures exact published generation provenance in the immutable plan', async () => {
    const assessment = {
      generation: '52c225b0-7ec5-4519-befe-dedb34b6d712',
      sourceRoot: root,
      assessedRevision: null,
      assessedAt: '2026-09-19T00:00:00.000Z',
      files: [],
    };
    getBrainNativeDb(root)!
      .prepare("INSERT INTO main._nexus_meta(key,value) VALUES ('graph_assessment',?)")
      .run(JSON.stringify(assessment));
    const result = await prepareKnowledgeRepair(context, proposal);
    expect(result.proposal.expectedGeneration).toBe(assessment.generation);
    expect(result.proposal.sourceRoot).toBe(root);
    expect(result.proposal.assessmentHash).toBe(
      createHash('sha256').update(JSON.stringify(assessment)).digest('hex'),
    );
  });

  async function prepareRollback(receiptId: string) {
    context.close();
    context = createOperationExecutionContext(
      {
        projectId: 'repair-A',
        projectRoot: root,
        actor: 'preparation-test',
        operation: 'doctor.knowledge',
        idempotencyKey: 'rollback-one',
      },
      { budgetMs: 10000 },
    );
    return prepareKnowledgeRepair(context, {
      ...proposal,
      id: 'rollback-one',
      action: { operation: 'knowledge.rollback', arguments: { receiptId }, prerequisites: [] },
    });
  }

  it('preserves legitimate post-repair citation usage while restoring only declared quarantine fields', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const original = await applyPreparedKnowledgeRepair(context, pending.jobId);
    const originalBytes = persisted().receipts[0].value;
    const db = getBrainNativeDb(root)!;
    await incrementCitationCounts(root, ['O-prepared']);
    const current = db.prepare("SELECT * FROM main.brain_observations WHERE id='O-prepared'").get();
    const recovery = await prepareRollback(original.id);
    const receipt = await applyPreparedKnowledgeRepair(context, recovery.jobId);
    const restored = db
      .prepare("SELECT * FROM main.brain_observations WHERE id='O-prepared'")
      .get();
    expect(restored).toEqual({ ...current, invalid_at: null });
    const image = receipt.execution?.resources[0];
    expect(image?.beforeHash).toBe(
      createHash('sha256').update(JSON.stringify(current)).digest('hex'),
    );
    expect(image?.afterHash).toBe(
      createHash('sha256').update(JSON.stringify(restored)).digest('hex'),
    );
    expect(image?.afterHash).not.toBe(original.execution?.resources[0]?.beforeHash);
    if (!image?.rowImages) throw new Error('Missing actual rollback row evidence');
    expect(JSON.parse(image.rowImages.beforeJson)).toEqual(current);
    expect(JSON.parse(image.rowImages.afterJson)).toEqual(restored);
    expect(receipt.reasons.join(' ')).toContain('current retrieval usage preserved');
    expect(persisted().receipts).toContainEqual({ value: originalBytes });
  });

  it.each([
    ['timestamp-only', 3, '2021-01-01 00:00:00'],
    ['decrement', 2, '2021-01-01 00:00:00'],
    ['negative', -1, '2021-01-01 00:00:00'],
    ['fractional', 3.5, '2021-01-01 00:00:00'],
    ['invalid-count', 'bad-value', '2021-01-01 00:00:00'],
    ['invalid-time', 4, 'not-a-time'],
    ['missing-time', 4, null],
    ['backward-time', 4, '2019-01-01 00:00:00'],
    ['future-time', 4, '9999-01-01 00:00:00'],
    ['invalid-calendar', 4, '2021-02-30 00:00:00'],
  ] as const)('refuses %s usage changes without weakening protected row recovery', async (_label, count, time) => {
    const db = getBrainNativeDb(root)!;
    db.exec(
      "UPDATE main.brain_observations SET citation_count=3,updated_at='2020-01-01 00:00:00' WHERE id='O-prepared'",
    );
    const pending = await prepareKnowledgeRepair(context, proposal);
    const original = await applyPreparedKnowledgeRepair(context, pending.jobId);
    db.prepare(
      "UPDATE main.brain_observations SET citation_count=?,updated_at=? WHERE id='O-prepared'",
    ).run(count, time);
    const before = persisted();
    await expect(prepareRollback(original.id)).rejects.toMatchObject({ code: 'E_REPAIR_STALE' });
    expect(persisted()).toEqual(before);
  });

  it.each([
    'title',
    'narrative',
    'source_session_id',
    'invalid_at',
    'verified',
  ] as const)('preserves conflicting protected %s edits', async (field) => {
    const db = getBrainNativeDb(root)!;
    const pending = await prepareKnowledgeRepair(context, proposal);
    const original = await applyPreparedKnowledgeRepair(context, pending.jobId);
    const values = {
      title: 'Edited title',
      narrative: 'Substantive new evidence',
      source_session_id: 'different-provenance',
      invalid_at: 'user-mark',
      verified: 1,
    };
    db.prepare(`UPDATE main.brain_observations SET ${field}=? WHERE id='O-prepared'`).run(
      values[field],
    );
    const before = persisted();
    await expect(prepareRollback(original.id)).rejects.toMatchObject({ code: 'E_REPAIR_STALE' });
    expect(persisted()).toEqual(before);
  });

  it.each([
    'version',
    'images',
    'before-image',
    'protected-hash',
    'write-fields',
    'operation',
  ] as const)('refuses malformed or forged %s footprint evidence', async (alteration) => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const original = await applyPreparedKnowledgeRepair(context, pending.jobId);
    const db = getBrainNativeDb(root)!;
    const key = `knowledge_repair:${original.id}`;
    const stored = JSON.parse(
      String(db.prepare('SELECT value FROM main._nexus_meta WHERE key=?').get(key)?.value),
    );
    const resource = stored.receipt.execution.resources[0];
    if (alteration === 'version') resource.quarantineFootprint.version = 99;
    if (alteration === 'images') delete resource.rowImages;
    if (alteration === 'before-image')
      resource.rowImages.beforeJson = JSON.stringify({
        ...JSON.parse(resource.rowImages.beforeJson),
        narrative: 'forged',
      });
    if (alteration === 'protected-hash')
      resource.quarantineFootprint.protectedAfterHash = '0'.repeat(64);
    if (alteration === 'write-fields') resource.quarantineFootprint.writeFields = ['narrative'];
    if (alteration === 'operation') resource.quarantineFootprint.operation = 'knowledge.rollback';
    // Corrupt both redundant fixture copies: field/hash validation must still refuse forged policy.
    db.prepare('UPDATE main._nexus_meta SET value=? WHERE key=?').run(JSON.stringify(stored), key);
    db.prepare('UPDATE main.background_jobs SET result=? WHERE id=?').run(
      JSON.stringify(stored.receipt),
      pending.jobId,
    );
    const before = persisted();
    await expect(prepareRollback(original.id)).rejects.toThrow();
    expect(persisted()).toEqual(before);
  });

  it.each([
    false,
    true,
  ])('retains strict legacy receipt semantics with later usage=%s', async (touched) => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const original = await applyPreparedKnowledgeRepair(context, pending.jobId);
    const db = getBrainNativeDb(root)!;
    const key = `knowledge_repair:${original.id}`;
    const stored = JSON.parse(
      String(db.prepare('SELECT value FROM main._nexus_meta WHERE key=?').get(key)?.value),
    );
    for (const resource of stored.receipt.execution.resources) {
      delete resource.quarantineFootprint;
      delete resource.rowImages;
    }
    const bytes = JSON.stringify(stored);
    db.prepare('UPDATE main._nexus_meta SET value=? WHERE key=?').run(bytes, key);
    db.prepare('UPDATE main.background_jobs SET result=? WHERE id=?').run(
      JSON.stringify(stored.receipt),
      pending.jobId,
    );
    if (touched) {
      await incrementCitationCounts(root, ['O-prepared']);
      await expect(prepareRollback(original.id)).rejects.toThrow('legacy receipts require');
    } else {
      const recovery = await prepareRollback(original.id);
      expect((await applyPreparedKnowledgeRepair(context, recovery.jobId)).state).toBe('repaired');
    }
    expect(db.prepare('SELECT value FROM main._nexus_meta WHERE key=?').get(key)?.value).toBe(
      bytes,
    );
  });

  it.each([
    'missing-creation',
    'positive-count-without-time',
  ] as const)('refuses ambiguous first-use baseline %s', async (issue) => {
    const db = getBrainNativeDb(root)!;
    if (issue === 'missing-creation')
      db.exec("UPDATE main.brain_observations SET created_at='invalid' WHERE id='O-prepared'");
    else
      db.exec(
        "UPDATE main.brain_observations SET citation_count=1,updated_at=NULL WHERE id='O-prepared'",
      );
    const pending = await prepareKnowledgeRepair(context, proposal);
    const original = await applyPreparedKnowledgeRepair(context, pending.jobId);
    await incrementCitationCounts(root, ['O-prepared']);
    await expect(prepareRollback(original.id)).rejects.toMatchObject({ code: 'E_REPAIR_STALE' });
  });

  it('keeps prepared-current full-image CAS strict across a later legitimate usage update', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const original = await applyPreparedKnowledgeRepair(context, pending.jobId);
    const recovery = await prepareRollback(original.id);
    await incrementCitationCounts(root, ['O-prepared']);
    const db = getBrainNativeDb(root)!;
    const before = db.prepare("SELECT * FROM main.brain_observations WHERE id='O-prepared'").get();
    await expect(applyPreparedKnowledgeRepair(context, recovery.jobId)).rejects.toMatchObject({
      code: 'E_REPAIR_STALE',
    });
    expect(db.prepare("SELECT * FROM main.brain_observations WHERE id='O-prepared'").get()).toEqual(
      before,
    );
  });

  it('rolls back affected resources while preserving unrelated changes and original receipt bytes', async () => {
    const repair = await prepareKnowledgeRepair(context, proposal);
    const original = await applyPreparedKnowledgeRepair(context, repair.jobId);
    const originalBytes = persisted().receipts[0].value;
    const db = getBrainNativeDb(root)!;
    db.exec(
      "INSERT INTO main.brain_observations(id,type,title,narrative) VALUES ('unrelated','discovery','Retain me','New evidence before preparation')",
    );
    const pending = await prepareRollback(original.id);
    db.exec(
      "UPDATE main.brain_observations SET narrative='Changed after preparation' WHERE id='unrelated'",
    );
    const laterGeneration = {
      generation: '52c225b0-7ec5-4519-befe-dedb34b6d712',
      sourceRoot: root,
      assessedRevision: null,
      assessedAt: '2026-09-19T00:00:00.000Z',
      files: [],
    };
    db.prepare("INSERT INTO main._nexus_meta(key,value) VALUES ('graph_assessment',?)").run(
      JSON.stringify(laterGeneration),
    );
    const result = await applyPreparedKnowledgeRepair(context, pending.jobId);
    expect(result.execution?.generation).toBe(laterGeneration.generation);
    expect(result.execution?.rollback).toEqual({
      receiptId: original.id,
      receiptHash: createHash('sha256').update(originalBytes).digest('hex'),
    });
    expect(result.execution?.resources[0]?.afterHash).toBe(
      original.execution?.resources[0]?.beforeHash,
    );
    const state = persisted();
    expect(state.observation.invalid_at).toBeNull();
    expect(state.receipts).toContainEqual({ value: originalBytes });
    expect(state.receipts).toHaveLength(2);
    expect(
      db.prepare("SELECT narrative FROM main.brain_observations WHERE id='unrelated'").get()
        ?.narrative,
    ).toBe('Changed after preparation');
    expect(await applyPreparedKnowledgeRepair(context, pending.jobId)).toEqual(result);
    expect((await listKnowledgeRepairReceipts(root)).map((row) => row.id)).toEqual([
      'rollback-one',
    ]);
    expect(persisted().events).toHaveLength(6);
    expect(state.jobs).toHaveLength(2);
    for (const job of state.jobs) expect(job.status).toBe('complete');
  });

  it.each([
    'affected',
    'invalidation',
    'snapshot',
  ] as const)('refuses rollback %s drift after preparation', async (change) => {
    const repair = await prepareKnowledgeRepair(context, proposal);
    const original = await applyPreparedKnowledgeRepair(context, repair.jobId);
    const pending = await prepareRollback(original.id);
    const db = getBrainNativeDb(root)!;
    if (change === 'affected')
      db.exec(
        "UPDATE main.brain_observations SET title='User edited affected row' WHERE id='O-prepared'",
      );
    else if (change === 'invalidation')
      db.exec("UPDATE main.brain_observations SET invalid_at='user-mark' WHERE id='O-prepared'");
    else
      db.prepare(
        "UPDATE main._nexus_meta SET value=json_set(value,'$.receipt.reasons',json(?)) WHERE key=?",
      ).run(JSON.stringify(['Later correction']), `knowledge_repair:${original.id}`);
    const before = persisted();
    await expect(applyPreparedKnowledgeRepair(context, pending.jobId)).rejects.toMatchObject({
      code: 'E_REPAIR_STALE',
    });
    const after = persisted();
    expect(after.observation).toEqual(before.observation);
    expect(after.receipts).toEqual(before.receipts);
    expect(
      db.prepare("SELECT 1 FROM main._nexus_meta WHERE key LIKE 'knowledge_rollback:%'").get(),
    ).toBeUndefined();
  });

  it.each([
    'receipt',
    'marker',
    'terminal',
  ] as const)('atomically refuses rollback on %s persistence failure', async (fault) => {
    const repair = await prepareKnowledgeRepair(context, proposal);
    const original = await applyPreparedKnowledgeRepair(context, repair.jobId);
    const before = persisted();
    const pending = await prepareRollback(original.id);
    const db = getBrainNativeDb(root)!;
    if (fault === 'terminal')
      db.exec(
        `CREATE TEMP TRIGGER rollback_terminal BEFORE UPDATE OF status ON main.background_jobs WHEN NEW.id='${pending.jobId}' AND NEW.status='complete' BEGIN SELECT RAISE(ABORT,'rollback terminal fault'); END`,
      );
    else
      db.exec(
        `CREATE TEMP TRIGGER rollback_receipt BEFORE INSERT ON main._nexus_meta WHEN NEW.key ${fault === 'receipt' ? "= 'knowledge_repair:rollback-one'" : "LIKE 'knowledge_rollback:%'"} BEGIN SELECT RAISE(ABORT,'rollback ledger fault'); END`,
      );
    await expect(applyPreparedKnowledgeRepair(context, pending.jobId)).rejects.toMatchObject({
      attemptFailure: { finalization: { state: 'finalized' } },
    });
    const after = persisted();
    expect(after.observation).toEqual(before.observation);
    expect(after.receipts).toEqual(before.receipts);
    expect(
      db.prepare("SELECT 1 FROM main._nexus_meta WHERE key LIKE 'knowledge_rollback:%'").get(),
    ).toBeUndefined();
    expect(after.jobs.find((row: { id: string }) => row.id === pending.jobId)?.status).toBe(
      'failed',
    );
  });

  it('refuses rollback when restoration triggers change any part of an affected row', async () => {
    const repair = await prepareKnowledgeRepair(context, proposal);
    const original = await applyPreparedKnowledgeRepair(context, repair.jobId);
    const before = persisted();
    const pending = await prepareRollback(original.id);
    getBrainNativeDb(root)!.exec(
      "CREATE TEMP TRIGGER mutate_rollback AFTER UPDATE OF invalid_at ON main.brain_observations WHEN NEW.invalid_at IS NULL BEGIN UPDATE brain_observations SET title='Unexpected side effect' WHERE id=NEW.id; END",
    );
    await expect(applyPreparedKnowledgeRepair(context, pending.jobId)).rejects.toMatchObject({
      code: 'E_REPAIR_VERIFY',
    });
    expect(persisted().observation).toEqual(before.observation);
    expect(persisted().receipts).toEqual(before.receipts);
  });

  it('rolls back recovery if a restoration trigger rewrites the original retained receipt', async () => {
    const repair = await prepareKnowledgeRepair(context, proposal);
    const original = await applyPreparedKnowledgeRepair(context, repair.jobId);
    const before = persisted();
    const pending = await prepareRollback(original.id);
    getBrainNativeDb(root)!.exec(
      `CREATE TEMP TRIGGER rewrite_original AFTER UPDATE OF invalid_at ON main.brain_observations WHEN NEW.invalid_at IS NULL BEGIN UPDATE _nexus_meta SET value=json_set(value,'$.receipt.reasons',json('[]')) WHERE key='knowledge_repair:${original.id}'; UPDATE _nexus_meta SET value=json_set(value,'$.postHash','changed') WHERE key='knowledge_repair:${original.id}'; END`,
    );
    await expect(applyPreparedKnowledgeRepair(context, pending.jobId)).rejects.toMatchObject({
      code: 'E_REPAIR_VERIFY',
    });
    expect(persisted().observation).toEqual(before.observation);
    expect(persisted().receipts).toEqual(before.receipts);
  });

  it('restores sourced decision authority and retains its original evidence in a separate rollback receipt', async () => {
    const db = getBrainNativeDb(root)!;
    db.exec(`INSERT INTO main.brain_decisions(id,type,decision,rationale,confidence,confirmation_state)
      VALUES ('D-old','architecture','Old rule','Historical evidence','high','accepted'),
      ('D-new','architecture','New rule','Sourced correction','high','accepted')`);
    const directive = 'Replace "Old rule" with "New rule".';
    db.prepare("UPDATE main.brain_observations SET narrative=? WHERE id='O-prepared'").run(
      directive,
    );
    const report = await runKnowledgeDoctor(root, { dryRun: true, budgetMs: 10000 });
    proposal = {
      ...proposal,
      expectedStateHash: report.stateHash,
      action: {
        operation: 'knowledge.supersede-decision',
        arguments: { previousId: 'D-old', successorId: 'D-new' },
        prerequisites: [],
      },
      evidence: [
        {
          id: 'O-prepared',
          projectId: 'repair-A',
          source: 'memory',
          revision: null,
          precision: 'record',
          excerpt: directive,
          contentHash: createHash('sha256').update(directive).digest('hex'),
        },
      ],
    };
    const before = persisted().decisions;
    const repair = await prepareKnowledgeRepair(context, proposal);
    const original = await applyPreparedKnowledgeRepair(context, repair.jobId);
    const originalBytes = persisted().receipts[0].value;
    const pending = await prepareRollback(original.id);
    // Recovery restores stored authority fields, independent of later source wording.
    db.prepare("UPDATE main.brain_observations SET narrative=? WHERE id='O-prepared'").run(
      'Later source correction retained',
    );
    const receipt = await applyPreparedKnowledgeRepair(context, pending.jobId);
    expect(persisted().decisions).toEqual(before);
    expect(persisted().observation.narrative).toBe('Later source correction retained');
    expect(persisted().receipts).toContainEqual({ value: originalBytes });
    expect(receipt.verificationEvidence).toEqual(original.verificationEvidence);
    for (const resource of receipt.execution!.resources)
      expect(resource.afterHash).toBe(
        original.execution!.resources.find((row) => row.id === resource.id)?.beforeHash,
      );
  });

  it('refuses rollback that would overwrite a later authority correction', async () => {
    const db = getBrainNativeDb(root)!;
    db.exec(`INSERT INTO main.brain_decisions(id,type,decision,rationale,confidence,confirmation_state)
      VALUES ('D-old','architecture','Old rule','Original','high','accepted'),
      ('D-new','architecture','New rule','Replacement','high','accepted')`);
    const directive = 'Replace "Old rule" with "New rule".';
    db.prepare("UPDATE main.brain_observations SET narrative=? WHERE id='O-prepared'").run(
      directive,
    );
    const report = await runKnowledgeDoctor(root, { dryRun: true, budgetMs: 10000 });
    proposal = {
      ...proposal,
      expectedStateHash: report.stateHash,
      action: {
        operation: 'knowledge.supersede-decision',
        arguments: { previousId: 'D-old', successorId: 'D-new' },
        prerequisites: [],
      },
      evidence: [
        {
          id: 'O-prepared',
          projectId: 'repair-A',
          source: 'memory',
          revision: null,
          precision: 'record',
          excerpt: directive,
          contentHash: createHash('sha256').update(directive).digest('hex'),
        },
      ],
    };
    const repair = await prepareKnowledgeRepair(context, proposal);
    const original = await applyPreparedKnowledgeRepair(context, repair.jobId);
    const pending = await prepareRollback(original.id);
    db.exec("UPDATE main.brain_decisions SET confirmation_state='proposed' WHERE id='D-new'");
    const before = persisted();
    await expect(applyPreparedKnowledgeRepair(context, pending.jobId)).rejects.toMatchObject({
      code: 'E_REPAIR_STALE',
    });
    expect(persisted().decisions).toEqual(before.decisions);
    expect(persisted().receipts).toEqual(before.receipts);
  });

  it('refuses a stale rollback owner without restoring any affected resource', async () => {
    const repair = await prepareKnowledgeRepair(context, proposal);
    const original = await applyPreparedKnowledgeRepair(context, repair.jobId);
    const pending = await prepareRollback(original.id);
    const before = persisted();
    const claim = DurableJobStore.prototype.claim;
    vi.spyOn(DurableJobStore.prototype, 'claim').mockImplementationOnce(function (
      this: DurableJobStore,
      ...args
    ) {
      const lease = claim.apply(this, args);
      getBrainNativeDb(root)!
        .prepare('UPDATE main.background_jobs SET fencing_epoch=fencing_epoch+1 WHERE id=?')
        .run(pending.jobId);
      return lease;
    });
    await expect(applyPreparedKnowledgeRepair(context, pending.jobId)).rejects.toMatchObject({
      attemptFailure: { finalization: { state: 'pending-finalization' } },
    });
    expect(persisted().observation).toEqual(before.observation);
    expect(persisted().receipts).toEqual(before.receipts);
    expect(persisted().attemptOutcomes).toEqual([]);
  });

  it('retains successful rollback when cancellation is observed after commit', async () => {
    const repair = await prepareKnowledgeRepair(context, proposal);
    const original = await applyPreparedKnowledgeRepair(context, repair.jobId);
    const pending = await prepareRollback(original.id);
    const apply = DurableJobStore.prototype.completeAtomically;
    vi.spyOn(DurableJobStore.prototype, 'completeAtomically').mockImplementationOnce(function (
      this: DurableJobStore,
      ...args
    ) {
      const result = apply.apply(this, args);
      context.close();
      return result;
    });
    const receipt = await applyPreparedKnowledgeRepair(context, pending.jobId);
    expect(receipt.execution?.rollback?.receiptId).toBe(original.id);
    expect(persisted().observation.invalid_at).toBeNull();
    expect(persisted().jobs).toContainEqual(
      expect.objectContaining({ id: pending.jobId, status: 'complete' }),
    );
    expect(persisted().attemptOutcomes).toEqual([]);
  });

  it.each([
    'apply',
    'resume',
  ] as const)('discloses completed rollback before %s can return a historical repaired result', async (operation) => {
    const identity = context.identity;
    const repair = await prepareKnowledgeRepair(context, proposal);
    const original = await applyPreparedKnowledgeRepair(context, repair.jobId);
    const pending = await prepareRollback(original.id);
    const rollback = await applyPreparedKnowledgeRepair(context, pending.jobId);
    const before = persisted();
    context.close();
    context = createOperationExecutionContext(identity, { budgetMs: 10000 });
    await expect(
      (operation === 'apply' ? applyPreparedKnowledgeRepair : resumePreparedKnowledgeRepair)(
        context,
        repair.jobId,
      ),
    ).rejects.toMatchObject({
      code: 'E_REPAIR_ROLLED_BACK',
      recoveryState: { state: 'rolled-back', originalReceipt: original, rollbackReceipt: rollback },
    });
    expect(persisted()).toEqual(before);
    expect((await inspectPreparedKnowledgeRepair(context, repair.jobId)).rollbackReceipt).toEqual(
      rollback,
    );
  });

  it('explicitly resumes a failed repair with fresh budget and preserves its entire prior attempt', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const db = getBrainNativeDb(root)!;
    db.exec(
      "CREATE TEMP TRIGGER fail_first BEFORE UPDATE OF status ON main.background_jobs WHEN NEW.status='complete' BEGIN SELECT RAISE(ABORT,'first attempt fault'); END",
    );
    await expect(applyPreparedKnowledgeRepair(context, pending.jobId)).rejects.toThrow();
    const previous = persisted();
    expect(previous.jobs[0].status).toBe('failed');
    db.exec('DROP TRIGGER fail_first');
    context.close();
    context = createOperationExecutionContext(context.identity, { budgetMs: 10000 });
    const receipt = await resumePreparedKnowledgeRepair(context, pending.jobId);
    expect(receipt.execution?.fencingEpoch).toBe(2);
    expect(receipt.attempt).toBe(2);
    const after = persisted();
    expect(after.attemptOutcomes).toEqual(previous.attemptOutcomes);
    expect(after.events).toEqual(expect.arrayContaining(previous.events));
    const retained = JSON.parse(after.retryHistory[0].value);
    expect(retained).toMatchObject({
      id: pending.jobId,
      status: 'failed',
      fencingEpoch: 1,
      attempts: 1,
      result: previous.jobs[0].result,
      error: previous.jobs[0].error,
    });
    expect(await resumePreparedKnowledgeRepair(context, pending.jobId)).toEqual(receipt);
    expect(persisted().jobs[0].attempts).toBe(2);
  });

  it('revalidates the immutable recovery snapshot before committing a new rollback claim', async () => {
    const repair = await prepareKnowledgeRepair(context, proposal);
    const original = await applyPreparedKnowledgeRepair(context, repair.jobId);
    const pending = await prepareRollback(original.id);
    const db = getBrainNativeDb(root)!;
    db.exec(
      `CREATE TEMP TRIGGER fail_rollback BEFORE UPDATE OF status ON main.background_jobs WHEN NEW.id='${pending.jobId}' AND NEW.status='complete' BEGIN SELECT RAISE(ABORT,'rollback attempt fault'); END`,
    );
    await expect(applyPreparedKnowledgeRepair(context, pending.jobId)).rejects.toThrow();
    db.exec('DROP TRIGGER fail_rollback');
    db.prepare(
      "UPDATE main._nexus_meta SET value=json_set(value,'$.postHash','later-snapshot-change') WHERE key=?",
    ).run(`knowledge_repair:${original.id}`);
    const before = persisted();
    context.close();
    context = createOperationExecutionContext(context.identity, { budgetMs: 10000 });
    await expect(resumePreparedKnowledgeRepair(context, pending.jobId)).rejects.toMatchObject({
      code: 'E_REPAIR_STALE',
    });
    expect(persisted().jobs).toEqual(before.jobs);
    expect(persisted().receipts).toEqual(before.receipts);
    expect(persisted().retryHistory).toEqual([]);
  });

  it('requires deliberate resume for cancelled work and retains the cancellation record', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    new DurableJobStore(await getDb(root), { projectId: 'repair-A' }).requestCancel(
      pending.jobId,
      Date.now(),
    );
    await expect(applyPreparedKnowledgeRepair(context, pending.jobId)).rejects.toThrow();
    context.close();
    context = createOperationExecutionContext(context.identity, { budgetMs: 10000 });
    expect(await resumePreparedKnowledgeRepair(context, pending.jobId)).toMatchObject({
      state: 'repaired',
      attempt: 1,
    });
    const prior = JSON.parse(persisted().retryHistory[0].value);
    expect(prior).toMatchObject({
      status: 'cancelled',
      attempts: 0,
      cancellationRequestedAt: expect.any(Number),
    });
  });

  it.each([
    'actor',
    'source',
    'history',
    'claim',
  ] as const)('refuses explicit terminal resume on %s conflict without erasing the old outcome', async (fault) => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const store = new DurableJobStore(await getDb(root), { projectId: 'repair-A' });
    store.requestCancel(pending.jobId, Date.now());
    const before = persisted();
    const db = getBrainNativeDb(root)!;
    context.close();
    context = createOperationExecutionContext(
      {
        ...context.identity,
        actor: fault === 'actor' ? 'different-actor' : context.identity.actor,
      },
      { budgetMs: 10000 },
    );
    if (fault === 'source')
      db.exec(
        "UPDATE main.brain_observations SET invalid_at='later correction' WHERE id='O-prepared'",
      );
    if (fault === 'history')
      db.exec(
        "CREATE TEMP TRIGGER refuse_history BEFORE INSERT ON main._nexus_meta WHEN NEW.key LIKE 'knowledge_repair_retry:%' BEGIN SELECT RAISE(ABORT,'history fault'); END",
      );
    if (fault === 'claim')
      db.exec(
        "CREATE TEMP TRIGGER refuse_resume BEFORE UPDATE OF owner_id ON main.background_jobs BEGIN SELECT RAISE(ABORT,'claim fault'); END",
      );
    const resumed = resumePreparedKnowledgeRepair(context, pending.jobId);
    if (fault === 'actor') await expect(resumed).rejects.toMatchObject({ code: 'E_REPAIR_ACTOR' });
    else await expect(resumed).rejects.toThrow();
    expect(persisted().jobs).toEqual(before.jobs);
    expect(persisted().receipts).toEqual(before.receipts);
    expect(
      db.prepare("SELECT 1 FROM main._nexus_meta WHERE key LIKE 'knowledge_repair_retry:%'").get(),
    ).toBeUndefined();
  });

  it('inspects authentic pending work and discloses partial lifecycle pages', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    expect(await inspectPreparedKnowledgeRepair(context, pending.jobId)).toMatchObject({
      status: 'pending',
      receipt: null,
      rollbackReceipt: null,
      ledgerComplete: true,
      ledgerTotal: 0,
    });
    const receipt = await applyPreparedKnowledgeRepair(context, pending.jobId);
    const first = await inspectPreparedKnowledgeRepair(context, pending.jobId, 1);
    const rest = await inspectPreparedKnowledgeRepair(context, pending.jobId, 2, 1);
    expect(first).toMatchObject({ receipt, ledgerTotal: 3, ledgerComplete: false });
    expect(first.ledger).toHaveLength(1);
    expect(rest).toMatchObject({ ledgerTotal: 3, ledgerComplete: false });
    expect(rest.ledger).toHaveLength(2);
    expect(new Set([...first.ledger, ...rest.ledger].map((row) => row.key)).size).toBe(3);
  });

  it('shows original committed evidence and separate current rollback correction', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const original = await applyPreparedKnowledgeRepair(context, pending.jobId);
    const rollbackPending = await prepareRollback(original.id);
    const recovered = await applyPreparedKnowledgeRepair(context, rollbackPending.jobId);
    context.close();
    context = createOperationExecutionContext(pending.proposal.identity, { budgetMs: 10000 });
    const inspected = await inspectPreparedKnowledgeRepair(context, pending.jobId);
    expect(inspected.status).toBe('complete');
    expect(inspected.receipt).toEqual(original);
    expect(inspected.rollbackReceipt).toEqual(recovered);
  });

  it('surfaces inspection read failure instead of an empty healthy ledger', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    getBrainNativeDb(root)!.exec('DROP TABLE main._nexus_meta');
    await expect(inspectPreparedKnowledgeRepair(context, pending.jobId)).rejects.toThrow();
  });

  it('captures inspection ownership before contradictory ROOT and DIR changes', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const inspecting = inspectPreparedKnowledgeRepair(context, pending.jobId);
    const other = join(root, 'other-inspection');
    vi.stubEnv('CLEO_ROOT', other);
    vi.stubEnv('CLEO_DIR', join(other, '.cleo'));
    expect(await inspecting).toMatchObject({
      jobId: pending.jobId,
      proposal: { identity: { projectRoot: root } },
    });
    expect(() => readFileSync(join(other, '.cleo/cleo.db'))).toThrow();
  });

  it('requires the explicit immutable actor for inspection and cancellation', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    context.close();
    context = createOperationExecutionContext(
      { ...context.identity, actor: 'different-actor' },
      { budgetMs: 10000 },
    );
    await expect(inspectPreparedKnowledgeRepair(context, pending.jobId)).rejects.toMatchObject({
      code: 'E_REPAIR_ACTOR',
    });
    await expect(cancelPreparedKnowledgeRepair(context, pending.jobId)).rejects.toMatchObject({
      code: 'E_REPAIR_ACTOR',
    });
    expect(persisted().jobs[0].status).toBe('pending');
  });

  it.each([
    'pending',
    'running',
    'complete',
  ] as const)('reports actual %s state after a cancellation request', async (status) => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    if (status === 'running')
      new DurableJobStore(await getDb(root), { projectId: 'repair-A' }).claim(
        pending.jobId,
        Date.now(),
      );
    if (status === 'complete') await applyPreparedKnowledgeRepair(context, pending.jobId);
    const result = await cancelPreparedKnowledgeRepair(context, pending.jobId);
    expect(result.requested).toBe(status !== 'complete');
    expect(result.inspection?.status).toBe(status === 'pending' ? 'cancelled' : status);
    if (status === 'running')
      expect(result.inspection?.cancellationRequestedAt).toEqual(expect.any(Number));
    if (status === 'complete') expect(result.inspection?.receipt?.state).toBe('repaired');
    expect(result.diagnosticError).toBeNull();
  });

  it('reports the committed cancellation request when subsequent inspection is cancelled', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const request = DurableJobStore.prototype.requestCancel;
    vi.spyOn(DurableJobStore.prototype, 'requestCancel').mockImplementationOnce(function (
      this: DurableJobStore,
      ...args
    ) {
      const result = request.apply(this, args);
      context.close();
      return result;
    });
    const result = await cancelPreparedKnowledgeRepair(context, pending.jobId);
    expect(result).toMatchObject({
      requested: true,
      inspection: null,
      diagnosticError: expect.stringContaining('transaction completed'),
    });
    expect(persisted().jobs[0].status).toBe('cancelled');
  });

  it('retains an uncertain expired attempt before resuming and fences its old owner', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const oldOwner = new DurableJobStore(await getDb(root), {
      projectId: 'repair-A',
      actor: 'preparation-test',
    });
    oldOwner.claim(pending.jobId, Date.now());
    oldOwner.checkpoint(pending.jobId, '{"stage":"unknown interrupted attempt"}', Date.now());
    oldOwner.requestCancel(pending.jobId, Date.now());
    getBrainNativeDb(root)!
      .prepare('UPDATE main.background_jobs SET lease_expires_at=0 WHERE id=?')
      .run(pending.jobId);
    context.close();
    context = createOperationExecutionContext(context.identity, { budgetMs: 10000 });
    const receipt = await resumePreparedKnowledgeRepair(context, pending.jobId);
    expect(receipt.execution?.fencingEpoch).toBe(2);
    expect(() => oldOwner.complete(pending.jobId, { late: true }, Date.now())).toThrow();
    expect(JSON.parse(persisted().retryHistory[0].value)).toMatchObject({
      status: 'running',
      error: null,
      checkpointJson: '{"stage":"unknown interrupted attempt"}',
      cancellationRequestedAt: expect.any(Number),
    });
    const inspected = await inspectPreparedKnowledgeRepair(context, pending.jobId);
    expect(inspected.ledgerComplete).toBe(true);
    expect(inspected.ledgerTotal).toBe(4);
    expect(persisted().attemptOutcomes).toEqual([]);
  });

  it('refuses explicit resume of a still-live owner without appending invented history', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    new DurableJobStore(await getDb(root), { projectId: 'repair-A' }).claim(
      pending.jobId,
      Date.now(),
    );
    const before = persisted();
    await expect(resumePreparedKnowledgeRepair(context, pending.jobId)).rejects.toThrow();
    expect(persisted().jobs).toEqual(before.jobs);
    expect(persisted().retryHistory).toEqual([]);
  });

  it('creates explicit invocation scope without renewing the caller deadline', async () => {
    const deadline = Date.now() + 1000;
    const other = join(root, 'other-invocation');
    const loading = createKnowledgeRepairInvocation(
      root,
      'preparation-test',
      proposal.id,
      deadline,
    );
    vi.stubEnv('CLEO_ROOT', other);
    vi.stubEnv('CLEO_DIR', join(other, '.cleo'));
    const created = await loading;
    try {
      expect(created.identity).toEqual(context.identity);
      expect(created.deadlineAt).toBe(deadline);
    } finally {
      created.close();
    }
    await expect(
      createKnowledgeRepairInvocation(root, 'preparation-test', proposal.id, Date.now() - 1),
    ).rejects.toThrow();
    await expect(
      createKnowledgeRepairInvocation(root, '', proposal.id, deadline),
    ).rejects.toMatchObject({ code: 'E_REPAIR_INPUT' });
  });

  it('prepares recovery directly from an authentic receipt and preserves its immutable identity', async () => {
    const repair = await prepareKnowledgeRepair(context, proposal);
    const original = await applyPreparedKnowledgeRepair(context, repair.jobId);
    context.close();
    context = await createKnowledgeRepairInvocation(
      root,
      'preparation-test',
      'new-rollback',
      Date.now() + 10000,
    );
    const pending = await prepareKnowledgeRollback(context, original.id);
    expect(pending.proposal).toMatchObject({
      id: 'new-rollback',
      action: { operation: 'knowledge.rollback' },
      rollback: { receiptId: original.id },
    });
    expect(await applyPreparedKnowledgeRepair(context, pending.jobId)).toMatchObject({
      id: 'new-rollback',
      state: 'repaired',
    });
    expect(persisted().observation.invalid_at).toBeNull();
    expect(await prepareKnowledgeRollback(context, original.id)).toMatchObject({
      jobId: pending.jobId,
      jobStatus: 'complete',
    });
    await expect(prepareKnowledgeRollback(context, 'different-receipt')).rejects.toMatchObject({
      code: 'E_REPAIR_ID_REUSED',
    });
  });

  it('passes the original execution context into preparation storage before mutation', async () => {
    const original = DurableJobStore.prototype.defer;
    vi.spyOn(DurableJobStore.prototype, 'defer').mockImplementation(function (
      this: DurableJobStore,
      ...args
    ) {
      context.close();
      return original.apply(this, args);
    });
    await expect(prepareKnowledgeRepair(context, proposal)).rejects.toThrow();
    expect(persisted().jobs).toEqual([]);
  });

  it('passes the original execution context into claim storage before mutation', async () => {
    const pending = await prepareKnowledgeRepair(context, proposal);
    const original = DurableJobStore.prototype.claim;
    vi.spyOn(DurableJobStore.prototype, 'claim').mockImplementation(function (
      this: DurableJobStore,
      ...args
    ) {
      context.close();
      return original.apply(this, args);
    });
    await expect(applyPreparedKnowledgeRepair(context, pending.jobId)).rejects.toThrow();
    expect(persisted().jobs[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(persisted().attemptOutcomes).toEqual([]);
    expect(persisted().observation.invalid_at).toBeNull();
  });

  it('reports durable preparation if cancellation arrives immediately after its commit', async () => {
    const original = DurableJobStore.prototype.defer;
    vi.spyOn(DurableJobStore.prototype, 'defer').mockImplementation(function (
      this: DurableJobStore,
      ...args
    ) {
      const result = original.apply(this, args);
      context.close();
      return result;
    });
    const result = await prepareKnowledgeRepair(context, proposal);
    expect(result.jobStatus).toBe('pending');
    expect(persisted().jobs[0].id).toBe(result.jobId);
    expect(persisted().observation.invalid_at).toBeNull();
  });

  it('rejects a conflicting canonical project identity before preparing work', async () => {
    writeFileSync(
      join(root, '.cleo/project-info.json'),
      JSON.stringify({
        projectId: 'different-project',
        projectHash: generateProjectHash(root),
        projectRoot: root,
      }),
    );
    await expect(prepareKnowledgeRepair(context, proposal)).rejects.toThrow(
      'Canonical project metadata differs',
    );
    expect(persisted().jobs).toEqual([]);
  });
});
