/**
 * Unit tests for session-grade rubric scoring.
 * @task T4916
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AuditEntry } from '../../../../dispatch/middleware/audit.js';

// We need to mock two modules: queryAudit (to inject test data) and
// getCleoDirAbsolute (to redirect file writes to temp dirs).
// Use vi.hoisted to create stable fn references for the mocks.
const mocks = vi.hoisted(() => ({
  queryAudit: vi.fn<() => Promise<AuditEntry[]>>(),
  tempCleoDir: { value: '' },
}));

vi.mock('../../../dispatch/middleware/audit.js', () => ({
  queryAudit: mocks.queryAudit,
}));

vi.mock('../../paths.js', () => ({
  getCleoDirAbsolute: (cwd?: string) =>
    cwd ? join(cwd, '.cleo') : mocks.tempCleoDir.value,
}));

// Import after mocks are set up
import { gradeSession, readGrades } from '../session-grade.js';

// ---- Helpers ----

const T = '2026-03-01T12:00:00.000Z';
function ts(offsetMs: number): string {
  return new Date(new Date(T).getTime() + offsetMs).toISOString();
}

/** Build a minimal AuditEntry for testing. */
function entry(
  overrides: Partial<AuditEntry> & { domain: string; operation: string },
): AuditEntry {
  return {
    timestamp: overrides.timestamp ?? T,
    sessionId: overrides.sessionId ?? 'test-session',
    domain: overrides.domain,
    operation: overrides.operation,
    params: overrides.params ?? {},
    result: overrides.result ?? { success: true, exitCode: 0, duration: 10 },
    metadata: overrides.metadata ?? { source: 'mcp' },
    error: overrides.error,
  };
}

// ---- Test Suites ----

