/**
 * T13666 — brief codebase map: formatting, budget, ordering, the nexus-backed
 * path and the git-walk fallback.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type NodeRow = { file: string | null; name: string | null; kind: string; line: number | null };
/** Rows the stubbed nexus graph returns (already filtered to exported, non-external). */
let nexusRows: NodeRow[] = [];
vi.mock('../../store/nexus-sqlite.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../store/nexus-sqlite.js')>()),
  getNexusDb: async () => ({
    select: () => ({ from: () => ({ where: () => ({ all: () => nexusRows }) }) }),
  }),
}));

const {
  BRIEF_MAP_NO_INDEX,
  buildBriefMap,
  buildNexusBriefMap,
  formatBriefMap,
  isMappableSource,
  namesInSource,
} = await import('../brief-map.js');

describe('formatBriefMap (T13666)', () => {
  it('lists one line per folder, shared folders first', () => {
    const { text, folders } = formatBriefMap([
      { file: 'app/routes/home.ts', names: ['HomeRoute'] },
      { file: 'app/lib/money.ts', names: ['formatMoney', 'parseMoney'] },
    ]);
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^Codebase map/);
    expect(lines[1]).toBe('app/lib/: formatMoney, parseMoney');
    expect(lines[2]).toBe('app/routes/: HomeRoute');
    expect(folders).toBe(2);
  });

  it('skips tests and generated files, and stays within the budget', () => {
    const files = Array.from({ length: 50 }, (_, i) => ({
      file: `pkg${i}/src/index.ts`,
      names: [`exportedThing${i}`],
    }));
    files.push({ file: 'pkg0/src/index.test.ts', names: ['shouldNotAppear'] });
    const { text, skipped } = formatBriefMap(files, 300);
    expect(text).not.toContain('shouldNotAppear');
    expect(skipped).toBeGreaterThan(0);
    expect(text).toMatch(/\(\d+ more folders not listed\)$/);
    const body = text.split('\n').slice(1, -1).join('\n');
    expect(body.length).toBeLessThanOrEqual(300);
  });

  it('takes one name per file in a folder of many files', () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      file: `ui/Button${i}.tsx`,
      names: [`Button${i}`, `ButtonProps${i}`],
    }));
    const { text } = formatBriefMap(files);
    expect(text).toContain('Button0');
    expect(text).not.toContain('ButtonProps0');
  });

  it('returns empty text when nothing is exported', () => {
    expect(formatBriefMap([{ file: 'a.ts', names: [] }]).text).toBe('');
  });
});

describe('fallback regex names (T13666)', () => {
  it('reads exports per language and skips private names', () => {
    expect(
      namesInSource(
        'a.ts',
        'export function run() {}\nexport const _hidden = 1;\nexport { a, b as c };',
      ),
    ).toEqual(['run', 'a', 'c']);
    expect(
      namesInSource('a.py', 'def load():\n  pass\nclass Store:\n  pass\ndef _private(): pass'),
    ).toEqual(['load', 'Store']);
    expect(
      namesInSource('a.go', 'func Serve() {}\nfunc helper() {}\ntype Server struct{}'),
    ).toEqual(['Serve', 'Server']);
  });

  it('treats test, vendored and build paths as unmappable', () => {
    expect(isMappableSource('src/a.ts')).toBe(true);
    expect(isMappableSource('src/__tests__/a.ts')).toBe(false);
    expect(isMappableSource('node_modules/x/index.js')).toBe(false);
    expect(isMappableSource('src/a.d.ts')).toBe(false);
  });
});

describe('buildBriefMap from the nexus graph (T13666)', () => {
  afterEach(() => {
    nexusRows = [];
  });

  it('maps indexed symbols in source order, skipping private names and non-symbol kinds', async () => {
    nexusRows = [
      { file: 'src/lib/money.ts', name: 'parseMoney', kind: 'function', line: 20 },
      { file: 'src/lib/money.ts', name: 'formatMoney', kind: 'function', line: 3 },
      { file: 'src/lib/money.ts', name: '_round', kind: 'function', line: 40 },
      { file: 'src/lib/money.ts', name: 'money.ts', kind: 'file', line: 1 },
      { file: 'src/app.ts', name: 'App', kind: 'class', line: 1 },
    ];
    const report = await buildBriefMap('/nonexistent-repo');
    expect(report.source).toBe('nexus');
    expect(report.text.split('\n').slice(1)).toEqual([
      'src/lib/: formatMoney, parseMoney',
      'src/: App',
    ]);
    expect(await buildNexusBriefMap('/nonexistent-repo')).toEqual(report);
  });

  it('returns null without an index, so a briefing can print the no-index line', async () => {
    expect(await buildNexusBriefMap('/nonexistent-repo')).toBeNull();
    expect(BRIEF_MAP_NO_INDEX).toBe('no code index; run `cleo nexus analyze`');
  });
});

describe('buildBriefMap git-walk fallback (T13666)', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'brief-map-'));
    execFileSync('git', ['-C', repo, 'init', '-q']);
    mkdirSync(join(repo, 'src', 'utils'), { recursive: true });
    writeFileSync(
      join(repo, 'src', 'utils', 'slug.ts'),
      'export function slugify(s: string) { return s; }\n',
    );
    writeFileSync(join(repo, 'src', 'main.ts'), 'export const main = () => 0;\n');
    execFileSync('git', ['-C', repo, 'add', '.']);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('maps an unindexed repo from its tracked files', async () => {
    const report = await buildBriefMap(repo);
    expect(report.source).toBe('git-walk');
    expect(report.text).toContain('src/utils/: slugify');
    expect(report.text).toContain('src/: main');
    expect(report.budget).toBe(2000);
  });
});
