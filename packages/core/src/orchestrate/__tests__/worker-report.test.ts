/**
 * T14361 — `checkWorkerReport`: a worker report needs a conclusion and proof,
 * and at most 100 words.
 */
import { describe, expect, it } from 'vitest';
import { checkWorkerReport, WORKER_REPORT_MAX_WORDS } from '../worker-report.js';

const HEAD = 'Implementation complete. manifest:e1';
const COMPLETE = [
  HEAD,
  'conclusion: return contract rewritten',
  'blocker: none',
  'proof: pnpm exec vitest run a.test.ts => exit 0',
  'proof: https://github.com/o/r/pull/1',
].join('\n');

describe('checkWorkerReport (T14361)', () => {
  it('accepts a complete report and parses its proof', () => {
    expect(checkWorkerReport(COMPLETE)).toEqual({
      ok: true,
      report: {
        conclusion: 'return contract rewritten',
        blocker: null,
        proof: [
          { command: 'pnpm exec vitest run a.test.ts', exitCode: 0 },
          { artifact: 'https://github.com/o/r/pull/1' },
        ],
      },
    });
  });

  it('accepts the report inside a code fence', () => {
    expect(checkWorkerReport(`\`\`\`\n${COMPLETE}\n\`\`\``)).toMatchObject({ ok: true });
  });

  it.each([
    ['no proof line', [HEAD, 'conclusion: done', 'blocker: none']],
    ['proof: none', [HEAD, 'conclusion: done', 'blocker: none', 'proof: none']],
    ['no conclusion', [HEAD, 'blocker: none', 'proof: abc1234']],
    ['not the contract', ['all done, trust me', 'proof: abc1234']],
    [
      'a failing command',
      [HEAD, 'conclusion: done', 'blocker: none', 'proof: pnpm test => exit 1'],
    ],
    [
      'a failing command next to a good artifact',
      [HEAD, 'conclusion: done', 'blocker: none', 'proof: abc1234', 'proof: pnpm test => exit 2'],
    ],
    [
      'the unfilled proof template',
      [HEAD, 'conclusion: done', 'blocker: none', 'proof: <cmd> => exit <n>|<PR|sha|file>'],
    ],
    ['proof: n/a', [HEAD, 'conclusion: done', 'blocker: none', 'proof: n/a']],
    ['proof: TBD', [HEAD, 'conclusion: done', 'blocker: none', 'proof: TBD']],
    ['proof: -', [HEAD, 'conclusion: done', 'blocker: none', 'proof: -']],
    ['a run with no command', [HEAD, 'conclusion: done', 'blocker: none', 'proof: => exit 0']],
    ['a malformed exit', [HEAD, 'conclusion: done', 'blocker: none', 'proof: pnpm test => exit']],
    ['the unfilled conclusion', [HEAD, 'conclusion: <result>', 'blocker: none', 'proof: abc1234']],
    ['conclusion: TBD', [HEAD, 'conclusion: TBD', 'blocker: none', 'proof: abc1234']],
  ])('refuses %s with E_WORKER_REPORT_PROOF', (_name, lines) => {
    expect(checkWorkerReport(lines.join('\n'))).toMatchObject({
      ok: false,
      code: 'E_WORKER_REPORT_PROOF',
      exitCode: 61,
    });
  });

  it('refuses a complete report whose command proof exited non-zero', () => {
    const check = checkWorkerReport(COMPLETE.replace('=> exit 0', '=> exit 1'));
    expect(check).toMatchObject({ ok: false, code: 'E_WORKER_REPORT_PROOF' });
  });

  it('accepts a blocked report that proves its blocker with a non-zero exit', () => {
    const blocked = [
      'Implementation blocked. manifest:e1',
      'conclusion: unit tests fail on main',
      'blocker: pnpm test fails in a.test.ts',
      'proof: pnpm exec vitest run a.test.ts => exit 1',
    ].join('\n');
    expect(checkWorkerReport(blocked)).toEqual({
      ok: true,
      report: {
        conclusion: 'unit tests fail on main',
        blocker: 'pnpm test fails in a.test.ts',
        proof: [{ command: 'pnpm exec vitest run a.test.ts', exitCode: 1 }],
      },
    });
  });

  it.each([
    ['a placeholder', 'proof: <cmd> => exit <n>'],
    ['a run with no command', 'proof: => exit 1'],
    ['a malformed exit', 'proof: pnpm test => exit'],
  ])('refuses %s in a blocked report too', (_name, line) => {
    const blocked = [
      'Implementation partial. manifest:e1',
      'conclusion: half done',
      'blocker: CI red',
      line,
    ];
    expect(checkWorkerReport(blocked.join('\n'))).toMatchObject({
      ok: false,
      code: 'E_WORKER_REPORT_PROOF',
    });
  });

  it.each(['None', 'NONE', 'none'])('accepts blocker: %s as no blocker', (word) => {
    const check = checkWorkerReport(COMPLETE.replace('blocker: none', `blocker: ${word}`));
    expect(check).toMatchObject({ ok: true, report: { blocker: null } });
  });

  it('does not count the template keys toward the word limit', () => {
    const filler = Array.from({ length: WORKER_REPORT_MAX_WORDS - 6 }, (_, i) => `w${i}`).join(' ');
    const lines = [
      HEAD,
      `conclusion: ${filler}`,
      'blocker: none',
      'proof: abc1234',
      'proof: def5678',
    ];
    // 104 words counting the conclusion:, blocker: and proof: keys; exactly 100 without.
    expect(checkWorkerReport(lines.join('\n'))).toMatchObject({ ok: true });
  });

  it('refuses a report over the word limit and points the detail at the PR', () => {
    const padding = Array.from({ length: WORKER_REPORT_MAX_WORDS }, (_, i) => `w${i}`).join(' ');
    const long = COMPLETE.replace('return contract rewritten', padding);
    const check = checkWorkerReport(long);
    expect(check).toMatchObject({ ok: false, code: 'E_VALIDATION', exitCode: 6 });
    expect(check.ok ? '' : check.fix).toContain('PR body');
    expect(checkWorkerReport(COMPLETE).ok).toBe(true);
  });
});
