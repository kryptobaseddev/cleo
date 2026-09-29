/**
 * Gate 35 — lint-model-call-sites (T12663): each rule goes red on a planted
 * violation, stays green on the registered/allowed form, and the live
 * repository passes against its committed baseline.
 *
 * @task T12663
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_SITES } from '../../packages/core/src/decide/sites/registry.ts';
import {
  BASELINE_PATH,
  blankComments,
  parseRegistry,
  REGISTRY_PATH,
  regressions,
  runGate,
  scanRepository,
  scanSource,
} from '../lint-model-call-sites.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A scan context with one registered System One site and one generative file. */
const ctx = {
  known: {
    ids: new Set(['tasks.duplicate-detection']),
    constNames: new Set(['DUPLICATE_DETECTION_SITE']),
    aliases: new Set(['DUPLICATE_DECISION_SITE']),
  },
  filesToRows: new Map([
    ['packages/core/src/gen.ts', [{ primaryRung: 'generative', ladder: [] }]],
    ['packages/core/src/s1-only.ts', [{ primaryRung: 'system-one', ladder: [] }]],
  ]),
};
const rules = (rel, src) => scanSource(rel, src, ctx).map((v) => v.rule);

describe('blankComments', () => {
  it('blanks comments, keeps strings and offsets', () => {
    const src = "const u = 'https://x/y'; // decide('nope')\n/* generateObject( */ call();";
    const out = blankComments(src);
    expect(out.length).toBe(src.length);
    expect(out).toContain("'https://x/y'");
    expect(out).not.toContain("decide('nope')");
    expect(out).not.toContain('generateObject(');
    expect(out).toContain('call();');
  });
});

describe('parseRegistry on the real registry', () => {
  it('reads the same ids and files as the registry module', () => {
    const parsed = parseRegistry(readFileSync(join(REPO, REGISTRY_PATH), 'utf-8'));
    expect(parsed.map((r) => r.id)).toEqual(DECISION_SITES.map((s) => s.id));
    expect(parsed.map((r) => r.files)).toEqual(DECISION_SITES.map((s) => [...s.files]));
    expect(parsed.map((r) => r.primaryRung)).toEqual(DECISION_SITES.map((s) => s.primaryRung));
    expect(parsed.map((r) => r.ladder)).toEqual(DECISION_SITES.map((s) => [...s.ladder]));
    expect(parsed.map((r) => r.defaultMode)).toEqual(DECISION_SITES.map((s) => s.defaultMode));
    expect(parsed.map((r) => r.goLive)).toEqual(
      DECISION_SITES.map((s) => s.goLive?.evidenceDoc ?? null),
    );
  });
});

describe('rule 1 — unregistered-decide-site', () => {
  const f = 'packages/core/src/x.ts';
  it.each([
    "decide('tasks.duplicate-detection', req, h, o);",
    'decideBatch(DUPLICATE_DECISION_SITE, entries, o);',
    'export async function decideBatch(siteId: string, entries) {}',
    'decide(DUPLICATE_DETECTION_SITE.id, req, h, o);',
    'decide(DUPLICATE_DECISION_SITE, req, h, o);',
    'askSiteDecision({ siteId: DUPLICATE_DECISION_SITE, budgetMs: 1 });',
    '  decide(req: DecisionRequest, signal: AbortSignal): Promise<X>;',
    'export async function decide(siteId: string) {}',
    "x.decide('whatever');",
  ])('passes %s', (src) => {
    expect(rules(f, src)).toEqual([]);
  });
  it.each([
    "decide('tasks.unknown-site', req, h, o);",
    'decide(someVariable, req, h, o);',
    "askSiteDecision({ siteId: 'memory.new-site', budgetMs: 1 });",
    "decideBatch('tasks.unknown-site', entries, o);",
    'askSiteDecision({ budgetMs: 1 });',
  ])('fails %s', (src) => {
    expect(rules(f, src)).toEqual(['unregistered-decide-site']);
  });
  it('honours the opt-out on the line or the line above', () => {
    expect(rules(f, 'decide(x, r); // model-site-allowed: plumbing')).toEqual([]);
    expect(rules(f, '// model-site-allowed: plumbing\ndecide(x, r);')).toEqual([]);
  });
  it('needs a reason, and a trailing marker does not exempt the next line (review of #1684)', () => {
    expect(rules(f, 'decide(x, r); // model-site-allowed')).toEqual(['unregistered-decide-site']);
    expect(rules(f, 'decide(x, r); // model-site-allowed:')).toEqual(['unregistered-decide-site']);
    expect(rules(f, 'foo(); // model-site-allowed: for foo\ndecide(x, r);')).toEqual([
      'unregistered-decide-site',
    ]);
  });
});