describe('gradeSession', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-grade-'));
    mocks.tempCleoDir.value = join(tempDir, '.cleo');
    await mkdir(join(tempDir, '.cleo', 'metrics'), { recursive: true });
    mocks.queryAudit.mockReset().mockResolvedValue([]);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ------ Edge cases ------

  describe('edge cases', () => {
    it('scores 0/100 for empty audit entries', async () => {
      mocks.queryAudit.mockResolvedValue([]);
      const result = await gradeSession('empty-session', tempDir);

      expect(result.totalScore).toBe(0);
      expect(result.maxScore).toBe(100);
      expect(result.entryCount).toBe(0);
      expect(result.flags).toContain(
        'No audit entries found for session (use --grade flag when starting session)',
      );
    });

    it('scores 100/100 for all-perfect entries', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'session', operation: 'list', timestamp: ts(0) }),
        entry({ domain: 'admin', operation: 'help', timestamp: ts(100), metadata: { source: 'mcp', gateway: 'cleo_query' } }),
        entry({ domain: 'tasks', operation: 'find', timestamp: ts(200), metadata: { source: 'mcp', gateway: 'cleo_query' } }),
        entry({ domain: 'tasks', operation: 'show', timestamp: ts(300), metadata: { source: 'mcp', gateway: 'cleo_query' } }),
        entry({ domain: 'tasks', operation: 'exists', timestamp: ts(400) }),
        entry({
          domain: 'tasks',
          operation: 'add',
          timestamp: ts(500),
          params: { title: 'New task', description: 'A real description', parent: 'T100' },
          result: { success: true, exitCode: 0, duration: 10 },
        }),
        entry({ domain: 'session', operation: 'end', timestamp: ts(600) }),
      ]);

      const result = await gradeSession('perfect-session', tempDir);

      expect(result.totalScore).toBe(100);
      expect(result.dimensions.sessionDiscipline.score).toBe(20);
      expect(result.dimensions.discoveryEfficiency.score).toBe(20);
      expect(result.dimensions.taskHygiene.score).toBe(20);
      expect(result.dimensions.errorProtocol.score).toBe(20);
      expect(result.dimensions.disclosureUse.score).toBe(20);
    });
  });

  // ------ S1: Session Discipline ------

  describe('S1 Session Discipline (20pts)', () => {
    it('awards 10pts when session.list called before task ops', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'session', operation: 'list', timestamp: ts(0) }),
        entry({ domain: 'tasks', operation: 'find', timestamp: ts(100) }),
      ]);

      const result = await gradeSession('s1-test', tempDir);

      expect(result.dimensions.sessionDiscipline.score).toBe(10);
      expect(result.dimensions.sessionDiscipline.evidence).toContain(
        'session.list called before first task op',
      );
    });

    it('flags when session.list called after task ops', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'tasks', operation: 'find', timestamp: ts(0) }),
        entry({ domain: 'session', operation: 'list', timestamp: ts(100) }),
      ]);

      const result = await gradeSession('s1-late', tempDir);

      expect(result.dimensions.sessionDiscipline.score).toBe(0);
      expect(result.flags).toContain(
        'session.list called after task ops (should check sessions first)',
      );
    });

    it('flags when session.list never called', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'tasks', operation: 'find', timestamp: ts(0) }),
      ]);

      const result = await gradeSession('s1-none', tempDir);

      expect(result.flags).toContain(
        'session.list never called (check existing sessions before starting)',
      );
    });

    it('awards 10pts for session.end called', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'session', operation: 'end', timestamp: ts(0) }),
      ]);

      const result = await gradeSession('s1-end', tempDir);

      expect(result.dimensions.sessionDiscipline.score).toBe(10);
      expect(result.dimensions.sessionDiscipline.evidence).toContain('session.end called');
    });

    it('flags when session.end never called', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'tasks', operation: 'find', timestamp: ts(0) }),
      ]);

      const result = await gradeSession('s1-noend', tempDir);

      expect(result.flags).toContain(
        'session.end never called (always end sessions when done)',
      );
    });

    it('awards 20pts for both session.list (before) and session.end', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'session', operation: 'list', timestamp: ts(0) }),
        entry({ domain: 'tasks', operation: 'find', timestamp: ts(100) }),
        entry({ domain: 'session', operation: 'end', timestamp: ts(200) }),
      ]);

      const result = await gradeSession('s1-perfect', tempDir);

      expect(result.dimensions.sessionDiscipline.score).toBe(20);
    });
  });

  // ------ S2: Discovery Efficiency ------

  describe('S2 Discovery Efficiency (20pts)', () => {
    it('awards 15pts when find:list ratio >= 80%', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'tasks', operation: 'find', timestamp: ts(0) }),
        entry({ domain: 'tasks', operation: 'find', timestamp: ts(100) }),
        entry({ domain: 'tasks', operation: 'find', timestamp: ts(200) }),
        entry({ domain: 'tasks', operation: 'find', timestamp: ts(300) }),
      ]);

      const result = await gradeSession('s2-find', tempDir);

      expect(result.dimensions.discoveryEfficiency.score).toBe(15);
      expect(result.dimensions.discoveryEfficiency.evidence).toEqual(
        expect.arrayContaining([expect.stringMatching(/find:list ratio 100% >= 80%/)]),
      );
    });

    it('reduces score proportionally when find ratio < 80%', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'tasks', operation: 'find', timestamp: ts(0) }),
        entry({ domain: 'tasks', operation: 'list', timestamp: ts(100) }),
        // 1 find, 1 list = 50% ratio -> round(15 * 0.5) = 8
      ]);

      const result = await gradeSession('s2-mixed', tempDir);

      expect(result.dimensions.discoveryEfficiency.score).toBe(8);
      expect(result.flags).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/tasks\.list used 1x/),
        ]),
      );
    });

    it('awards 10pts when no discovery calls needed', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'session', operation: 'list', timestamp: ts(0) }),
      ]);

      const result = await gradeSession('s2-none', tempDir);

      expect(result.dimensions.discoveryEfficiency.score).toBe(10);
      expect(result.dimensions.discoveryEfficiency.evidence).toContain(
        'No discovery calls needed',
      );
    });

    it('adds +5 bonus for tasks.show usage', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'tasks', operation: 'find', timestamp: ts(0) }),
        entry({ domain: 'tasks', operation: 'show', timestamp: ts(100) }),
      ]);

      const result = await gradeSession('s2-show', tempDir);

      // 15 (100% find ratio) + 5 (show bonus) = 20
      expect(result.dimensions.discoveryEfficiency.score).toBe(20);
      expect(result.dimensions.discoveryEfficiency.evidence).toEqual(
        expect.arrayContaining([expect.stringMatching(/tasks\.show used 1x/)]),
      );
    });

    it('caps discovery score at 20', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'tasks', operation: 'find', timestamp: ts(0) }),
        entry({ domain: 'tasks', operation: 'show', timestamp: ts(100) }),
        entry({ domain: 'tasks', operation: 'show', timestamp: ts(200) }),
        entry({ domain: 'tasks', operation: 'show', timestamp: ts(300) }),
      ]);

      const result = await gradeSession('s2-cap', tempDir);

      expect(result.dimensions.discoveryEfficiency.score).toBeLessThanOrEqual(20);
    });

    it('awards 15 (zero-call bonus + show) for no discovery + show', async () => {
      // No find or list, but show is present -> 10 (zero-call) + 5 (show) = 15
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'tasks', operation: 'show', timestamp: ts(0) }),
      ]);

      const result = await gradeSession('s2-nodisc-show', tempDir);

      expect(result.dimensions.discoveryEfficiency.score).toBe(15);
    });
  });

  // ------ S3: Task Hygiene ------

  describe('S3 Task Hygiene (20pts)', () => {
    it('starts at 20pts with no add calls', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'tasks', operation: 'find', timestamp: ts(0) }),
      ]);

      const result = await gradeSession('s3-noadd', tempDir);

      expect(result.dimensions.taskHygiene.score).toBe(20);
    });

    it('deducts -5 per add without description', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({
          domain: 'tasks',
          operation: 'add',
          params: { title: 'No desc task' },
          result: { success: true, exitCode: 0, duration: 10 },
          metadata: { source: 'mcp', taskId: 'T1' },
        }),
        entry({
          domain: 'tasks',
          operation: 'add',
          params: { title: 'Another no desc' },
          result: { success: true, exitCode: 0, duration: 10 },
          metadata: { source: 'mcp', taskId: 'T2' },
        }),
      ]);

      const result = await gradeSession('s3-nodesc', tempDir);

      // 20 - 5 - 5 = 10
      expect(result.dimensions.taskHygiene.score).toBe(10);
      const descFlags = result.flags.filter(f => f.includes('tasks.add without description'));
      expect(descFlags).toHaveLength(2);
    });

    it('deducts -5 for empty string description', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({
          domain: 'tasks',
          operation: 'add',
          params: { title: 'Empty desc', description: '   ' },
          result: { success: true, exitCode: 0, duration: 10 },
        }),
      ]);

      const result = await gradeSession('s3-emptydesc', tempDir);

      expect(result.dimensions.taskHygiene.score).toBe(15);
    });

    it('does not deduct for failed add calls', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({
          domain: 'tasks',
          operation: 'add',
          params: { title: 'Failed task' },
          result: { success: false, exitCode: 1, duration: 10 },
        }),
      ]);

      const result = await gradeSession('s3-failed', tempDir);

      expect(result.dimensions.taskHygiene.score).toBe(20);
    });

    it('deducts -3 for subtasks without parent check', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({
          domain: 'tasks',
          operation: 'add',
          params: { title: 'Subtask', description: 'A subtask', parent: 'T100' },
          result: { success: true, exitCode: 0, duration: 10 },
        }),
      ]);

      const result = await gradeSession('s3-noparent', tempDir);

      // 20 - 3 = 17
      expect(result.dimensions.taskHygiene.score).toBe(17);
      expect(result.flags).toContain('Subtasks created without tasks.exists parent check');
    });

    it('does not deduct when subtasks have exists check', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'tasks', operation: 'exists', timestamp: ts(0) }),
        entry({
          domain: 'tasks',
          operation: 'add',
          timestamp: ts(100),
          params: { title: 'Subtask', description: 'A subtask', parent: 'T100' },
          result: { success: true, exitCode: 0, duration: 10 },
        }),
      ]);

      const result = await gradeSession('s3-withcheck', tempDir);

      expect(result.dimensions.taskHygiene.score).toBe(20);
      expect(result.dimensions.taskHygiene.evidence).toContain(
        'Parent existence verified before subtask creation',
      );
    });

    it('floors hygiene score at 0', async () => {
      const adds = Array.from({ length: 5 }, (_, i) =>
        entry({
          domain: 'tasks',
          operation: 'add',
          timestamp: ts(i * 100),
          params: { title: `Task ${i}` },
          result: { success: true, exitCode: 0, duration: 10 },
        }),
      );
      mocks.queryAudit.mockResolvedValue(adds);

      const result = await gradeSession('s3-floor', tempDir);

      expect(result.dimensions.taskHygiene.score).toBe(0);
    });

    it('adds evidence when all adds have descriptions', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({
          domain: 'tasks',
          operation: 'add',
          params: { title: 'Good task', description: 'Has a description' },
          result: { success: true, exitCode: 0, duration: 10 },
        }),
      ]);

      const result = await gradeSession('s3-alldesc', tempDir);

      expect(result.dimensions.taskHygiene.evidence).toContain(
        'All 1 tasks.add calls had descriptions',
      );
    });
  });

  // ------ S4: Error Protocol ------

  describe('S4 Error Protocol (20pts)', () => {
    it('starts at 20pts with no errors', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'tasks', operation: 'find', timestamp: ts(0) }),
      ]);

      const result = await gradeSession('s4-clean', tempDir);

      expect(result.dimensions.errorProtocol.score).toBe(20);
      expect(result.dimensions.errorProtocol.evidence).toContain(
        'No error protocol violations',
      );
    });

    it('deducts -5 per unrecovered E_NOT_FOUND', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({
          domain: 'tasks',
          operation: 'show',
          timestamp: ts(0),
          result: { success: false, exitCode: 4, duration: 10 },
        }),
        entry({ domain: 'session', operation: 'end', timestamp: ts(100) }),
      ]);

      const result = await gradeSession('s4-norecover', tempDir);

      expect(result.dimensions.errorProtocol.score).toBe(15);
      expect(result.flags).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/E_NOT_FOUND.*not followed by recovery/),
        ]),
      );
    });

    it('does not deduct when E_NOT_FOUND is followed by recovery find', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({
          domain: 'tasks',
          operation: 'show',
          timestamp: ts(0),
          result: { success: false, exitCode: 4, duration: 10 },
        }),
        entry({ domain: 'tasks', operation: 'find', timestamp: ts(100) }),
      ]);

      const result = await gradeSession('s4-recover-find', tempDir);

      expect(result.dimensions.errorProtocol.score).toBe(20);
      expect(result.dimensions.errorProtocol.evidence).toContain(
        'E_NOT_FOUND followed by recovery lookup',
      );
    });

    it('does not deduct when E_NOT_FOUND is followed by recovery exists', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({
          domain: 'tasks',
          operation: 'show',
          timestamp: ts(0),
          result: { success: false, exitCode: 4, duration: 10 },
        }),
        entry({ domain: 'tasks', operation: 'exists', timestamp: ts(100) }),
      ]);

      const result = await gradeSession('s4-recover-exists', tempDir);

      expect(result.dimensions.errorProtocol.score).toBe(20);
    });

    it('checks recovery within next 4 entries only', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({
          domain: 'tasks',
          operation: 'show',
          timestamp: ts(0),
          result: { success: false, exitCode: 4, duration: 10 },
        }),
        entry({ domain: 'session', operation: 'list', timestamp: ts(100) }),
        entry({ domain: 'session', operation: 'list', timestamp: ts(200) }),
        entry({ domain: 'session', operation: 'list', timestamp: ts(300) }),
        entry({ domain: 'session', operation: 'list', timestamp: ts(400) }),
        entry({ domain: 'session', operation: 'list', timestamp: ts(500) }),
        entry({ domain: 'tasks', operation: 'find', timestamp: ts(600) }),
      ]);

      const result = await gradeSession('s4-late-recovery', tempDir);

      expect(result.dimensions.errorProtocol.score).toBe(15);
    });

    it('deducts -5 for duplicate task creates', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({
          domain: 'tasks',
          operation: 'add',
          timestamp: ts(0),
          params: { title: 'Same Title', description: 'Desc 1' },
          result: { success: true, exitCode: 0, duration: 10 },
        }),
        entry({
          domain: 'tasks',
          operation: 'add',
          timestamp: ts(100),
          params: { title: 'Same Title', description: 'Desc 2' },
          result: { success: true, exitCode: 0, duration: 10 },
        }),
      ]);

      const result = await gradeSession('s4-dup', tempDir);

      expect(result.dimensions.errorProtocol.score).toBe(15);
      expect(result.flags).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/potentially duplicate task create/),
        ]),
      );
    });

    it('detects duplicate creates case-insensitively', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({
          domain: 'tasks',
          operation: 'add',
          params: { title: 'My Task', description: 'Desc' },
          result: { success: true, exitCode: 0, duration: 10 },
        }),
        entry({
          domain: 'tasks',
          operation: 'add',
          params: { title: 'my task', description: 'Desc 2' },
          result: { success: true, exitCode: 0, duration: 10 },
        }),
      ]);

      const result = await gradeSession('s4-dup-case', tempDir);

      expect(result.dimensions.errorProtocol.score).toBe(15);
    });

    it('floors error score at 0', async () => {
      const errors = Array.from({ length: 5 }, (_, i) =>
        entry({
          domain: 'tasks',
          operation: 'show',
          timestamp: ts(i * 1000),
          result: { success: false, exitCode: 4, duration: 10 },
        }),
      );
      mocks.queryAudit.mockResolvedValue(errors);

      const result = await gradeSession('s4-floor', tempDir);

      expect(result.dimensions.errorProtocol.score).toBe(0);
    });
  });

  // ------ S5: Progressive Disclosure Use ------

  describe('S5 Progressive Disclosure Use (20pts)', () => {
    it('awards +10 for admin.help calls', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'admin', operation: 'help', timestamp: ts(0) }),
      ]);

      const result = await gradeSession('s5-help', tempDir);

      expect(result.dimensions.disclosureUse.score).toBe(10);
      expect(result.dimensions.disclosureUse.evidence).toEqual(
        expect.arrayContaining([expect.stringMatching(/Progressive disclosure used/)]),
      );
    });

    it('awards +10 for skills.list calls', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'skills', operation: 'list', timestamp: ts(0) }),
      ]);

      const result = await gradeSession('s5-skills', tempDir);

      expect(result.dimensions.disclosureUse.score).toBe(10);
    });

    it('awards +10 for skills.show calls', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'skills', operation: 'show', timestamp: ts(0) }),
      ]);

      const result = await gradeSession('s5-skill-show', tempDir);

      expect(result.dimensions.disclosureUse.score).toBe(10);
    });

    it('awards +10 for tools.skill.show calls', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'tools', operation: 'skill.show', timestamp: ts(0) }),
      ]);

      const result = await gradeSession('s5-tools-skill', tempDir);

      expect(result.dimensions.disclosureUse.score).toBe(10);
    });

    it('awards +10 for tools.skill.list calls', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'tools', operation: 'skill.list', timestamp: ts(0) }),
      ]);

      const result = await gradeSession('s5-tools-list', tempDir);

      expect(result.dimensions.disclosureUse.score).toBe(10);
    });

    it('awards +10 for cleo_query gateway usage', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({
          domain: 'tasks',
          operation: 'find',
          timestamp: ts(0),
          metadata: { source: 'mcp', gateway: 'cleo_query' },
        }),
      ]);

      const result = await gradeSession('s5-mcp', tempDir);

      expect(result.dimensions.disclosureUse.score).toBe(10);
      expect(result.dimensions.disclosureUse.evidence).toEqual(
        expect.arrayContaining([expect.stringMatching(/cleo_query.*used/)]),
      );
    });

    it('awards 20pts for both help + cleo_query', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'admin', operation: 'help', timestamp: ts(0) }),
        entry({
          domain: 'tasks',
          operation: 'find',
          timestamp: ts(100),
          metadata: { source: 'mcp', gateway: 'cleo_query' },
        }),
      ]);

      const result = await gradeSession('s5-perfect', tempDir);

      expect(result.dimensions.disclosureUse.score).toBe(20);
    });

    it('flags when no help or skill lookups', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'tasks', operation: 'find', timestamp: ts(0) }),
      ]);

      const result = await gradeSession('s5-nohelp', tempDir);

      expect(result.flags).toContain(
        'No admin.help or skill lookup calls (load ct-cleo for guidance)',
      );
    });

    it('flags when no MCP query calls', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'tasks', operation: 'find', timestamp: ts(0) }),
      ]);

      const result = await gradeSession('s5-nomcp', tempDir);

      expect(result.flags).toContain(
        'No MCP query calls (prefer cleo_query over CLI for programmatic access)',
      );
    });
  });

  // ------ Total score ------

  describe('total score calculation', () => {
    it('sums all dimension scores', async () => {
      mocks.queryAudit.mockResolvedValue([
        entry({ domain: 'session', operation: 'list', timestamp: ts(0) }),
        entry({ domain: 'session', operation: 'end', timestamp: ts(100) }),
      ]);

      const result = await gradeSession('total-test', tempDir);

      const expected =
        result.dimensions.sessionDiscipline.score +
        result.dimensions.discoveryEfficiency.score +
        result.dimensions.taskHygiene.score +
        result.dimensions.errorProtocol.score +
        result.dimensions.disclosureUse.score;
      expect(result.totalScore).toBe(expected);
    });
  });

  // ------ GRADES.jsonl output ------

  describe('appendGradeResult (via gradeSession)', () => {
    it('writes to GRADES.jsonl with evaluator field', async () => {
      mocks.queryAudit.mockResolvedValue([]);
      await gradeSession('write-test', tempDir);

      const content = await readFile(
        join(tempDir, '.cleo', 'metrics', 'GRADES.jsonl'),
        'utf8',
      );
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);

      const parsed = JSON.parse(lines[0]);
      expect(parsed.sessionId).toBe('write-test');
      expect(parsed.evaluator).toBe('auto');
      expect(parsed.totalScore).toBe(0);
      expect(parsed.dimensions).toBeDefined();
    });

    it('appends multiple grades to same file', async () => {
      mocks.queryAudit.mockResolvedValue([]);
      await gradeSession('session-1', tempDir);
      await gradeSession('session-2', tempDir);

      const content = await readFile(
        join(tempDir, '.cleo', 'metrics', 'GRADES.jsonl'),
        'utf8',
      );
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);

      expect(JSON.parse(lines[0]).sessionId).toBe('session-1');
      expect(JSON.parse(lines[1]).sessionId).toBe('session-2');
    });
  });
});

// ------ readGrades ------

describe('readGrades', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-grades-read-'));
    mocks.tempCleoDir.value = join(tempDir, '.cleo');
    await mkdir(join(tempDir, '.cleo', 'metrics'), { recursive: true });
    mocks.queryAudit.mockReset().mockResolvedValue([]);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns empty array when GRADES.jsonl does not exist', async () => {
    const grades = await readGrades(undefined, tempDir);
    expect(grades).toEqual([]);
  });

  it('reads all grades when no sessionId filter', async () => {
    await gradeSession('read-1', tempDir);
    await gradeSession('read-2', tempDir);

    const grades = await readGrades(undefined, tempDir);
    expect(grades).toHaveLength(2);
  });

  it('filters by sessionId', async () => {
    await gradeSession('filter-a', tempDir);
    await gradeSession('filter-b', tempDir);

    const grades = await readGrades('filter-a', tempDir);
    expect(grades).toHaveLength(1);
    expect(grades[0].sessionId).toBe('filter-a');
  });

  it('returns empty when sessionId has no matches', async () => {
    await gradeSession('exists-session', tempDir);

    const grades = await readGrades('nonexistent', tempDir);
    expect(grades).toEqual([]);
  });
});
