/**
 * Snapshot tests for audit.ts cliOutput migration (T1729).
 *
 * Verifies that cliOutput is used for all output paths in
 * `cleo audit reconstruct` and that the human renderer
 * (`renderAuditReconstruct`) produces the expected output shape.
 *
 * @task T1729
 * @epic T1691
 */

import type { ReconstructResult } from '@cleocode/contracts';
import { renderAuditReconstruct } from '@cleocode/core';
import * as auditSdk from '@cleocode/core/audit/reconstruct';
import { runCommand } from 'citty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFormatContext } from '../../format-context.js';
import { setOutputMode } from '../../output-context.js';
import { auditCommand } from '../audit.js';

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  setFormatContext({ format: 'json', source: 'default', quiet: false });
});

afterEach(() => {
  setFormatContext({ format: 'json', source: 'default', quiet: false });
});

// ---------------------------------------------------------------------------
// renderAuditReconstruct — human renderer
// ---------------------------------------------------------------------------

describe('renderAuditReconstruct — human renderer (T1729)', () => {
  it('renders task ID and direct commits count', () => {
    const data = {
      taskId: 'T991',
      directCommits: [
        {
          sha: 'abc1234567890',
          subject: 'feat(T991): initial work',
          authorDate: '2026-05-01',
          author: 'test',
        },
      ],
      childIdRange: null,
      childCommits: {},
      releaseTags: [],
      releaseCommitShas: [],
      inferredChildren: [],
      firstSeenAt: '2026-05-01T00:00:00Z',
      lastSeenAt: '2026-05-01T00:00:00Z',
    };
    const output = renderAuditReconstruct(data, false);
    expect(output).toContain('T991');
    expect(output).toContain('Direct commits:');
    expect(output).toContain('1');
    expect(output).toContain('abc1234567');
    expect(output).toContain('feat(T991): initial work');
  });

  it('renders "Inferred children: none" when childIdRange is null', () => {
    const data = {
      taskId: 'T100',
      directCommits: [],
      childIdRange: null,
      childCommits: {},
      releaseTags: [],
      releaseCommitShas: [],
      inferredChildren: [],
      firstSeenAt: null,
      lastSeenAt: null,
    };
    const output = renderAuditReconstruct(data, false);
    expect(output).toContain('Inferred children:');
    expect(output).toContain('none');
  });

  it('renders child ID range when present', () => {
    const data = {
      taskId: 'T500',
      directCommits: [],
      childIdRange: { min: 'T501', max: 'T510' },
      childCommits: {},
      releaseTags: [],
      releaseCommitShas: [],
      inferredChildren: ['T501', 'T502', 'T510'],
      firstSeenAt: null,
      lastSeenAt: null,
    };
    const output = renderAuditReconstruct(data, false);
    expect(output).toContain('T501');
    expect(output).toContain('T510');
    expect(output).toContain('T501 → T510');
  });

  it('renders release tags section when tags are present', () => {
    const data = {
      taskId: 'T991',
      directCommits: [],
      childIdRange: null,
      childCommits: {},
      releaseTags: [
        { tag: 'v2026.5.10', commitSha: 'deadbeef12345', subject: 'chore(release): bump' },
      ],
      releaseCommitShas: ['deadbeef12345'],
      inferredChildren: [],
      firstSeenAt: '2026-05-01T00:00:00Z',
      lastSeenAt: '2026-05-01T00:00:00Z',
    };
    const output = renderAuditReconstruct(data, false);
    expect(output).toContain('Release tags (1)');
    expect(output).toContain('v2026.5.10');
    expect(output).toContain('deadbeef12');
    expect(output).toContain('chore(release): bump');
  });

  it('renders "Release tags: none found" when empty', () => {
    const data = {
      taskId: 'T200',
      directCommits: [],
      childIdRange: null,
      childCommits: {},
      releaseTags: [],
      releaseCommitShas: [],
      inferredChildren: [],
      firstSeenAt: null,
      lastSeenAt: null,
    };
    const output = renderAuditReconstruct(data, false);
    expect(output).toContain('Release tags:');
    expect(output).toContain('none found');
  });

  it('renders child commits section', () => {
    const data = {
      taskId: 'T1000',
      directCommits: [],
      childIdRange: { min: 'T1001', max: 'T1002' },
      childCommits: {
        T1001: [
          {
            sha: 'aaaa1111bbbb',
            subject: 'feat(T1001): child work',
            authorDate: '2026-05-02',
            author: 'dev',
          },
        ],
        T1002: [
          {
            sha: 'cccc2222dddd',
            subject: 'fix(T1002): patch',
            authorDate: '2026-05-02',
            author: 'dev',
          },
        ],
      },
      releaseTags: [],
      releaseCommitShas: [],
      inferredChildren: ['T1001', 'T1002'],
      firstSeenAt: null,
      lastSeenAt: null,
    };
    const output = renderAuditReconstruct(data, false);
    expect(output).toContain('Child commits');
    expect(output).toContain('T1001');
    expect(output).toContain('T1002');
    expect(output).toContain('aaaa1111bb');
    expect(output).toContain('feat(T1001): child work');
  });

  it('renders first/last seen timestamps', () => {
    const data = {
      taskId: 'T300',
      directCommits: [],
      childIdRange: null,
      childCommits: {},
      releaseTags: [],
      releaseCommitShas: [],
      inferredChildren: [],
      firstSeenAt: '2026-01-01T00:00:00Z',
      lastSeenAt: '2026-05-01T00:00:00Z',
    };
    const output = renderAuditReconstruct(data, false);
    expect(output).toContain('First seen');
    expect(output).toContain('2026-01-01T00:00:00Z');
    expect(output).toContain('Last seen');
    expect(output).toContain('2026-05-01T00:00:00Z');
  });

  it('renders n/a for null timestamps', () => {
    const data = {
      taskId: 'T400',
      directCommits: [],
      childIdRange: null,
      childCommits: {},
      releaseTags: [],
      releaseCommitShas: [],
      inferredChildren: [],
      firstSeenAt: null,
      lastSeenAt: null,
    };
    const output = renderAuditReconstruct(data, false);
    expect(output).toContain('n/a');
  });

  it('returns empty string in quiet mode', () => {
    const data = {
      taskId: 'T500',
      directCommits: [],
      childIdRange: null,
      childCommits: {},
      releaseTags: [],
      releaseCommitShas: [],
      inferredChildren: [],
      firstSeenAt: null,
      lastSeenAt: null,
    };
    expect(renderAuditReconstruct(data, true)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// cliOutput integration — LAFS envelope shape validation
// ---------------------------------------------------------------------------

describe('cliOutput — LAFS envelope shape for audit-reconstruct', () => {
  it('emits valid LAFS envelope in json format', async () => {
    const { cliOutput } = await import('../../renderers/index.js');
    setFormatContext({ format: 'json', source: 'flag', quiet: false });

    let written = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown): boolean => {
      written += String(chunk);
      return true;
    };

    try {
      cliOutput(
        {
          taskId: 'T991',
          directCommits: [],
          childIdRange: null,
          childCommits: {},
          releaseTags: [],
          releaseCommitShas: [],
          inferredChildren: [],
          firstSeenAt: null,
          lastSeenAt: null,
        },
        {
          command: 'audit-reconstruct',
          operation: 'audit.reconstruct',
          message: 'Lineage for T991',
        },
      );
    } finally {
      process.stdout.write = origWrite;
    }

    expect(written.length).toBeGreaterThan(0);
    const envelope = JSON.parse(written.trim()) as Record<string, unknown>;
    expect(envelope['success']).toBe(true);
    expect(envelope['meta']).toBeDefined();
    const meta = envelope['meta'] as Record<string, unknown>;
    expect(meta['operation']).toBe('audit.reconstruct');
    expect(meta['timestamp']).toBeDefined();
  });

  it('emits human output via renderAuditReconstruct renderer', async () => {
    const { cliOutput } = await import('../../renderers/index.js');
    setFormatContext({ format: 'human', source: 'flag', quiet: false });

    let written = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown): boolean => {
      written += String(chunk);
      return true;
    };

    try {
      cliOutput(
        {
          taskId: 'T991',
          directCommits: [
            {
              sha: 'abc123456789',
              subject: 'feat(T991): ship it',
              authorDate: '2026-05-01',
              author: 'dev',
            },
          ],
          childIdRange: null,
          childCommits: {},
          releaseTags: [],
          releaseCommitShas: [],
          inferredChildren: [],
          firstSeenAt: '2026-05-01T00:00:00Z',
          lastSeenAt: '2026-05-01T00:00:00Z',
        },
        {
          command: 'audit-reconstruct',
          operation: 'audit.reconstruct',
          message: 'Lineage for T991',
        },
      );
    } finally {
      process.stdout.write = origWrite;
      setFormatContext({ format: 'json', source: 'default', quiet: false });
    }

    expect(written.length).toBeGreaterThan(0);
    expect(written).toContain('T991');
    expect(written).toContain('abc12345');
    expect(written).toContain('feat(T991): ship it');
  });
});

describe('actual audit command assessment delivery', () => {
  let stdout: string;
  let stderr: string;
  const assessed = (coverage: 'current' | 'partial' | 'failed'): ReconstructResult => ({
    taskId: 'T994',
    directCommits: [],
    childIdRange: null,
    childCommits: {},
    releaseTags: [],
    releaseCommitShas: [],
    inferredChildren: [],
    firstSeenAt: null,
    lastSeenAt: null,
    assessment: {
      repositoryRoot: '/synthetic/repo',
      deadlineAt: 123,
      coverage,
      shallow: false,
      observedCommits: 0,
      historyComplete: coverage !== 'failed',
      tagsComplete: coverage === 'current',
      commands: [],
      diagnostics:
        coverage === 'current'
          ? []
          : [{ code: 'E_GIT_READ_FAILED', stage: 'tags', message: 'Git permission denied' }],
      limitations: [
        'Only locally reachable refs are assessed.',
        'Numeric proximity is not task authority.',
      ],
    },
  });
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    stdout = '';
    stderr = '';
    process.exitCode = undefined;
    setOutputMode('envelope');
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    setOutputMode('envelope');
  });

  it.each([
    'partial',
    'failed',
  ] as const)('preserves %s assessment in a failing canonical envelope', async (coverage) => {
    const evidence = assessed(coverage);
    vi.spyOn(auditSdk, 'reconstructLineage').mockResolvedValue(evidence);
    await runCommand(auditCommand, {
      rawArgs: ['reconstruct', 'T994', '--repo-root', '/synthetic/repo'],
    });
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      success: false,
      error: { codeName: 'E_AUDIT_INCOMPLETE', details: evidence },
    });
  });

  it('emits genuine assessed absence as success and forwards explicit bounded limits', async () => {
    const evidence = assessed('current');
    const spy = vi.spyOn(auditSdk, 'reconstructLineage').mockResolvedValue(evidence);
    const started = Date.now();
    await runCommand(auditCommand, {
      rawArgs: [
        'reconstruct',
        't994',
        '--repo-root',
        '/synthetic/repo',
        '--budget-ms',
        '12000',
        '--max-output-bytes',
        '1048576',
      ],
    });
    expect(process.exitCode).toBeUndefined();
    expect(console.log).not.toHaveBeenCalled();
    expect(JSON.parse(stdout)).toMatchObject({ success: true, data: evidence });
    expect(spy).toHaveBeenCalledWith('T994', '/synthetic/repo', {
      execution: { deadlineAt: expect.any(Number) },
      maxOutputBytes: 1048576,
    });
    const deadline = spy.mock.calls[0]?.[2]?.execution?.deadlineAt;
    expect(deadline).toBeGreaterThanOrEqual(started + 12000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 12000);
  });

  it.each([
    '-1',
    '1.5',
    'Infinity',
    '9007199254740992',
  ])('rejects invalid budget %s before SDK execution', async (budget) => {
    const spy = vi.spyOn(auditSdk, 'reconstructLineage');
    await runCommand(auditCommand, {
      rawArgs: ['reconstruct', 'T994', '--repo-root', '/synthetic/repo', '--budget-ms', budget],
    });
    expect(process.exitCode).toBe(1);
    expect(spy).not.toHaveBeenCalled();
    expect(JSON.parse(stdout)).toMatchObject({
      success: false,
      error: { codeName: 'E_VALIDATION' },
    });
  });

  it('renders failure coverage and diagnostics in human and silent output', async () => {
    vi.spyOn(auditSdk, 'reconstructLineage').mockResolvedValue(assessed('failed'));
    setFormatContext({ format: 'human', source: 'flag', quiet: false });
    for (const mode of ['envelope', 'silent'] as const) {
      stderr = '';
      setOutputMode(mode);
      await runCommand(auditCommand, {
        rawArgs: ['reconstruct', 'T994', '--repo-root', '/synthetic/repo'],
      });
      expect(process.exitCode).toBe(1);
      expect(stderr).toContain('Coverage: failed');
      expect(stderr).toContain('Git permission denied');
      expect(stderr).toContain('Numeric proximity is not task authority.');
      expect(stdout).toBe('');
    }
  });

  it('places mandatory assessment truth before lineage examples and marks legacy unknown', () => {
    const current = renderAuditReconstruct({ ...assessed('partial') }, false);
    expect(current.indexOf('Coverage: partial')).toBeLessThan(current.indexOf('Direct commits:'));
    expect(current).toContain('historyComplete');
    expect(current).toContain('tagsComplete');
    expect(current).toContain('Git permission denied');
    expect(renderAuditReconstruct({ taskId: 'T994', directCommits: [] }, false)).toContain(
      'Coverage: unknown',
    );
  });
});
