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
  ])('refuses %s with E_WORKER_REPORT_PROOF', (_name, lines) => {
    expect(checkWorkerReport(lines.join('\n'))).toMatchObject({
      ok: false,
      code: 'E_WORKER_REPORT_PROOF',
      exitCode: 61,
    });
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
