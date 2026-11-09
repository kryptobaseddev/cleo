/**
 * T14365: `nexus impact` judges coverage by the files an answer rests on.
 *
 * A failed file elsewhere in the project makes the answer `partial` (callers
 * may be missing) instead of hiding every caller; a failed target or caller
 * file keeps the answer UNKNOWN with its reason; the default reply is bounded.
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphIndexFileReport } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeTempDirSync } from '../../__tests__/test-cleanup.js';
import { getNexusDb, getNexusNativeDb, resetNexusDbState } from '../../store/nexus-sqlite.js';
import { getSymbolImpact } from '../impact.js';
import { assessKnowledgeCoverage } from '../knowledge.js';
import { resolveSourceRoots } from '../source-roots.js';

const PROJECT_ID = 'fixture-project';
const TARGET_FILE = 'src/target.ts';
const CALLER_FILE = 'src/caller.ts';
const BROKEN_FILE = 'src/broken.ts';
const TARGET_ID = `${TARGET_FILE}::target`;
const CALLER_ID = `${CALLER_FILE}::caller`;
const BROKEN_ID = `${BROKEN_FILE}::brokenSymbol`;

const capabilities = (): NonNullable<GraphIndexFileReport['capabilities']> => {
  const all = [
    'file-evidence',
    'declarations',
    'imports',
    'call-references',
    'access-references',
    'type-heritage',
  ] as const;
  return {
    role: 'executable',
    classification: { basis: 'path-and-content', reason: 'Fixture TypeScript source' },
    requested: [...all],
    completed: [...all],
    limitations: ['Static extraction does not prove all runtime calls.'],
  };
};

describe('nexus impact scoped coverage (T14365)', () => {
  let projectRoot: string;
  let prevCleoDir: string | undefined;
  let prevCleoHome: string | undefined;

  beforeEach(async () => {
    projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'impact-scoped-')));
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    prevCleoDir = process.env['CLEO_DIR'];
    prevCleoHome = process.env['CLEO_HOME'];
    process.env['CLEO_DIR'] = join(projectRoot, '.cleo');
    process.env['CLEO_HOME'] = join(projectRoot, 'home');
    await getNexusDb();
  });

  afterEach(() => {
    resetNexusDbState();
    if (prevCleoDir === undefined) delete process.env['CLEO_DIR'];
    else process.env['CLEO_DIR'] = prevCleoDir;
    if (prevCleoHome === undefined) delete process.env['CLEO_HOME'];
    else process.env['CLEO_HOME'] = prevCleoHome;
    removeTempDirSync(projectRoot);
  });

  /** Commit the source files, publish an assessment, and seed target ← caller (← brokenSymbol). */
  async function seed(opts: {
    failed: string[];
    extraFailed?: number;
    excluded?: number;
    /** Source root as a subdirectory of the project root (graph paths are relative to it). */
    sourceDir?: string;
  }): Promise<void> {
    const sourceRoot = opts.sourceDir ? join(projectRoot, opts.sourceDir) : projectRoot;
    mkdirSync(join(sourceRoot, 'src'), { recursive: true });
    execFileSync('git', ['init', '--quiet', sourceRoot]);
    writeFileSync(join(sourceRoot, '.git/info/exclude'), '.cleo/\nhome/\n');
    const paths = [TARGET_FILE, CALLER_FILE, BROKEN_FILE];
    for (let index = 0; index < (opts.extraFailed ?? 0); index++)
      paths.push(`src/unrelated-${index}.ts`);
    const files: GraphIndexFileReport[] = paths.map((path) => {
      const content = `// ${path}\nexport const value = 1;\n`;
      const absolute = join(sourceRoot, path);
      writeFileSync(absolute, content);
      const stat = statSync(absolute);
      const failed = opts.failed.includes(path) || path.startsWith('src/unrelated-');
      return {
        path,
        status: failed ? 'failed' : 'analyzed',
        ...(failed ? { reason: `E_PARSE_SYNTAX: ${'unexpected token '.repeat(12)}` } : {}),
        capabilities: capabilities(),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        contentHash: createHash('sha256').update(content).digest('hex'),
      };
    });
    for (let index = 0; index < (opts.excluded ?? 0); index++)
      files.push({
        path: `vendor/excluded-${index}`,
        status: 'excluded',
        reason: `Excluded by fixture policy ${'padding '.repeat(20)}`,
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
        'fixture',
      ],
      { cwd: sourceRoot },
    );
    const sourceRoots = await resolveSourceRoots({
      projectId: PROJECT_ID,
      projectRoot,
      sourceRoot,
    });
    const native = getNexusNativeDb();
    if (!native) throw new Error('Missing fixture database');
    native
      .prepare("INSERT OR REPLACE INTO main._nexus_meta (key,value) VALUES ('graph_assessment',?)")
      .run(
        JSON.stringify({
          sourceRoots,
          sourceRoot,
          assessedRevision: sourceRoots.roots[0]?.revision,
          assessedAt: new Date().toISOString(),
          files,
        }),
      );
    const node = native.prepare(
      'INSERT INTO nexus_nodes (id, kind, name, file_path, label, indexed_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const now = new Date().toISOString();
    node.run(TARGET_ID, 'function', 'target', TARGET_FILE, 'target', now);
    node.run(CALLER_ID, 'function', 'caller', CALLER_FILE, 'caller', now);
    node.run(BROKEN_ID, 'function', 'brokenSymbol', BROKEN_FILE, 'brokenSymbol', now);
    const relation = native.prepare(
      "INSERT INTO nexus_relations (id, source_id, target_id, type, confidence) VALUES (?, ?, ?, 'calls', 1)",
    );
    relation.run('rel-caller-target', CALLER_ID, TARGET_ID);
  }

  it('control: with every file analyzed the answer is current and tiered', async () => {
    await seed({ failed: [] });
    const impact = await getSymbolImpact('target', PROJECT_ID, projectRoot);
    expect(impact.coverage.status).toBe('current');
    expect(impact.targetNodeId).toBe(TARGET_ID);
    expect(impact.totalImpactedNodes).toBe(1);
    expect(impact.riskLevel).toBe('LOW');
  });

  it('AC1: an unrelated failed file leaves callers visible and reports partial with the failed count', async () => {
    await seed({ failed: [BROKEN_FILE] });
    // The project-wide assessment is failed — the state that used to empty every answer.
    expect((await assessKnowledgeCoverage(projectRoot, PROJECT_ID)).status).toBe('failed');
    const impact = await getSymbolImpact('target', PROJECT_ID, projectRoot);
    expect(impact.targetNodeId).toBe(TARGET_ID);
    expect(impact.totalImpactedNodes).toBe(1);
    expect(impact.impactByDepth[0]?.nodes.map((node) => node.nodeId)).toEqual([CALLER_ID]);
    expect(impact.coverage.status).toBe('partial');
    expect(impact.coverage.capabilities?.extractionFailedFiles).toBe(1);
    expect(impact.coverage.reasons).toContain(
      '1 indexed file(s) outside this answer have coverage gaps, 1 of them failed; callers in those files may be missing.',
    );
    expect(impact.coverage.reasons.join(' ')).not.toContain(`Extraction failed: ${BROKEN_FILE}`);
    // Partial coverage never claims a tier, and never NONE.
    expect(impact.riskLevel).toBe('UNKNOWN');
  });

  it('AC2: a target in a failed file stays UNKNOWN with the failure reason', async () => {
    await seed({ failed: [TARGET_FILE] });
    const impact = await getSymbolImpact('target', PROJECT_ID, projectRoot);
    expect(impact.riskLevel).toBe('UNKNOWN');
    expect(impact.coverage.status).toBe('failed');
    expect(impact.coverage.reasons[0]).toContain(
      `Extraction failed: ${TARGET_FILE}: E_PARSE_SYNTAX`,
    );
  });

  it('AC2: a traversed caller in a failed file keeps the answer UNKNOWN with its reason', async () => {
    await seed({ failed: [CALLER_FILE] });
    const impact = await getSymbolImpact('target', PROJECT_ID, projectRoot);
    expect(impact.totalImpactedNodes).toBe(1);
    expect(impact.riskLevel).toBe('UNKNOWN');
    expect(impact.coverage.status).toBe('failed');
    expect(impact.coverage.reasons.join(' ')).toContain(`Extraction failed: ${CALLER_FILE}`);
  });

  it('AC2: with a source root below the project root, a failed target file is still in scope (D11237)', async () => {
    await seed({ failed: [TARGET_FILE], sourceDir: 'app' });
    const impact = await getSymbolImpact('target', PROJECT_ID, projectRoot);
    expect(impact.targetNodeId).toBe(TARGET_ID);
    expect(impact.riskLevel).toBe('UNKNOWN');
    expect(impact.coverage.status).toBe('failed');
    expect(impact.coverage.reasons[0]).toContain(
      `Extraction failed: ${TARGET_FILE}: E_PARSE_SYNTAX`,
    );
  });

  it('AC1: with a source root below the project root, an unrelated failure is still partial', async () => {
    await seed({ failed: [BROKEN_FILE], sourceDir: 'app' });
    const impact = await getSymbolImpact('target', PROJECT_ID, projectRoot);
    expect(impact.totalImpactedNodes).toBe(1);
    expect(impact.coverage.status).toBe('partial');
    expect(impact.coverage.reasons.join(' ')).not.toContain(`Extraction failed: ${BROKEN_FILE}`);
  });

  it('AC3: the default reply stays under 50 KB; --coverage-detail returns every reason', async () => {
    await seed({ failed: [BROKEN_FILE], extraFailed: 150, excluded: 2000 });
    const full = await assessKnowledgeCoverage(projectRoot, PROJECT_ID);
    expect(JSON.stringify(full).length).toBeGreaterThan(200_000);
    const compact = await getSymbolImpact('target', PROJECT_ID, projectRoot);
    expect(JSON.stringify(compact).length).toBeLessThan(50_000);
    expect(compact.coverage.status).toBe('partial');
    // Unrelated files collapse to one counted reason; limitations are a bounded sample.
    expect(compact.coverage.reasons).toHaveLength(1);
    expect(full.limitations.length).toBeGreaterThan(2000);
    expect(compact.coverage.limitations.length).toBeLessThanOrEqual(3);
    expect(compact.coverage.detailsCommand).toBe('cleo nexus impact <symbol> --coverage-detail');
    expect(compact.coverage.reasons.join(' ')).toContain('151 of them failed');
    const detailed = await getSymbolImpact('target', PROJECT_ID, projectRoot, {
      coverageDetail: true,
    });
    expect(detailed.coverage.status).toBe('partial');
    expect(detailed.coverage.reasons.join(' ')).toContain(`Extraction failed: ${BROKEN_FILE}`);
    expect(detailed.coverage.limitations.length).toBe(full.limitations.length);
  });
});