describe('rules 2 and 5 — unregistered-model-site and rung-mismatch', () => {
  it('fails an LLM entry point in an unregistered file', () => {
    expect(rules('packages/core/src/new.ts', "await resolveLLMForRole('extraction');")).toEqual([
      'unregistered-model-site',
    ]);
    expect(rules('packages/core/src/new.ts', 'await executeForRole(role, a, b);')).toEqual([
      'unregistered-model-site',
    ]);
  });
  it('passes it in a file registered with a generative rung', () => {
    expect(rules('packages/core/src/gen.ts', "await resolveLLMForRole('extraction');")).toEqual([]);
  });
  it('fails it in a file registered only for System One', () => {
    expect(
      rules('packages/core/src/s1-only.ts', "await resolveLLMForSystem({ kind: 'role' });"),
    ).toEqual(['rung-mismatch']);
  });
  it('ignores declarations, comments and the chokepoint', () => {
    expect(
      rules('packages/core/src/new.ts', 'export async function resolveLLMForRole(r) {}'),
    ).toEqual([]);
    expect(rules('packages/core/src/new.ts', '// resolveLLMForRole(x)')).toEqual([]);
    expect(rules('packages/core/src/llm/system-resolver.ts', 'resolveLLMForRole(r);')).toEqual([]);
  });
});

describe('evasions found in review of #1684', () => {
  it('catches a member call to an LLM entry point in an unregistered file', () => {
    expect(rules('packages/core/src/new.ts', "await llm.resolveLLMForRole('x');")).toEqual([
      'unregistered-model-site',
    ]);
  });
  it.each([
    [
      'a member call to an AI-SDK function',
      'const m = await import("x"); await m.generateText({});',
    ],
    ['an OpenAI SDK chat completion', 'await c.chat.completions.create({ model });'],
    ['a dynamic import of ai', "const m = await import('ai');"],
    ['a dynamic import with a type assertion', "const m = await import('ai' as string);"],
    ['a dynamic import of an @ai-sdk provider', "await import('@ai-sdk/mistral');"],
    ['a dynamic import of the Anthropic SDK', "await import('@anthropic-ai/sdk');"],
    ['a dynamic import of openai', "await import('openai');"],
    [
      'any create* imported from @ai-sdk/*',
      "import { createMistral as mk } from '@ai-sdk/mistral';\nconst p = mk({ apiKey });",
    ],
  ])('flags %s as a chokepoint bypass', (_name, src) => {
    expect(rules('packages/core/src/gen.ts', src)).toContain('chokepoint-bypass');
  });
  it('does not flag an ordinary dynamic import', () => {
    expect(rules('packages/core/src/gen.ts', "await import('node:path');")).toEqual([]);
  });
});

describe('rule 6 — chokepoint-bypass', () => {
  const f = 'packages/core/src/gen.ts';
  it.each([
    ['direct AI-SDK call', 'await generateObject({ model, schema });'],
    ['raw messages.create', 'await client.messages.create({ model });'],
    ['provider factory', 'const p = createAnthropic({ apiKey });'],
    // The planted source builds a URL with a template literal: `${base}/v1/messages`.
    ['raw endpoint URL', `const url = \`$\{base}/v1/messages\`;`],
  ])('fails a %s', (_name, src) => {
    expect(rules(f, src)).toContain('chokepoint-bypass');
  });
  it('allows the chokepoint and a quoted path that is only data', () => {
    expect(rules('packages/core/src/llm/model-runner.ts', 'createAnthropic({ apiKey });')).toEqual(
      [],
    );
    expect(rules('packages/core/src/llm/transports/x.ts', 'new X().messages.create({});')).toEqual(
      [],
    );
    expect(rules(f, "const path = '/chat/completions';")).toEqual([]);
  });
});

