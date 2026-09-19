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
import { generateProjectHash } from '../../nexus/hash.js';
import { getSymbolFullContext } from '../../nexus/living-brain.js';
import { DurableJobStore } from '../../store/background-jobs.js';
import { createOperationExecutionContext } from '../../store/background-ops.js';
import { getBrainAccessor } from '../../store/memory-accessor.js';
import { getBrainDb, getBrainNativeDb, resetBrainDbState } from '../../store/memory-sqlite.js';
import { getNexusDb, getNexusNativeDb, resetNexusDbState } from '../../store/nexus-sqlite.js';
import { closeAllDatabases, getDb } from '../../store/sqlite.js';
import {
  listKnowledgeRepairReceipts,
  prepareKnowledgeRepair,
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
          "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1],{readOnly:true});process.stdout.write(JSON.stringify({jobs:db.prepare('SELECT id,status,proposal_json,proposal_hash,attempts FROM main.background_jobs').all(),observation:db.prepare(\"SELECT invalid_at,narrative FROM main.brain_observations WHERE id='O-prepared'\").get(),receipts:db.prepare(\"SELECT value FROM main._nexus_meta WHERE key LIKE 'knowledge_repair:%'\").all()}));db.close();",
          join(root, '.cleo/cleo.db'),
        ],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
  }

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

  it('reports durable preparation if cancellation arrives immediately after its commit', async () => {
    const original = DurableJobStore.prototype.defer;
    vi.spyOn(DurableJobStore.prototype, 'defer').mockImplementation(function (...args) {
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
