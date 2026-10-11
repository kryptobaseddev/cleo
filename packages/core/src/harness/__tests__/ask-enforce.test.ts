/**
 * T13420 — ask-enforce classifier: corpus precision/recall and unit rules.
 *
 * The corpus pass bar is 0 false positives on `allow` cases (a false block
 * interrupts real work) and at least 90% recall on `block` cases. Add every
 * observed false positive to the corpus as an `allow` case.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { askEnforceReason, classifyOwnerAsk } from '../ask-enforce.js';

interface CorpusCase {
  id: string;
  expect: 'allow' | 'block';
  text: string;
  toolCalls?: string[];
  stopHookActive?: boolean;
  blocksThisTurn?: number;
}

const corpus: { cases: CorpusCase[] } = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ask-enforce-corpus.json'),
    'utf8',
  ),
);

const ASK_TOOLS = ['AskUserQuestion', 'request_user_input', 'ask_user', 'question'];

function verdictOf(c: CorpusCase) {
  return classifyOwnerAsk({
    lastAssistantText: c.text,
    turnToolCalls: c.toolCalls ?? [],
    askToolNames: ASK_TOOLS,
    stopHookActive: c.stopHookActive,
    blocksThisTurn: c.blocksThisTurn,
  });
}

describe('ask-enforce corpus (T13420)', () => {
  const results = corpus.cases.map((c) => ({ c, v: verdictOf(c) }));
  const falsePositives = results.filter((r) => r.c.expect === 'allow' && r.v.verdict === 'block');
  const positives = results.filter((r) => r.c.expect === 'block');
  const caught = positives.filter((r) => r.v.verdict === 'block');

  it('has a balanced corpus of at least 50 cases', () => {
    expect(corpus.cases.length).toBeGreaterThanOrEqual(50);
    expect(positives.length).toBeGreaterThanOrEqual(20);
  });

  it('blocks no allow case (0 false positives)', () => {
    expect(falsePositives.map((r) => `${r.c.id}: ${r.v.excerpt}`)).toEqual([]);
  });

  it('catches at least 90% of block cases', () => {
    const missed = positives.filter((r) => r.v.verdict !== 'block').map((r) => r.c.id);
    expect(caught.length / positives.length, `missed: ${missed.join(', ')}`).toBeGreaterThanOrEqual(
      0.9,
    );
  });
});

describe('classifyOwnerAsk rules (T13420)', () => {
  const base = { turnToolCalls: [], askToolNames: ASK_TOOLS };

  it('fails open on missing text', () => {
    expect(classifyOwnerAsk({ ...base, lastAssistantText: undefined }).signal).toBe('no-text');
    expect(classifyOwnerAsk({ ...base, lastAssistantText: '   ' }).signal).toBe('no-text');
  });

  it('reads only the tail: a question answered later in a long report does not block', () => {
    const early = 'Should I keep the old flag? I kept it for one release.';
    const filler = Array.from({ length: 8 }, (_, i) => `Paragraph ${i} of findings. `.repeat(6));
    const text = [early, ...filler, 'All gates pass.'].join('\n\n');
    expect(classifyOwnerAsk({ ...base, lastAssistantText: text }).verdict).toBe('allow');
  });

  it('quotes the offending sentence, capped at 160 characters', () => {
    const long = `Should I merge ${'this very long branch name '.repeat(10)}now?`;
    const v = classifyOwnerAsk({ ...base, lastAssistantText: long });
    expect(v.verdict).toBe('block');
    expect(v.excerpt?.length).toBeLessThanOrEqual(160);
  });

  it('names the ask tool, or the hitl.request fallback, in the reason', () => {
    const v = classifyOwnerAsk({ ...base, lastAssistantText: 'Should I merge it?' });
    expect(askEnforceReason(v, 'AskUserQuestion')).toContain('`AskUserQuestion`');
    expect(askEnforceReason(v, 'AskUserQuestion')).toContain('2-4 options');
    expect(askEnforceReason(v, null)).toContain('`hitl.request`');
  });
});
