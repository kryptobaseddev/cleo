/**
 * Sanitized scenario map of the 26 preserved external audit probes.
 * Commands contain fixture bindings, never original record IDs or response payloads.
 * This map validates replay inputs; domain regression suites verify the behavior.
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeTempDirSync } from '../../__tests__/test-cleanup.js';
import { runKnowledgeDoctor } from '../../doctor/knowledge.js';
import { resetFts5Cache } from '../../memory/brain-search.js';
import { linkObservationToModifiedFiles } from '../../memory/graph-memory-bridge.js';
import { searchBrainCompact } from '../../memory/retrieval/search.js';
import { getBrainAccessor } from '../../store/memory-accessor.js';
import { getBrainDb, getBrainNativeDb, resetBrainDbState } from '../../store/memory-sqlite.js';
import { getNexusDb, getNexusNativeDb, resetNexusDbState } from '../../store/nexus-sqlite.js';
import { getDb } from '../../store/sqlite.js';
import { tasks } from '../../store/tasks-schema.js';
import { nexusTaskSymbols } from '../api-contracts.js';
import { getSymbolImpact, nexusImpact } from '../impact.js';
import { assessKnowledgeCoverage, KnowledgeSymbolAmbiguityError } from '../knowledge.js';
import { getSymbolFullContext, getTaskCodeImpact } from '../living-brain.js';
import { getTaskKnowledgeEvidence } from '../task-evidence.js';

const scenarios = [
  {
    record: 1,
    command: 'cleo briefing',
    category: 'authority',
    postcondition: 'Current guidance is distinct from historical handoffs.',
  },
  {
    record: 2,
    command: 'cleo nexus status',
    category: 'coverage',
    postcondition: 'Missing or stale graph is explicit.',
  },
  {
    record: 3,
    command: 'cleo memory graph-stats',
    category: 'coverage',
    postcondition: 'Counts do not imply semantic health.',
  },
  {
    record: 4,
    command: 'cleo memory doctor',
    category: 'diagnostics',
    postcondition: 'Structural, semantic and extraction failures remain distinct.',
  },
  {
    record: 5,
    command: 'cleo memory llm-status',
    category: 'capabilities',
    postcondition: 'Unavailable optional synthesis does not block sourced repair.',
  },
  {
    record: 6,
    command: 'cleo memory prune-stubs',
    category: 'recovery',
    postcondition: 'Noise quarantine is narrow, reversible and idempotent.',
  },
  {
    record: 7,
    command: "cleo memory decision-find --query ''",
    category: 'authority',
    postcondition: 'Decision listing excludes invalidated and superseded records.',
  },
  {
    record: 8,
    command: "cleo memory find 'obsolete wording' --limit 5",
    category: 'authority',
    postcondition: 'Historical wording resolves sourced current successors.',
  },
  {
    record: 9,
    command: "cleo memory find 'fixture' --type decision",
    category: 'filtering',
    postcondition: 'All returned items are decisions.',
  },
  {
    record: 10,
    command: 'cleo memory fetch OBSERVATION_A',
    category: 'history',
    postcondition: 'Historical observation remains accessible by ID.',
  },
  {
    record: 11,
    command: 'cleo memory fetch OBSERVATION_B',
    category: 'history',
    postcondition: 'Actionable incident evidence remains accessible.',
  },
  {
    record: 12,
    command: 'cleo focus TASK_WITH_EVIDENCE',
    category: 'workflow',
    postcondition: 'Task evidence and uncertainty are visible.',
  },
  {
    record: 13,
    command: 'cleo focus TASK_WITHOUT_EVIDENCE',
    category: 'workflow',
    postcondition: 'Missing evidence does not imply no impact.',
  },
  {
    record: 14,
    command: 'cleo show TASK_WITH_EVIDENCE --full',
    category: 'evidence',
    postcondition: 'Full task record preserves verification evidence.',
  },
  {
    record: 15,
    command: 'cleo nexus impact FIELD --why',
    category: 'impact',
    postcondition: 'Absent graph produces UNKNOWN impact.',
  },
  {
    record: 16,
    command: 'cleo nexus full-context FIELD',
    category: 'coverage',
    postcondition: 'Context includes coverage limitations.',
  },
  {
    record: 17,
    command: 'cleo nexus context SYMBOL',
    category: 'ambiguity',
    postcondition: 'Ambiguous short names expose candidates.',
  },
  {
    record: 18,
    command: 'cleo nexus impact SYMBOL --why',
    category: 'ambiguity',
    postcondition: 'Impact does not silently select a checkout.',
  },
  {
    record: 19,
    command: "cleo nexus full-context 'REPOSITORY/src/module.ts::SYMBOL'",
    category: 'resolution',
    postcondition: 'Qualified identifiers resolve consistently.',
  },
  {
    record: 20,
    command: "cleo nexus impact 'REPOSITORY/src/module.ts::SYMBOL' --why",
    category: 'resolution',
    postcondition: 'Qualified impact uses the exact requested source.',
  },
  {
    record: 21,
    command: 'cleo nexus why SYMBOL',
    category: 'evidence',
    postcondition: 'Authority explanation identifies evidence.',
  },
  {
    record: 22,
    command: 'cleo nexus task-symbols TASK_WITH_EVIDENCE',
    category: 'evidence',
    postcondition: 'Structured verification contributes precision-aware links.',
  },
  {
    record: 23,
    command: 'cleo nexus task-symbols TASK_WITHOUT_EVIDENCE',
    category: 'coverage',
    postcondition: 'Missing linkage is explicit.',
  },
  {
    record: 24,
    command: 'cleo nexus task-footprint TASK_WITH_EVIDENCE',
    category: 'evidence',
    postcondition: 'Evidence-derived footprint does not claim every file symbol changed.',
  },
  {
    record: 25,
    command: 'cleo nexus flows',
    category: 'coverage',
    postcondition: 'Static flow limitations remain explicit.',
  },
  {
    record: 26,
    command: 'cleo memory find --help',
    category: 'filtering',
    postcondition: 'Help advertises decision type and explicit history retrieval.',
  },
] as const;

describe('preserved audit replay scenario map', () => {
  it('maps all original probe ordinals without original private payloads', () => {
    expect(scenarios.map((scenario) => scenario.record)).toEqual(
      Array.from({ length: 26 }, (_, index) => index + 1),
    );
    expect(new Set(scenarios.map((scenario) => scenario.command)).size).toBe(26);
  });
  it.each(scenarios)('probe $record: $category — $postcondition', (scenario) => {
    expect(scenario.command).toMatch(/^cleo (briefing|nexus|memory|focus|show)( |$)/);
    expect(scenario.postcondition.length).toBeGreaterThan(20);
    expect(scenario.command).not.toMatch(/O-[a-z0-9]+|T\d+|axiom-app/);
  });
});

/** Six behavioral groups exercise shared contracts behind related audit probes. */
describe('preserved audit failure modes against synthetic project stores', () => {
  let root: string;
  let oldDir: string | undefined;
  let oldHome: string | undefined;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cleo-audit-contracts-'));
    mkdirSync(join(root, '.cleo'));
    oldDir = process.env['CLEO_DIR'];
    oldHome = process.env['CLEO_HOME'];
    process.env['CLEO_DIR'] = join(root, '.cleo');
    process.env['CLEO_HOME'] = join(root, 'home');
    await getBrainDb(root);
    await getNexusDb(root);
    const brain = await getBrainAccessor(root);
    await brain.addDecision({
      id: 'old-guidance',
      type: 'architecture',
      decision: 'Use obsolete vector transport',
      rationale: 'Previous policy',
      confidence: 'high',
    });
    await brain.addDecision({
      id: 'current-guidance',
      type: 'architecture',
      decision: 'Use the maintained transport',
      rationale: 'Explicit project correction',
      confidence: 'high',
    });
    await brain.updateDecision('old-guidance', {
      supersededBy: 'current-guidance',
      confirmationState: 'superseded',
    });
    const db = getBrainNativeDb(root);
    if (!db) throw new Error('Synthetic knowledge store unavailable');
    db.prepare(
      "INSERT INTO main.brain_observations (id, type, title, narrative) VALUES ('incident', 'discovery', 'Image expiry incident', 'The signed image URL expired; regenerate it before rendering.')",
    ).run();
    db.prepare(
      "INSERT INTO main.brain_observations (id, type, title, narrative) VALUES ('stub', 'discovery', 'Task complete: T900', 'Task T900 completed with status: undefined')",
    ).run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetFts5Cache();
    resetBrainDbState();
    resetNexusDbState();
    if (oldDir === undefined) delete process.env['CLEO_DIR'];
    else process.env['CLEO_DIR'] = oldDir;
    if (oldHome === undefined) delete process.env['CLEO_HOME'];
    else process.env['CLEO_HOME'] = oldHome;
    removeTempDirSync(root);
  });

  function seedSymbol(file: string, name: string): string {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), `export function ${name}() {}`);
    const db = getNexusNativeDb(root);
    if (!db) throw new Error('Synthetic graph store unavailable');
    const id = `${file}::${name}`;
    db.prepare(
      'INSERT INTO main.nexus_nodes (id, kind, name, file_path, label, indexed_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, 'function', name, file, name, new Date().toISOString());
    return id;
  }

  it('probes 2/15: an absent graph returns UNKNOWN rather than zero-impact assurance', async () => {
    const operation = await nexusImpact(root, {
      symbol: 'entryPoint',
      projectId: 'synthetic-project',
      why: true,
      depth: 2,
    });
    expect(operation.success).toBe(true);
    expect(operation.data).toMatchObject({
      query: 'entryPoint',
      projectId: 'synthetic-project',
      why: true,
      maxDepth: 2,
      riskLevel: 'UNKNOWN',
      coverage: { status: 'missing' },
    });
    const impact = await getSymbolImpact('entryPoint', 'synthetic-project', root);
    expect(impact.riskLevel).toBe('UNKNOWN');
    expect(impact.coverage.status).toBe('missing');
    expect(impact.coverage.reasons.length).toBeGreaterThan(0);
    expect(impact.coverage.limitations.join(' ')).toContain('runtime callers');
  });

  it('probes 16–20: identical checkout names require qualification and exact IDs select the requested source', async () => {
    const first = seedSymbol('checkout-one/src/service.ts', 'entryPoint');
    const second = seedSymbol('checkout-two/src/service.ts', 'entryPoint');
    await expect(getSymbolFullContext('entryPoint', root)).rejects.toBeInstanceOf(
      KnowledgeSymbolAmbiguityError,
    );
    const selected = await getSymbolFullContext(second, root);
    expect(selected.nexus?.symbolId).toBe(second);
    expect(selected.nexus?.symbolId).not.toBe(first);
    const impact = await getSymbolImpact(second, 'synthetic-project', root);
    expect(impact.targetNodeId).toBe(second);
    expect(impact.riskLevel).toBe('UNKNOWN');
  });

  it('probes 12–14/22–24: verification-only files produce file-precision footprints while absent task evidence stays UNKNOWN', async () => {
    const file = 'src/affected.ts';
    const symbol = seedSymbol(file, 'affectedFunction');
    const db = await getDb(root);
    db.insert(tasks)
      .values({
        id: 'T900',
        title: 'Verification-only change',
        type: 'task',
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
              atoms: [{ kind: 'files', files: [{ path: file, sha256: 'synthetic' }] }],
              capturedAt: new Date().toISOString(),
              capturedBy: 'fixture',
            },
          },
        }),
      })
      .run();
    db.insert(tasks)
      .values({ id: 'T901', title: 'No recorded file evidence', type: 'task', filesJson: '[]' })
      .run();
    const linked = await getTaskCodeImpact('T900', root);
    expect(linked.files).toEqual([file]);
    expect(linked.symbols).toContainEqual(
      expect.objectContaining({
        nexusNodeId: symbol,
        precision: 'file',
        evidence: expect.arrayContaining([expect.objectContaining({ source: 'verification' })]),
      }),
    );
    const empty = await getTaskCodeImpact('T901', root);
    expect(empty.files).toEqual([]);
    expect(empty.riskScore).toBe('UNKNOWN');
  });

  it('resolves verification paths and commits only through a uniquely matching explicitly included repository', async () => {
    const file = 'included-app/src/change.ts';
    const symbol = seedSymbol(file, 'includedChange');
    const checkout = join(root, 'included-app');
    execFileSync('git', ['init', '--quiet', checkout]);
    execFileSync('git', ['add', 'src/change.ts'], { cwd: checkout });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'Fixture evidence',
      ],
      { cwd: checkout },
    );
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: checkout,
      encoding: 'utf8',
    }).trim();
    const graph = getNexusNativeDb(root);
    if (!graph) throw new Error('Synthetic graph unavailable');
    graph.prepare("INSERT INTO main._nexus_meta (key, value) VALUES ('graph_assessment', ?)").run(
      JSON.stringify({
        sourceRoot: root,
        assessedRevision: null,
        assessedAt: new Date().toISOString(),
        includedRepositories: ['included-app'],
        files: [],
      }),
    );
    (await getDb(root))
      .insert(tasks)
      .values({
        id: 'T902',
        title: 'Nested evidence',
        type: 'task',
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
              atoms: [
                { kind: 'files', files: [{ path: 'src/change.ts', sha256: 'synthetic' }] },
                { kind: 'commit', sha: commit },
              ],
              capturedAt: new Date().toISOString(),
              capturedBy: 'fixture',
            },
          },
        }),
      })
      .run();
    const evidence = await getTaskKnowledgeEvidence('T902', root);
    expect(evidence.files).toHaveLength(1);
    expect(evidence.files[0]).toMatchObject({
      path: file,
      resolvedPath: join(root, file),
      evidence: expect.arrayContaining([
        expect.objectContaining({ source: 'commit', revision: commit }),
        expect.objectContaining({ source: 'verification', precision: 'file' }),
      ]),
    });
    expect(evidence.findings).toEqual([]);
    const response = await nexusTaskSymbols('T902', root);
    expect(response.success).toBe(true);
    if (!response.success) throw new Error('Expected successful task symbols');
    expect(response.data?.coverage?.status).toBeDefined();
    expect(response.data?.symbols).toContainEqual(
      expect.objectContaining({ nexusNodeId: symbol, precision: 'file' }),
    );
    seedSymbol('second-app/src/change.ts', 'otherChange');
    graph.prepare("UPDATE main._nexus_meta SET value = ? WHERE key = 'graph_assessment'").run(
      JSON.stringify({
        sourceRoot: root,
        assessedRevision: null,
        assessedAt: new Date().toISOString(),
        includedRepositories: ['included-app', 'second-app'],
        files: [],
      }),
    );
    const ambiguous = await getTaskKnowledgeEvidence('T902', root);
    expect(
      ambiguous.findings.some((finding) =>
        finding.description.includes('Ambiguous evidence path src/change.ts'),
      ),
    ).toBe(true);
    expect(
      ambiguous.files.find((entry) => entry.path === 'src/change.ts')?.resolvedPath,
    ).toBeNull();
    graph.prepare("UPDATE main._nexus_meta SET value = ? WHERE key = 'graph_assessment'").run(
      JSON.stringify({
        sourceRoot: root,
        assessedRevision: null,
        assessedAt: new Date().toISOString(),
        files: [],
      }),
    );
    const excluded = await getTaskKnowledgeEvidence('T902', root);
    expect(excluded.files.find((entry) => entry.path === 'src/change.ts')?.resolvedPath).toBeNull();
    expect(
      excluded.findings.some((finding) =>
        finding.description.includes('Commit cannot be resolved'),
      ),
    ).toBe(true);
  });

  it('defers expired evidence work using the caller deadline without claiming missing sources', async () => {
    const coverage = await assessKnowledgeCoverage(root);
    coverage.status = 'current';
    coverage.reasons = [];
    vi.spyOn(Date, 'now').mockReturnValue(5000);
    const result = await getTaskKnowledgeEvidence('T900', root, coverage, 4999);
    expect(result.coverage.status).toBe('partial');
    expect(result.coverage.maintenanceState).toBe('pending');
    expect(result.coverage.nextAction).toContain('doctor knowledge --task T900');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.description).toContain('remaining sources are unassessed');
    expect(result.coverage.reasons.join(' ')).not.toContain('not available');
  });

  it('modified-file observations link only the canonical file node even when symbols were inserted first', async () => {
    const file = 'src/observed.ts';
    const symbol = seedSymbol(file, 'observedFunction');
    const graph = getNexusNativeDb(root);
    const brain = getBrainNativeDb(root);
    if (!graph || !brain) throw new Error('Synthetic graph unavailable');
    expect(
      await linkObservationToModifiedFiles('observation:incident', JSON.stringify([file]), root),
    ).toBe(0);
    graph
      .prepare(
        'INSERT INTO main.nexus_nodes (id, kind, file_path, label, indexed_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(file, 'file', file, file, new Date().toISOString());
    expect(
      await linkObservationToModifiedFiles('observation:incident', JSON.stringify([file]), root),
    ).toBe(1);
    expect(
      await linkObservationToModifiedFiles('observation:incident', JSON.stringify([file]), root),
    ).toBe(0);
    const edges = brain
      .prepare(
        "SELECT from_id, provenance FROM main.brain_page_edges WHERE to_id = 'observation:incident' AND edge_type = 'modified_by'",
      )
      .all();
    expect(edges).toHaveLength(1);
    expect(edges[0]?.from_id).toBe(file);
    expect(edges[0]?.from_id).not.toBe(symbol);
    const provenance = edges[0]?.provenance;
    if (typeof provenance !== 'string') throw new Error('Missing file precision provenance');
    expect(JSON.parse(provenance)).toMatchObject({
      source: 'observation.files_modified_json',
      precision: 'file',
      filePath: file,
      assessedRevision: null,
    });
  });

  it('probes 7–9: obsolete wording returns its current successor with decision-only results', async () => {
    const result = await searchBrainCompact(root, {
      query: 'obsolete vector',
      tables: ['decisions'],
    });
    expect(result.results).toEqual([
      expect.objectContaining({
        id: 'current-guidance',
        type: 'decision',
        matchedHistoricalIds: ['old-guidance'],
      }),
    ]);
    expect((await (await getBrainAccessor(root)).getDecision('old-guidance'))?.decision).toBe(
      'Use obsolete vector transport',
    );
  });

  it('probe 10: explicit history retains the original decision without substituting its successor', async () => {
    const result = await searchBrainCompact(root, {
      query: 'obsolete vector',
      tables: ['decisions'],
      includeHistory: true,
    });
    expect(result.results.map((hit) => hit.id)).toContain('old-guidance');
    expect(result.results.every((hit) => hit.type === 'decision')).toBe(true);
  });

  it('probes 5/6/11: deterministic quarantine preserves incident retrieval and can restore the original record', async () => {
    const applied = await runKnowledgeDoctor(root, { fix: true, budgetMs: 10000 });
    const receipt = applied.receipts[0];
    expect(receipt?.state).toBe('repaired');
    const incident = await searchBrainCompact(root, { query: 'image expiry' });
    expect(incident.results.map((hit) => hit.id)).toContain('incident');
    const db = getBrainNativeDb(root);
    expect(
      db?.prepare("SELECT invalid_at FROM main.brain_observations WHERE id = 'stub'").get()
        ?.invalid_at,
    ).toBeTypeOf('string');
    if (!receipt) throw new Error('Expected reversible repair receipt');
    const restored = await runKnowledgeDoctor(root, { rollback: receipt.id, budgetMs: 10000 });
    expect(restored.receipts[0]?.state).toBe('unresolved');
    expect(
      db?.prepare("SELECT invalid_at FROM main.brain_observations WHERE id = 'stub'").get()
        ?.invalid_at,
    ).toBeNull();
  });
});
