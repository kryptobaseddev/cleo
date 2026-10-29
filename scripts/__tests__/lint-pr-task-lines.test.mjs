/**
 * Tests for scripts/lint-pr-task-lines.mjs (T14143): a PR names its tasks with
 * `Closes:` / `Refs:` lines, and the script's grammar agrees with the merge
 * sweep's parser (`parseMergeDirectives`, T14101).
 */

import { describe, expect, it } from 'vitest';
import { parseMergeDirectives } from '../../packages/core/src/tasks/merge-close.ts';
import { checkPrTaskLines, NO_TASK_LABEL, parseTaskLines } from '../lint-pr-task-lines.mjs';

const pr = (body, over = {}) => ({
  body,
  headRef: 'task/T1-x',
  author: 'someone',
  labels: [],
  ...over,
});

describe('lint-pr-task-lines (T14143)', () => {
  it('passes a PR with a Closes: line', () => {
    const result = checkPrTaskLines(pr('Summary.\n\nCloses: T14143 AC1,AC2,AC3\n'));
    expect(result).toMatchObject({ ok: true, exempt: null, tasks: ['Closes T14143'] });
  });

  it('passes a PR with only Refs: lines', () => {
    expect(checkPrTaskLines(pr('Refs: T1 AC1\nRefs: T2 AC2')).ok).toBe(true);
  });

  it('flags a PR that names no task, including the untouched template placeholder', () => {
    for (const body of ['Just a summary.', 'Closes: T#### AC1,AC2', 'Closes #123']) {
      const result = checkPrTaskLines(pr(body));
      expect(result.ok).toBe(false);
      expect(result.problems[0]).toMatch(/names no task/);
    }
  });

  it('flags malformed and duplicated task lines', () => {
    expect(checkPrTaskLines(pr('Closes: T5')).problems[0]).toMatch(
      /is not "Closes: T#### AC1,AC2"/,
    );
    expect(checkPrTaskLines(pr('Closes: T5 AC1\nRefs: T5 AC2')).problems[0]).toMatch(
      /more than one Closes:\/Refs: line/,
    );
  });

  it('exempts release branches, bots and the no-task label', () => {
    expect(checkPrTaskLines(pr('', { headRef: 'release/v2026.10.28' })).exempt).toMatch(/release/);
    expect(checkPrTaskLines(pr('', { author: 'dependabot[bot]' })).exempt).toMatch(/bot/);
    expect(checkPrTaskLines(pr('', { labels: [NO_TASK_LABEL] })).exempt).toMatch(/no-task/);
  });

  it('agrees with the merge sweep parser on every fixture', () => {
    const bodies = [
      'Closes: T14101 AC1, AC2\nRefs: `T14102 AC3`\nCloses #123\n',
      'Closes: T1\nRefs: T2 all\nCloses: T3 AC1\nRefs: T3 AC2',
      '> - Closes: T7 AC1,AC1,ac2',
      'closes : t9 ac4',
      'nothing here',
    ];
    for (const body of bodies) expect(parseTaskLines(body)).toEqual(parseMergeDirectives(body));
  });
});
