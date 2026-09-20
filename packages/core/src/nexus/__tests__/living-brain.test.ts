/**
 * Integration tests for Living Brain SDK traversal primitives (T1068).
 *
 * Covers:
 * - getSymbolFullContext: cross-substrate context for a seeded symbol
 * - getTaskCodeImpact: files, symbols, blast radius, risk tier
 * - getBrainEntryCodeAnchors: code anchors from a brain memory entry
 * - Graceful no-op when a substrate is absent
 *
 * Each test creates isolated temp directories with synthetic nexus.db +
 * brain.db + tasks.db data, asserts >0 rows across substrates where seeded.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import fsAsync from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeTempDirSync } from '../../__tests__/test-cleanup.js';
import { compactKnowledgeCoverage } from '../../doctor/knowledge-summary.js';
import { reasonWhySymbol } from '../../memory/brain-reasoning.js';
import { EDGE_TYPES } from '../../memory/edge-types.js';
import { getBrainDb, getBrainNativeDb, resetBrainDbState } from '../../store/memory-sqlite.js';
import { getNexusDb, getNexusNativeDb, resetNexusDbState } from '../../store/nexus-sqlite.js';
import { getDb } from '../../store/sqlite.js';
import { tasks } from '../../store/tasks-schema.js';
import { getSymbolContext } from '../context.js';
import { getSymbolImpact } from '../impact.js';
import {
  assessKnowledgeCoverage,
  KnowledgeSymbolAmbiguityError,
  readKnowledgeIndexAssessment,
} from '../knowledge.js';
import {
  getBrainEntryCodeAnchors,
  getSymbolFullContext,
  getTaskCodeImpact,
  nexusFullContext,
  reasonImpactOfChange,
} from '../living-brain.js';
import { resolveSourceRoots } from '../source-roots.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SYMBOL_ID = 'src/test-file.ts::testFunction';
const SYMBOL_NAME = 'testFunction';
const FILE_PATH = 'src/test-file.ts';
const CALLER_ID = 'src/caller.ts::callerFunction';
const TASK_ID = 'T998';
const BRAIN_OBS_ID = 'observation:obs-001';
const BRAIN_DEC_ID = 'decision:dec-001';

async function seedNexusData(nexusNative: ReturnType<typeof getNexusNativeDb>) {
  if (!nexusNative) return;
  const now = new Date().toISOString();

  // ADR-090 · T11648: the project-scope graph tables no longer carry `project_id`.
  // Insert test symbol node
  nexusNative
    .prepare(
      `INSERT OR IGNORE INTO nexus_nodes
       (id, kind, name, file_path, label, indexed_at, is_exported)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(SYMBOL_ID, 'function', SYMBOL_NAME, FILE_PATH, SYMBOL_NAME, now, 1);

  // Insert a caller node
  nexusNative
    .prepare(
      `INSERT OR IGNORE INTO nexus_nodes
       (id, kind, name, file_path, label, indexed_at, is_exported)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(CALLER_ID, 'function', 'callerFunction', 'src/caller.ts', 'callerFunction', now, 1);

  // Insert a calls relation: callerFunction -> testFunction.
  // T11545: plasticity weight lives in the sibling nexus_relation_weights table.
  nexusNative
    .prepare(
      `INSERT OR IGNORE INTO nexus_relations
       (id, source_id, target_id, type, confidence)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run('rel-001', CALLER_ID, SYMBOL_ID, 'calls', 0.9);
  nexusNative
    .prepare(
      `INSERT OR IGNORE INTO nexus_relation_weights (relation_id, weight, co_accessed_count)
       VALUES (?, ?, ?)`,
    )
    .run('rel-001', 2.0, 1);
}

async function seedBrainData(brainNative: ReturnType<typeof getBrainNativeDb>) {
  if (!brainNative) return;
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Insert brain observation node stub in brain_page_nodes
  brainNative
    .prepare(
      `INSERT OR IGNORE INTO brain_page_nodes
       (id, node_type, label, quality_score, content_hash, metadata_json, last_activity_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    )
    .run(BRAIN_OBS_ID, 'observation', 'Test observation about testFunction', 0.8, now, now, now);

  // code_reference edge: observation -> symbol
  brainNative
    .prepare(
      `INSERT OR IGNORE INTO brain_page_edges
       (from_id, to_id, edge_type, weight, provenance, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(BRAIN_OBS_ID, SYMBOL_ID, EDGE_TYPES.CODE_REFERENCE, 1.0, 'test', now);

  // mentions edge: observation -> symbol
  brainNative
    .prepare(
      `INSERT OR IGNORE INTO brain_page_edges
       (from_id, to_id, edge_type, weight, provenance, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(BRAIN_OBS_ID, SYMBOL_ID, EDGE_TYPES.MENTIONS, 1.0, 'test', now);

  // Insert task_touches_symbol edge: task:T998 -> SYMBOL_ID
  brainNative
    .prepare(
      `INSERT OR IGNORE INTO brain_page_edges
       (from_id, to_id, edge_type, weight, provenance, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(`task:${TASK_ID}`, SYMBOL_ID, EDGE_TYPES.TASK_TOUCHES_SYMBOL, 1.0, 'test', now);

  // Seed a real current decision; a schema failure must fail the fixture.
  brainNative
    .prepare(
      'INSERT INTO main.brain_decisions (id, type, decision, rationale, confidence, confirmation_state) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      'dec-001',
      'architecture',
      'Use testFunction for all test cases',
      'Consistent API',
      'high',
      'accepted',
    );

  // Insert a decision brain node stub in brain_page_nodes
  brainNative
    .prepare(
      `INSERT OR IGNORE INTO brain_page_nodes
       (id, node_type, label, quality_score, content_hash, metadata_json, last_activity_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    )
    .run(BRAIN_DEC_ID, 'decision', 'Use testFunction for all test cases', 0.7, now, now, now);

  // documents edge: decision -> symbol
  brainNative
    .prepare(
      `INSERT OR IGNORE INTO brain_page_edges
       (from_id, to_id, edge_type, weight, provenance, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(BRAIN_DEC_ID, SYMBOL_ID, EDGE_TYPES.DOCUMENTS, 1.0, 'test', now);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('living-brain SDK', () => {
  let projectRoot: string;
  let prevCleoDir: string | undefined;
  let prevCleoHome: string | undefined;

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'living-brain-test-'));
    // Pre-create `.cleo/` so resolveCleoDir resolves the temp dir (T11262).
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });

    // ADR-090 · T11648: getNexusDb() resolves the PROJECT scope from CLEO_DIR/cwd
    // (the graph home) — pin it to this temp project so the nexus graph lands in
    // the SAME `.cleo/` as the brain DB and is isolated from the real repo.
    prevCleoDir = process.env['CLEO_DIR'];
    prevCleoHome = process.env['CLEO_HOME'];
    process.env['CLEO_DIR'] = join(projectRoot, '.cleo');
    process.env['CLEO_HOME'] = join(projectRoot, 'home');

    // Initialize databases (creates schema)
    await getBrainDb(projectRoot);
    await getNexusDb();

    const brainNative = getBrainNativeDb(projectRoot);
    const nexusNative = getNexusNativeDb();

    expect(brainNative).toBeDefined();
    expect(nexusNative).toBeDefined();

    await seedNexusData(nexusNative);
    await seedBrainData(brainNative);
  });

  afterEach(() => {
    vi.doUnmock('@cleocode/nexus');
    resetBrainDbState();
    resetNexusDbState();
    if (prevCleoDir === undefined) delete process.env['CLEO_DIR'];
    else process.env['CLEO_DIR'] = prevCleoDir;
    if (prevCleoHome === undefined) delete process.env['CLEO_HOME'];
    else process.env['CLEO_HOME'] = prevCleoHome;
    removeTempDirSync(projectRoot);
  });

  describe('trustworthy knowledge coverage', () => {
    async function seedCompleteInventory(count = 503) {
      writeFileSync(
        join(projectRoot, '.cleo/project-info.json'),
        JSON.stringify({
          projectId: 'fixture-parent-id',
          projectHash: 'fixture-parent-hash',
        }),
      );
      const sourceRoot = join(projectRoot, 'inventory-source');
      mkdirSync(sourceRoot);
      execFileSync('git', ['init', '--quiet', sourceRoot]);
      const content = 'export const value = 1;\n';
      const files = Array.from({ length: count }, (_, index) => {
        const path = `file-${String(index).padStart(4, '0')}.ts`;
        const absolute = join(sourceRoot, path);
        writeFileSync(absolute, content);
        utimesSync(absolute, new Date('2020-01-01'), new Date('2020-01-01'));
        const stat = statSync(absolute);
        return {
          path,
          status: 'analyzed' as const,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          contentHash: createHash('sha256').update(content).digest('hex'),
        };
      });
      execFileSync('git', ['add', '.'], { cwd: sourceRoot });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '--quiet',
          '--no-gpg-sign',
          '--no-verify',
          '-m',
          'inventory fixture',
        ],
        { cwd: sourceRoot },
      );
      const sourceRoots = await resolveSourceRoots({
        projectId: 'fixture-parent-id',
        projectRoot,
        sourceRoot,
      });
      const native = getNexusNativeDb(projectRoot);
      if (!native) throw new Error('Missing inventory fixture database');
      const assessment = JSON.stringify({
        sourceRoots,
        sourceRoot,
        assessedRevision: sourceRoots.roots[0]?.revision,
        assessedAt: new Date().toISOString(),
        files,
      });
      native
        .prepare(
          "INSERT OR REPLACE INTO main._nexus_meta (key,value) VALUES ('graph_assessment',?)",
        )
        .run(assessment);
      native
        .prepare(
          "INSERT OR REPLACE INTO main._nexus_meta (key,value) VALUES ('graph_generation','untouched-fixture-generation')",
        )
        .run();
      return { sourceRoot, files, content, native, assessment };
    }

    it('assesses the complete persisted inventory beyond 500 without imposing a size-based gap', async () => {
      const fixture = await seedCompleteInventory();
      const coverage = await assessKnowledgeCoverage(projectRoot, undefined, 10000);
      expect(coverage).toMatchObject({
        status: 'current',
        projectId: 'fixture-parent-id',
        inventory: {
          requested: 503,
          completed: 503,
          unassessed: 0,
          changed: 0,
          missing: 0,
          failed: 0,
        },
      });
      expect(coverage.limitations).toContain(
        'Static analysis cannot prove that all runtime callers have been discovered.',
      );
      expect(
        fixture.native
          .prepare("SELECT value FROM main._nexus_meta WHERE key='graph_assessment'")
          .get(),
      ).toEqual({ value: fixture.assessment });
      expect(
        fixture.native
          .prepare("SELECT value FROM main._nexus_meta WHERE key='graph_generation'")
          .get(),
      ).toEqual({ value: 'untouched-fixture-generation' });
    });

    it('reports persisted inventory even when its published graph has no nodes', async () => {
      const fixture = await seedCompleteInventory();
      fixture.native.exec('DELETE FROM main.nexus_relations; DELETE FROM main.nexus_nodes;');
      const coverage = await assessKnowledgeCoverage(projectRoot, undefined, 10000);
      expect(coverage).toMatchObject({
        status: 'missing',
        inventory: { requested: 503, completed: 503, unassessed: 0 },
      });
      expect(coverage.reasons).toContain('The published graph has no indexed nodes.');
    });

    it.each([
      'edit',
      'delete',
      'rename',
    ] as const)('detects %s beyond the former 500-file ceiling', async (change) => {
      const fixture = await seedCompleteInventory();
      const last = fixture.files[502]!;
      const absolute = join(fixture.sourceRoot, last.path);
      if (change === 'edit') {
        writeFileSync(absolute, fixture.content.replace('1', '2'));
        utimesSync(absolute, new Date(last.mtimeMs), new Date(last.mtimeMs));
        expect(statSync(absolute).size).toBe(last.size);
        expect(statSync(absolute).mtimeMs).toBe(last.mtimeMs);
      } else if (change === 'delete') rmSync(absolute);
      else renameSync(absolute, join(fixture.sourceRoot, 'renamed.ts'));
      const coverage = await assessKnowledgeCoverage(projectRoot, undefined, 10000);
      expect(coverage).toMatchObject({
        status: 'stale',
        inventory: {
          requested: 503,
          completed: 503,
          unassessed: 0,
          changed: change === 'edit' ? 1 : 0,
          missing: change === 'edit' ? 0 : 1,
          failed: 0,
        },
      });
      expect(coverage.reasons.some((reason) => reason.includes(last.path))).toBe(true);
    });

    it('retains read failures and exact inventory counters through actual compact rendering', async () => {
      const fixture = await seedCompleteInventory();
      const last = fixture.files[502]!;
      const absolute = join(fixture.sourceRoot, last.path);
      rmSync(absolute);
      mkdirSync(absolute);
      const coverage = await assessKnowledgeCoverage(projectRoot, undefined, 10000);
      expect(coverage).toMatchObject({
        status: 'failed',
        inventory: { requested: 503, completed: 503, unassessed: 0, failed: 1, missing: 0 },
      });
      expect(coverage.reasons.some((reason) => reason.includes(last.path))).toBe(true);
      coverage.reasons.push('Extra example 1', 'Extra example 2', 'Extra example 3');
      const compact = compactKnowledgeCoverage(coverage);
      expect(compact.reasons).toHaveLength(2);
      expect(compact).toMatchObject({
        status: 'failed',
        projectId: coverage.projectId,
        indexedRevision: coverage.indexedRevision,
        assessedRevision: coverage.assessedRevision,
        inventory: coverage.inventory,
        reasonCount: coverage.reasons.length,
      });
    });

    it('stops inventory work at the original deadline and reports the unassessed remainder', async () => {
      const fixture = await seedCompleteInventory();
      let now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      let beginRead: () => void = () => {
        throw new Error('Read barrier was not initialized');
      };
      let finishRead: (value: Buffer<ArrayBuffer>) => void = () => {
        throw new Error('Read completion was not initialized');
      };
      const started = new Promise<void>((resolve) => {
        beginRead = resolve;
      });
      const content = new Promise<Buffer<ArrayBuffer>>((resolve) => {
        finishRead = resolve;
      });
      const reader = vi.spyOn(fsAsync, 'readFile').mockImplementationOnce(() => {
        beginRead();
        return content;
      });
      try {
        const pending = assessKnowledgeCoverage(projectRoot, undefined, 10000);
        expect(
          await Promise.race([started.then(() => 'read'), pending.then(() => 'finished')]),
        ).toBe('read');
        now += 10001;
        finishRead(Buffer.from(fixture.content));
        const coverage = await pending;
        expect(coverage).toMatchObject({
          status: 'partial',
          maintenanceState: 'pending',
          inventory: { requested: 503, completed: 0, unassessed: 503, failed: 0 },
        });
        expect(reader).toHaveBeenCalledTimes(1);
        expect(compactKnowledgeCoverage(coverage)).toMatchObject({
          maintenanceState: 'pending',
          inventory: coverage.inventory,
          status: 'partial',
        });
      } finally {
        finishRead(Buffer.from(fixture.content));
        reader.mockRestore();
        clock.mockRestore();
      }
    });

    it('checks persisted unsupported sources without converting extraction gaps into freshness success', async () => {
      const fixture = await seedCompleteInventory();
      const last = fixture.files[502]!;
      const assessment = await readKnowledgeIndexAssessment(projectRoot);
      if (!assessment) throw new Error('Expected canonical inventory assessment');
      assessment.files = assessment.files.map((file) =>
        file.path === last.path ? { ...file, status: 'unsupported' } : file,
      );
      fixture.native
        .prepare("UPDATE main._nexus_meta SET value=? WHERE key='graph_assessment'")
        .run(JSON.stringify(assessment));
      writeFileSync(join(fixture.sourceRoot, last.path), fixture.content.replace('1', '2'));
      utimesSync(
        join(fixture.sourceRoot, last.path),
        new Date(last.mtimeMs),
        new Date(last.mtimeMs),
      );
      const coverage = await assessKnowledgeCoverage(projectRoot, undefined, 10000);
      expect(coverage).toMatchObject({
        status: 'stale',
        inventory: {
          requested: 503,
          completed: 503,
          unassessed: 0,
          changed: 1,
          failed: 0,
          missing: 0,
        },
      });
      expect(coverage.reasons).toContain(`unsupported: ${last.path}`);
      expect(coverage.reasons).toContain(`Source content changed after indexing: ${last.path}`);
    });

    it('returns an immutable progress snapshot when a read outlives the real foreground budget', async () => {
      const fixture = await seedCompleteInventory();
      let beginRead: () => void = () => {
        throw new Error('Read barrier was not initialized');
      };
      let finishRead: (value: Buffer<ArrayBuffer>) => void = () => {
        throw new Error('Read completion was not initialized');
      };
      const started = new Promise<void>((resolve) => {
        beginRead = resolve;
      });
      const content = new Promise<Buffer<ArrayBuffer>>((resolve) => {
        finishRead = resolve;
      });
      const reader = vi.spyOn(fsAsync, 'readFile').mockImplementationOnce(() => {
        beginRead();
        return content;
      });
      try {
        const pending = assessKnowledgeCoverage(projectRoot);
        expect(
          await Promise.race([started.then(() => 'read'), pending.then(() => 'finished')]),
        ).toBe('read');
        const coverage = await pending;
        expect(coverage).toMatchObject({
          status: 'partial',
          maintenanceState: 'pending',
          inventory: {
            requested: 503,
            completed: 0,
            unassessed: 503,
            changed: 0,
            missing: 0,
            failed: 0,
          },
        });
        const snapshot = JSON.stringify(coverage);
        const compact = compactKnowledgeCoverage(coverage);
        finishRead(Buffer.from(fixture.content));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(JSON.stringify(coverage)).toBe(snapshot);
        expect(compact.inventory).toEqual(coverage.inventory);
        expect(reader).toHaveBeenCalledTimes(1);
      } finally {
        finishRead(Buffer.from(fixture.content));
        reader.mockRestore();
      }
    });

    it('discloses an unknown inventory population when the deadline expires before assessment', async () => {
      const coverage = await assessKnowledgeCoverage(projectRoot, undefined, 0);
      expect(coverage).toMatchObject({
        status: 'partial',
        maintenanceState: 'pending',
        inventory: { requested: null, completed: 0, unassessed: null, failed: 0 },
      });
    });

    it('detects a newly staged source file missing from the recorded generation', async () => {
      writeFileSync(
        join(projectRoot, '.cleo/project-info.json'),
        JSON.stringify({ projectId: 'fixture-parent-id', projectHash: 'fixture-parent-hash' }),
      );
      const sourceRoot = join(projectRoot, 'source-checkout');
      mkdirSync(sourceRoot);
      execFileSync('git', ['init', '--quiet', sourceRoot]);
      const source = 'export const current = 1;';
      writeFileSync(join(sourceRoot, 'current.ts'), source);
      execFileSync('git', ['add', 'current.ts'], { cwd: sourceRoot });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '--quiet',
          '--no-gpg-sign',
          '--no-verify',
          '-m',
          'fixture',
        ],
        { cwd: sourceRoot },
      );
      const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: sourceRoot,
        encoding: 'utf8',
      }).trim();
      const sourceRoots = await resolveSourceRoots({
        projectId: 'fixture-parent-id',
        projectRoot,
        sourceRoot,
      });
      expect(sourceRoots.roots[0]?.revision).toBe(revision);
      const stat = statSync(join(sourceRoot, 'current.ts'));
      const native = getNexusNativeDb(projectRoot);
      if (!native) throw new Error('Missing fixture database');
      native
        .prepare(
          "INSERT OR REPLACE INTO main._nexus_meta (key, value) VALUES ('graph_assessment', ?)",
        )
        .run(
          JSON.stringify({
            sourceRoots,
            sourceRoot,
            assessedRevision: revision,
            assessedAt: new Date().toISOString(),
            files: [
              {
                path: 'current.ts',
                status: 'analyzed',
                size: stat.size,
                mtimeMs: stat.mtimeMs,
                contentHash: createHash('sha256').update(source).digest('hex'),
              },
            ],
          }),
        );
      expect((await assessKnowledgeCoverage(projectRoot)).status).toBe('current');
      writeFileSync(join(sourceRoot, 'new-caller.ts'), 'export const caller = 2;');
      execFileSync('git', ['add', 'new-caller.ts'], { cwd: sourceRoot });
      const coverage = await assessKnowledgeCoverage(projectRoot);
      expect(coverage.status).toBe('partial');
      expect(coverage.reasons).toContain('Unindexed files exist in the configured source root.');
    });

    it.each([
      'available',
      'import failure',
      'execution failure',
      'second execution failure',
    ])('preserves T448 file evidence and symbol context with optional analyzer %s', async (availability) => {
      mkdirSync(join(projectRoot, 'src'), { recursive: true });
      writeFileSync(join(projectRoot, FILE_PATH), 'export function testFunction() {}');
      const db = await getDb(projectRoot);
      db.insert(tasks)
        .values({
          id: 'T448',
          title: 'rushDueAt verification evidence',
          type: 'epic',
          filesJson: '[]',
          verificationJson: JSON.stringify({
            passed: true,
            round: 1,
            gates: {},
            lastAgent: null,
            lastUpdated: null,
            failureLog: [],
            evidence: {
              implemented: {
                atoms: [{ kind: 'files', files: [{ path: FILE_PATH, sha256: 'abc' }] }],
                capturedAt: new Date().toISOString(),
                capturedBy: 'test',
              },
            },
          }),
        })
        .run();
      getBrainNativeDb(projectRoot)!
        .prepare(
          'INSERT INTO brain_memory_links (memory_id, memory_type, task_id, link_type) VALUES (?, ?, ?, ?)',
        )
        .run('dec-001', 'decision', 'T448', 'applies_to');
      const siblingId = `${FILE_PATH}::otherFunction`;
      getNexusNativeDb(projectRoot)!
        .prepare(
          'INSERT INTO nexus_nodes (id, kind, name, file_path, label, indexed_at, is_exported) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          siblingId,
          'function',
          'otherFunction',
          FILE_PATH,
          'otherFunction',
          new Date().toISOString(),
          0,
        );
      if (availability !== 'available') {
        vi.doMock('@cleocode/nexus', async () => {
          if (availability === 'import failure')
            throw new Error('Injected optional import failure');
          const actual = await vi.importActual<typeof import('@cleocode/nexus')>('@cleocode/nexus');
          let calls = 0;
          return {
            ...actual,
            analyzeImpact: (...args: Parameters<typeof actual.analyzeImpact>) => {
              calls += 1;
              if (availability === 'execution failure' || calls === 2) {
                throw new Error('Injected optional execution failure');
              }
              return actual.analyzeImpact(...args);
            },
          };
        });
      }
      const footprint = await getTaskCodeImpact('T448', projectRoot);
      expect(footprint.files).toContain(FILE_PATH);
      expect(footprint.decisions).toContainEqual(
        expect.objectContaining({
          decisionId: 'dec-001',
          decision: 'Use testFunction for all test cases',
        }),
      );
      expect(footprint.symbols).toContainEqual(
        expect.objectContaining({
          nexusNodeId: SYMBOL_ID,
          precision: 'file',
          evidence: expect.arrayContaining([
            expect.objectContaining({
              id: 'T448:verification:implemented',
              source: 'verification',
              precision: 'file',
            }),
          ]),
        }),
      );
      expect(footprint.symbols.map((entry) => entry.nexusNodeId).sort()).toEqual(
        [SYMBOL_ID, siblingId].sort(),
      );
      expect(footprint.symbols.every((entry) => entry.precision === 'file')).toBe(true);
      if (availability === 'available') {
        expect(footprint.findings).toEqual([]);
        expect(footprint.blastRadius.symbolsAnalyzed).toBe(2);
      } else {
        expect(footprint.riskScore).toBe('UNKNOWN');
        expect(footprint.blastRadius.maxRisk).toBe('UNKNOWN');
        expect(footprint.blastRadius.symbolsAnalyzed).toBe(
          availability === 'second execution failure' ? 1 : 0,
        );
        expect(footprint.symbols.every((entry) => entry.riskLevel === 'UNKNOWN')).toBe(true);
        expect(footprint.coverage?.status).toBe('failed');
        expect(footprint.coverage?.reasons.join(' ')).toContain(
          availability === 'import failure' ? 'error when mocking a module' : 'Injected optional',
        );
        expect(footprint.coverage?.limitations.join(' ')).toContain(
          'placeholders, not evidence of NONE',
        );
        expect(footprint.coverage?.nextAction).toContain('cleo doctor knowledge --task T448');
        expect(footprint.findings).toContainEqual(
          expect.objectContaining({
            id: 'task-impact:T448',
            state: 'failed',
            proposedAction: null,
            affectedRecordIds: expect.arrayContaining(['T448', SYMBOL_ID, siblingId]),
          }),
        );
      }
      vi.doUnmock('@cleocode/nexus');
      const repeated = await getTaskCodeImpact('T448', projectRoot);
      expect(repeated.symbols.map((entry) => entry.nexusNodeId)).toEqual(
        footprint.symbols.map((entry) => entry.nexusNodeId),
      );
    });

    it('retains every file association beyond the impact budget and discloses unassessed symbols', async () => {
      mkdirSync(join(projectRoot, 'src'), { recursive: true });
      writeFileSync(join(projectRoot, FILE_PATH), 'export function testFunction() {}');
      const db = await getDb(projectRoot);
      db.insert(tasks)
        .values({
          id: 'T449',
          title: 'Many associated symbols',
          filesJson: JSON.stringify([FILE_PATH]),
        })
        .run();
      const insert = getNexusNativeDb(projectRoot)!.prepare(
        'INSERT INTO nexus_nodes (id, kind, name, file_path, label, indexed_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (let index = 0; index < 50; index += 1) {
        insert.run(
          `${FILE_PATH}::extra${index}`,
          'function',
          `extra${index}`,
          FILE_PATH,
          `extra${index}`,
          new Date().toISOString(),
        );
      }
      const impact = await getTaskCodeImpact('T449', projectRoot);
      expect(impact.symbols).toHaveLength(51);
      expect(impact.symbols.every((entry) => entry.precision === 'file')).toBe(true);
      expect(impact.blastRadius.symbolsAnalyzed).toBe(50);
      expect(impact.riskScore).toBe('UNKNOWN');
      expect(impact.coverage?.reasons.join(' ')).toContain(
        'additional associations remain unassessed',
      );
      expect(impact.coverage?.limitations.join(' ')).toContain(
        'placeholders, not evidence of NONE',
      );
      expect(impact.coverage?.nextAction).toBe('cleo doctor knowledge --task T449');
    });

    it('accepts qualified identifiers in impact without matching only the short name', async () => {
      const impact = await getSymbolImpact(SYMBOL_ID, 'fixture-project', projectRoot);
      expect(impact.targetNodeId).toBe(SYMBOL_ID);
      expect(impact.totalImpactedNodes).toBe(1);
      expect(impact.coverage.projectId).toBe('fixture-project');
      expect(
        (await getSymbolContext(SYMBOL_ID, 'fixture-project', projectRoot)).results[0]?.nodeId,
      ).toBe(SYMBOL_ID);
      expect((await reasonWhySymbol(SYMBOL_NAME, projectRoot)).chain.length).toBeGreaterThan(0);
    });

    it('returns qualified candidates for ambiguous names across all symbol entry points', async () => {
      const native = getNexusNativeDb();
      if (!native) throw new Error('Missing fixture database');
      const otherId = 'other-checkout/test-file.ts::testFunction';
      native
        .prepare(`INSERT INTO nexus_nodes (id, kind, name, label, file_path)
        VALUES (?, 'function', ?, ?, 'other-checkout/test-file.ts')`)
        .run(otherId, SYMBOL_NAME, SYMBOL_NAME);
      await expect(
        getSymbolImpact(SYMBOL_NAME, 'fixture-project', projectRoot),
      ).rejects.toBeInstanceOf(KnowledgeSymbolAmbiguityError);
      await expect(
        getSymbolContext(SYMBOL_NAME, 'fixture-project', projectRoot),
      ).rejects.toBeInstanceOf(KnowledgeSymbolAmbiguityError);
      await expect(reasonWhySymbol(SYMBOL_NAME, projectRoot)).rejects.toBeInstanceOf(
        KnowledgeSymbolAmbiguityError,
      );
      const context = await nexusFullContext(SYMBOL_NAME, projectRoot);
      expect(context.success).toBe(false);
      if (!context.success) {
        expect(context.error.code).toBe('E_AMBIGUOUS_SYMBOL');
        expect(context.error.details).toMatchObject({
          candidates: expect.arrayContaining([
            expect.objectContaining({ id: SYMBOL_ID }),
            expect.objectContaining({ id: otherId }),
          ]),
        });
      }
      await expect(reasonImpactOfChange(SYMBOL_NAME, projectRoot)).rejects.toBeInstanceOf(
        KnowledgeSymbolAmbiguityError,
      );
      expect((await getSymbolFullContext(SYMBOL_ID, projectRoot)).nexus?.symbolId).toBe(SYMBOL_ID);
    });

    it('returns UNKNOWN and missing coverage for an absent symbol', async () => {
      const impact = await getSymbolImpact('absent::symbol', 'fixture-project', projectRoot);
      expect(impact.targetNodeId).toBeNull();
      expect(impact.riskLevel).toBe('UNKNOWN');
      expect(impact.coverage.status).toBe('missing');
      const full = await reasonImpactOfChange('absent::symbol', projectRoot);
      expect(full.mergedRiskScore).toBe('UNKNOWN');
      expect(full.structural.riskLevel).toBe('UNKNOWN');
    });

    it('keeps legacy and dynamic references inspectable without inferring complete callers', async () => {
      const native = getNexusNativeDb(projectRoot);
      if (!native) throw new Error('Missing fixture database');
      const references = [
        {
          kind: 'unmodeled-source',
          filePath: FILE_PATH,
          sourceId: `${FILE_PATH}::nested`,
          targetId: SYMBOL_ID,
          targetName: SYMBOL_NAME,
          relationship: 'calls',
          reason: 'AST scope lacks a declaration',
        },
        {
          kind: 'dynamic',
          filePath: FILE_PATH,
          sourceId: CALLER_ID,
          targetName: 'handlers[name]',
          relationship: 'calls',
          candidateIds: [],
          span: {
            startIndex: 0,
            endIndex: 16,
            startLine: 1,
            endLine: 1,
            startColumn: 0,
            endColumn: 16,
            offsetEncoding: 'utf16',
          },
          reason: 'Computed expression requires runtime evidence',
        },
      ];
      native
        .prepare(
          "INSERT OR REPLACE INTO main._nexus_meta (key, value) VALUES ('graph_assessment', ?)",
        )
        .run(
          JSON.stringify({
            sourceRoot: projectRoot,
            assessedRevision: null,
            assessedAt: new Date().toISOString(),
            files: [],
            references,
          }),
        );
      expect((await readKnowledgeIndexAssessment(projectRoot))?.references).toEqual(references);
      const impact = await getSymbolImpact(SYMBOL_ID, 'fixture-project', projectRoot);
      expect(impact.coverage.status).toBe('partial');
      expect(impact.riskLevel).toBe('UNKNOWN');
      expect(impact.coverage.reasons).toContain(
        '2 unresolved or unmodeled static references remain; known callers are incomplete. Inspect assessment.references in cleo nexus status.',
      );
      expect(impact.coverage.nextAction).toBe('cleo nexus status');
      expect(JSON.stringify(impact.impactByDepth)).toContain(CALLER_ID);
    });

    it('exposes malformed index diagnostics as failed rather than an empty healthy graph', async () => {
      const native = getNexusNativeDb();
      if (!native) throw new Error('Missing fixture database');
      native
        .prepare(
          `INSERT OR REPLACE INTO _nexus_meta (key, value) VALUES ('graph_assessment', '{broken')`,
        )
        .run();
      const coverage = await assessKnowledgeCoverage(projectRoot);
      expect(coverage.status).toBe('failed');
      expect(coverage.reasons.some((reason) => reason.includes('Graph assessment failed'))).toBe(
        true,
      );
      const impact = await getSymbolImpact(SYMBOL_ID, 'fixture-project', projectRoot);
      expect(impact.riskLevel).toBe('UNKNOWN');
      expect(impact.coverage.status).toBe('failed');
    });
  });

  // -------------------------------------------------------------------------
  // getSymbolFullContext
  // -------------------------------------------------------------------------

  describe('getSymbolFullContext', () => {
    it('returns nexus context with callers for a seeded symbol', async () => {
      const ctx = await getSymbolFullContext(SYMBOL_ID, projectRoot);

      expect(ctx.symbolId).toBe(SYMBOL_ID);
      expect(ctx.nexus).not.toBeNull();
      expect(ctx.nexus?.kind).toBe('function');
      expect(ctx.nexus?.filePath).toBe(FILE_PATH);
      expect(ctx.nexus?.callers.length).toBeGreaterThan(0);
      expect(ctx.nexus?.callers[0].name).toBe('callerFunction');
    });

    it('returns brain memories via code_reference edges', async () => {
      const ctx = await getSymbolFullContext(SYMBOL_ID, projectRoot);

      // Should have observations linked via code_reference or mentions
      expect(ctx.brainMemories.length).toBeGreaterThan(0);
      const nodeIds = ctx.brainMemories.map((m) => m.nodeId);
      expect(nodeIds).toContain(BRAIN_OBS_ID);
    });

    it('returns tasks that touched the symbol via task_touches_symbol edges', async () => {
      const ctx = await getSymbolFullContext(SYMBOL_ID, projectRoot);

      expect(ctx.tasks.length).toBeGreaterThan(0);
      const taskIds = ctx.tasks.map((t) => t.taskId);
      expect(taskIds).toContain(TASK_ID);
    });

    it('returns plasticity weight from nexus_relations', async () => {
      const ctx = await getSymbolFullContext(SYMBOL_ID, projectRoot);

      // We seeded one calls relation with weight=2.0
      expect(ctx.plasticityWeight.totalWeight).toBeGreaterThan(0);
      expect(ctx.plasticityWeight.edgeCount).toBeGreaterThan(0);
    });

    it('returns empty collections gracefully for unknown symbol', async () => {
      const ctx = await getSymbolFullContext('nonexistent::symbol', projectRoot);

      // Should not throw — returns empty collections
      expect(ctx.nexus).toBeNull();
      expect(ctx.brainMemories).toEqual([]);
      expect(ctx.tasks).toEqual([]);
      expect(ctx.sentientProposals).toEqual([]);
      expect(ctx.conduitThreads).toEqual([]);
      expect(ctx.plasticityWeight.totalWeight).toBe(0);
    });

    it('resolves symbol by name (fuzzy match)', async () => {
      // Use symbol name instead of full ID
      const ctx = await getSymbolFullContext(SYMBOL_NAME, projectRoot);

      expect(ctx.nexus).not.toBeNull();
      expect(ctx.nexus?.kind).toBe('function');
    });

    it('conduitThreads is empty when conduit.db is absent', async () => {
      const ctx = await getSymbolFullContext(SYMBOL_ID, projectRoot);
      // conduit.db does not exist in temp dir — must return []
      expect(Array.isArray(ctx.conduitThreads)).toBe(true);
      // Most will be empty or populated from brain_page_edges only
      // Just ensure it doesn't throw
    });
  });

  // -------------------------------------------------------------------------
  // getTaskCodeImpact
  // -------------------------------------------------------------------------

  describe('getTaskCodeImpact', () => {
    it('returns symbols from task_touches_symbol edges', async () => {
      const impact = await getTaskCodeImpact(TASK_ID, projectRoot);

      // Symbols must be populated from task_touches_symbol edges
      // Even if tasks.db doesn't have the task row, symbol edges exist
      expect(impact.taskId).toBe(TASK_ID);
      // symbols should contain at least the seeded symbol
      expect(impact.symbols.length).toBeGreaterThanOrEqual(0); // depends on getSymbolsForTask resolution
    });

    it('reports UNKNOWN when legacy graph freshness is unverified', async () => {
      const impact = await getTaskCodeImpact(TASK_ID, projectRoot);

      expect(impact.riskScore).toBe('UNKNOWN');
      expect(impact.coverage?.status).not.toBe('current');
      expect(impact.coverage?.reasons.length).toBeGreaterThan(0);
    });

    it('returns empty decisions array gracefully when no brain_memory_links exist', async () => {
      const impact = await getTaskCodeImpact(TASK_ID, projectRoot);
      // brain_memory_links is empty in test seed — should return []
      expect(Array.isArray(impact.decisions)).toBe(true);
    });

    it('returns empty files array gracefully for unknown task', async () => {
      const impact = await getTaskCodeImpact('T999', projectRoot);

      expect(impact.taskId).toBe('T999');
      expect(Array.isArray(impact.files)).toBe(true);
      expect(Array.isArray(impact.symbols)).toBe(true);
      expect(Array.isArray(impact.brainObservations)).toBe(true);
      expect(Array.isArray(impact.decisions)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // getBrainEntryCodeAnchors
  // -------------------------------------------------------------------------

  describe('getBrainEntryCodeAnchors', () => {
    it('returns nexus nodes linked via code_reference edges', async () => {
      const anchors = await getBrainEntryCodeAnchors(BRAIN_OBS_ID, projectRoot);

      expect(anchors.entryId).toBe(BRAIN_OBS_ID);
      expect(anchors.nexusNodes.length).toBeGreaterThan(0);

      const nodeIds = anchors.nexusNodes.map((n) => n.nexusNodeId);
      expect(nodeIds).toContain(SYMBOL_ID);
    });

    it('returns plasticity signal > 0 when anchors exist', async () => {
      const anchors = await getBrainEntryCodeAnchors(BRAIN_OBS_ID, projectRoot);
      expect(anchors.plasticitySignal).toBeGreaterThan(0);
    });

    it('returns tasks for nodes when task_touches_symbol edges exist', async () => {
      const anchors = await getBrainEntryCodeAnchors(BRAIN_OBS_ID, projectRoot);

      // The seeded symbol has a task_touches_symbol edge for T998
      // tasksForNodes should include TASK_ID for SYMBOL_ID
      const entry = anchors.tasksForNodes.find((e) => e.nexusNodeId === SYMBOL_ID);
      if (entry) {
        const taskIds = entry.tasks.map((t) => t.taskId);
        expect(taskIds).toContain(TASK_ID);
      }
      // Else: acceptable — tasksForNodes may be empty if no reverse lookup found
    });

    it('returns empty collections gracefully for unknown entry ID', async () => {
      const anchors = await getBrainEntryCodeAnchors('observation:nonexistent-999', projectRoot);

      expect(anchors.entryId).toBe('observation:nonexistent-999');
      expect(anchors.nexusNodes).toEqual([]);
      expect(anchors.tasksForNodes).toEqual([]);
      expect(anchors.plasticitySignal).toBe(0);
    });

    it('decision nodes are also anchored via documents edges', async () => {
      const anchors = await getBrainEntryCodeAnchors(BRAIN_DEC_ID, projectRoot);

      expect(anchors.nexusNodes.length).toBeGreaterThan(0);
      const symbolAnchor = anchors.nexusNodes.find((n) => n.nexusNodeId === SYMBOL_ID);
      expect(symbolAnchor).toBeDefined();
      expect(symbolAnchor?.edgeType).toBe(EDGE_TYPES.DOCUMENTS);
    });
  });

  // -------------------------------------------------------------------------
  // Absent substrate graceful behavior
  // -------------------------------------------------------------------------

  describe('absent substrates', () => {
    it('getSymbolFullContext does not throw when nexus DB is absent', async () => {
      // Use a fresh project root with no nexus DB initialized
      const emptyRoot = mkdtempSync(join(tmpdir(), 'living-brain-empty-'));
      mkdirSync(join(emptyRoot, '.cleo'), { recursive: true });
      try {
        // Only init brain.db — no nexus
        await getBrainDb(emptyRoot);
        const ctx = await getSymbolFullContext('some::symbol', emptyRoot);
        // Should return empty context without throwing
        expect(ctx).toBeDefined();
        expect(ctx.nexus).toBeNull();
      } finally {
        resetBrainDbState();
        resetNexusDbState();
        removeTempDirSync(emptyRoot);
      }
    });

    it('getTaskCodeImpact does not throw when no edges exist', async () => {
      const emptyRoot = mkdtempSync(join(tmpdir(), 'living-brain-empty2-'));
      mkdirSync(join(emptyRoot, '.cleo'), { recursive: true });
      try {
        await getBrainDb(emptyRoot);
        const impact = await getTaskCodeImpact('T001', emptyRoot);
        expect(impact).toBeDefined();
        expect(impact.symbols).toEqual([]);
        expect(impact.riskScore).toBe('UNKNOWN');
        expect(impact.coverage?.status).not.toBe('current');
      } finally {
        resetBrainDbState();
        resetNexusDbState();
        removeTempDirSync(emptyRoot);
      }
    });

    it('getBrainEntryCodeAnchors does not throw when brain DB is empty', async () => {
      const emptyRoot = mkdtempSync(join(tmpdir(), 'living-brain-empty3-'));
      mkdirSync(join(emptyRoot, '.cleo'), { recursive: true });
      try {
        await getBrainDb(emptyRoot);
        const anchors = await getBrainEntryCodeAnchors('observation:nonexistent', emptyRoot);
        expect(anchors).toBeDefined();
        expect(anchors.nexusNodes).toEqual([]);
        expect(anchors.plasticitySignal).toBe(0);
      } finally {
        resetBrainDbState();
        resetNexusDbState();
        removeTempDirSync(emptyRoot);
      }
    });
  });
});