describe('rules 3 and 4, and the baseline, on a fixture repository', () => {
  let root;
  const registry = (rows) =>
    `export const DECISION_SITES = [\n${rows
      .map(
        (r) =>
          `  {\n    id: '${r.id}',\n    files: [${r.files.map((f) => `'${f}'`).join(', ')}],\n    primaryRung: '${r.rung}',\n    ladder: [],\n    defaultMode: '${r.mode}',\n${r.goLive ? `    goLive: { evidenceDoc: '${r.goLive}', measuredAt: 'x', n: 1, metric: 'm', value: 1, floor: 0 },\n` : ''}  },`,
      )
      .join('\n')}\n];\n`;
  const write = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'model-call-sites-'));
    write('packages/core/src/site.ts', "decide('a.site', r);\n");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects an on-site whose evidence slug resolves to no tracked file (review of #1684)', () => {
    write(
      REGISTRY_PATH,
      registry([
        { id: 'a.site', files: [], rung: 'system-one', mode: 'on', goLive: 'totally-fake-slug' },
      ]),
    );
    const found = () => scanRepository(root).violations.map((v) => `${v.rule}:${v.detail}`);
    expect(found()).toContain('on-without-evidence:a.site');
    // An untracked ledger entry pointing nowhere proves nothing either.
    write(
      '.cleo/docs-publications.json',
      JSON.stringify({ 'totally-fake-slug': 'docs/missing.md' }),
    );
    expect(found()).toContain('on-without-evidence:a.site');
    // A tracked docs mirror named after the slug is evidence.
    write('docs/evidence/totally-fake-slug.md', '# measured\n');
    expect(found()).not.toContain('on-without-evidence:a.site');
  });

  it('flags a missing registry file and on-without-evidence, exempting the debug verb', () => {
    write('docs/evidence/measured-b.md', '# measured\n');
    write(
      REGISTRY_PATH,
      registry([
        {
          id: 'a.site',
          files: ['packages/core/src/site.ts', 'packages/core/src/gone.ts'],
          rung: 'system-one',
          mode: 'on',
        },
        { id: 'b.site', files: [], rung: 'system-one', mode: 'on', goLive: 'measured-b' },
        { id: 'cli.decide-ask', files: [], rung: 'system-one', mode: 'on' },
        { id: 'c.site', files: [], rung: 'system-one', mode: 'shadow' },
      ]),
    );
    const found = scanRepository(root).violations.map((v) => `${v.rule}:${v.detail}`);
    expect(found).toContain('registry-file-missing:a.site: packages/core/src/gone.ts');
    expect(found).toContain('on-without-evidence:a.site');
    expect(found.filter((f) => f.startsWith('on-without-evidence'))).toEqual([
      'on-without-evidence:a.site',
    ]);
  });

  it('fails when a (rule, file) count rises above the baseline, even if the total does not', () => {
    write(
      REGISTRY_PATH,
      registry([
        { id: 'a.site', files: ['packages/core/src/site.ts'], rung: 'system-one', mode: 'shadow' },
      ]),
    );
    write('packages/core/src/old.ts', 'createAnthropic({});\n');
    expect(runGate(root, ['--baseline'])).toBe(0);
    expect(runGate(root, [])).toBe(0);
    write('packages/core/src/old.ts', '\n');
    write('packages/core/src/new.ts', 'createAnthropic({});\n');
    expect(runGate(root, [])).toBe(1);
    expect(regressions(scanRepository(root).counts, {})).toEqual([
      { rule: 'chokepoint-bypass', file: 'packages/core/src/new.ts', baseline: 0, current: 1 },
    ]);
  });

  it('fails without a committed baseline', () => {
    write(REGISTRY_PATH, registry([]));
    expect(runGate(root, [])).toBe(1);
    expect(BASELINE_PATH).toBe('scripts/.lint-model-call-sites-baseline.json');
  });
});

describe('the live repository', () => {
  it('passes against its committed baseline', () => {
    expect(runGate(REPO, [])).toBe(0);
  });

  it('has no unregistered site, missing file, unevidenced on-site or rung mismatch', () => {
    const { counts } = scanRepository(REPO);
    for (const rule of [
      'unregistered-decide-site',
      'unregistered-model-site',
      'registry-file-missing',
      'on-without-evidence',
      'rung-mismatch',
    ]) {
      expect(counts[rule], rule).toEqual({});
    }
  });
});
