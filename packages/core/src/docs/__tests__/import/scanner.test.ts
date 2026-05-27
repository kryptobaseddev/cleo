/**
 * scanner unit tests — T9710 (ST-MIG-1a).
 *
 * Covers:
 *   - recursive walk finds `.md` files at arbitrary depth
 *   - default exclude set skips `node_modules`/`.git`/`dist`/`coverage`/`build`
 *   - rules table classifies adr / research / note / spec correctly
 *   - non-md files are ignored
 *   - empty/missing directory returns []
 *   - results are sorted by relPath (stable ordering for counter-integrity)
 *
 * @epic T9628 (Saga T9625)
 * @task T9710
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyByRelPath,
  makeClassifierForScanRoot,
  SOURCE_DIR_TO_TYPE,
  scanDirectory,
} from '../../import/scanner.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cleo-import-scan-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {
    /* never fail teardown */
  });
});

async function write(rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, content, 'utf-8');
}

describe('classifyByRelPath', () => {
  it('classifies .cleo/adrs/* as adr', () => {
    expect(classifyByRelPath('.cleo/adrs/ADR-001.md')).toBe('adr');
  });
  it('classifies .cleo/research/* as research', () => {
    expect(classifyByRelPath('.cleo/research/topic.md')).toBe('research');
  });
  it('classifies .cleo/agent-outputs/* as note', () => {
    expect(classifyByRelPath('.cleo/agent-outputs/T123.md')).toBe('note');
  });
  it('classifies docs/specs/* as spec', () => {
    expect(classifyByRelPath('docs/specs/api.md')).toBe('spec');
  });
  it('classifies catch-all docs/* as spec', () => {
    expect(classifyByRelPath('docs/intro.md')).toBe('spec');
  });
  it('defaults uncategorised paths to note', () => {
    expect(classifyByRelPath('README.md')).toBe('note');
    expect(classifyByRelPath('packages/cleo/README.md')).toBe('note');
  });
});

describe('scanDirectory', () => {
  it('finds .md files at arbitrary depth and classifies them', async () => {
    await write('.cleo/adrs/ADR-001-test.md', '# ADR test\n');
    await write('.cleo/research/topic.md', '# Research\n');
    await write('.cleo/agent-outputs/T1.md', '# Note\n');
    await write('docs/specs/api.md', '# Spec\n');
    await write('docs/intro.md', '# Intro\n');

    const result = await scanDirectory({ root });
    expect(result).toHaveLength(5);

    const byRel = new Map(result.map((r) => [r.relPath, r]));
    expect(byRel.get('.cleo/adrs/ADR-001-test.md')?.suggestedType).toBe('adr');
    expect(byRel.get('.cleo/research/topic.md')?.suggestedType).toBe('research');
    expect(byRel.get('.cleo/agent-outputs/T1.md')?.suggestedType).toBe('note');
    expect(byRel.get('docs/specs/api.md')?.suggestedType).toBe('spec');
    expect(byRel.get('docs/intro.md')?.suggestedType).toBe('spec');
  });

  it('excludes node_modules / .git / dist / coverage / build by default', async () => {
    await write('docs/keep.md', 'keep');
    await write('node_modules/pkg/readme.md', 'skip');
    await write('.git/HEAD.md', 'skip');
    await write('dist/output.md', 'skip');
    await write('coverage/report.md', 'skip');
    await write('build/log.md', 'skip');

    const result = await scanDirectory({ root });
    expect(result.map((r) => r.relPath)).toEqual(['docs/keep.md']);
  });

  it('ignores non-md files', async () => {
    await write('docs/keep.md', 'keep');
    await write('docs/readme.txt', 'skip');
    await write('docs/script.ts', 'skip');

    const result = await scanDirectory({ root });
    expect(result).toHaveLength(1);
    expect(result[0]?.relPath).toBe('docs/keep.md');
  });

  it('returns an empty array for a missing directory', async () => {
    const result = await scanDirectory({ root: join(root, 'does-not-exist') });
    expect(result).toEqual([]);
  });

  it('produces a stable sha for identical content', async () => {
    await write('a.md', 'hello world');
    await write('b.md', 'hello world');
    const result = await scanDirectory({ root });
    expect(result).toHaveLength(2);
    expect(result[0]?.contentSha).toBe(result[1]?.contentSha);
  });

  it('returns results sorted by relPath for deterministic counter-integrity', async () => {
    await write('z.md', 'z');
    await write('a.md', 'a');
    await write('docs/m.md', 'm');
    const result = await scanDirectory({ root });
    expect(result.map((r) => r.relPath)).toEqual(['a.md', 'docs/m.md', 'z.md']);
  });

  it('respects a user-supplied classify override', async () => {
    await write('README.md', '# hi');
    const result = await scanDirectory({ root, classify: () => 'spec' });
    expect(result[0]?.suggestedType).toBe('spec');
  });
});

describe('T9791 — source-dir classification', () => {
  it('classifyByRelPath maps .cleo/rcasd/* to research', () => {
    expect(classifyByRelPath('.cleo/rcasd/T9782/foo.md')).toBe('research');
  });

  it('SOURCE_DIR_TO_TYPE has the canonical 6 source dirs', () => {
    expect(SOURCE_DIR_TO_TYPE.get('.cleo/adrs')).toBe('adr');
    expect(SOURCE_DIR_TO_TYPE.get('.cleo/research')).toBe('research');
    expect(SOURCE_DIR_TO_TYPE.get('.cleo/rcasd')).toBe('research');
    expect(SOURCE_DIR_TO_TYPE.get('.cleo/agent-outputs')).toBe('note');
    expect(SOURCE_DIR_TO_TYPE.get('docs/specs')).toBe('spec');
    expect(SOURCE_DIR_TO_TYPE.get('docs')).toBe('spec');
  });

  it('makeClassifierForScanRoot resolves absolute path -> .cleo/adrs as adr', () => {
    const projectRoot = '/abs/project';
    const scanRoot = '/abs/project/.cleo/adrs';
    const classify = makeClassifierForScanRoot(scanRoot, projectRoot);
    // The closure returns the source-dir type regardless of relPath.
    expect(classify('ADR-001-foo.md')).toBe('adr');
    expect(classify('nested/ADR-002.md')).toBe('adr');
  });

  it('makeClassifierForScanRoot resolves project-relative .cleo/rcasd as research', () => {
    const classify = makeClassifierForScanRoot('.cleo/rcasd', '/abs/project');
    expect(classify('T9782/foo.md')).toBe('research');
  });

  it('makeClassifierForScanRoot falls back to classifyByRelPath for unknown scan root', () => {
    const classify = makeClassifierForScanRoot('/abs/project/some-random-dir', '/abs/project');
    expect(classify('.cleo/adrs/ADR-001.md')).toBe('adr');
    expect(classify('README.md')).toBe('note');
  });

  it('scanDirectory + makeClassifierForScanRoot covers the .cleo/adrs prefix-stripping case', async () => {
    // Place files inside a directory shaped like .cleo/adrs/ — the scanner
    // root is the adrs dir itself so relPath is just the filename.
    const adrsDir = join(root, '.cleo', 'adrs');
    await mkdir(adrsDir, { recursive: true });
    await writeFile(join(adrsDir, 'ADR-073-above-epic-naming.md'), '# adr\n', 'utf-8');

    const classify = makeClassifierForScanRoot(adrsDir, root);
    const result = await scanDirectory({ root: adrsDir, classify });
    expect(result).toHaveLength(1);
    expect(result[0]?.suggestedType).toBe('adr');
    expect(result[0]?.relPath).toBe('ADR-073-above-epic-naming.md');
  });
});
