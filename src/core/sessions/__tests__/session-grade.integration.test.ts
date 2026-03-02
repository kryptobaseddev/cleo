/**
 * Integration test for session grading: full flow from audit entries
 * through grading to GRADES.jsonl persistence and readback.
 *
 * Mocks only queryAudit (SQLite dependency) while letting all other
 * components (scoring logic, file I/O, paths) operate on real temp dirs.
 *
 * @task T4916
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import type { AuditEntry } from '../../../../dispatch/middleware/audit.js';

// Mock only the SQLite-dependent queryAudit; all other code is real
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

import { gradeSession, readGrades } from '../session-grade.js';
import type { GradeResult } from '../session-grade.js';

// ---- Helpers ----

const BASE_TS = '2026-03-01T14:00:00.000Z';
function ts(offsetMs: number): string {
  return new Date(new Date(BASE_TS).getTime() + offsetMs).toISOString();
}

function entry(
  overrides: Partial<AuditEntry> & { domain: string; operation: string },
): AuditEntry {
  return {
    timestamp: overrides.timestamp ?? BASE_TS,
    sessionId: overrides.sessionId ?? 'integ-session',
    domain: overrides.domain,
    operation: overrides.operation,
    params: overrides.params ?? {},
    result: overrides.result ?? { success: true, exitCode: 0, duration: 10 },
    metadata: overrides.metadata ?? { source: 'mcp' },
    error: overrides.error,
  };
}

// ---- Realistic Session Scenarios ----

/** A well-behaved agent session: checks sessions, uses find, adds with descriptions, ends properly. */
function exemplarySession(): AuditEntry[] {
  return [
    // Check existing sessions first
    entry({ domain: 'session', operation: 'list', timestamp: ts(0), metadata: { source: 'mcp', gateway: 'cleo_query' } }),
    // Use admin.help for progressive disclosure
    entry({ domain: 'admin', operation: 'help', timestamp: ts(1000), metadata: { source: 'mcp', gateway: 'cleo_query' } }),
    // Discover tasks with find (not list)
    entry({ domain: 'tasks', operation: 'find', timestamp: ts(2000), metadata: { source: 'mcp', gateway: 'cleo_query' } }),
    // Drill into specific task
    entry({ domain: 'tasks', operation: 'show', timestamp: ts(3000), metadata: { source: 'mcp', gateway: 'cleo_query' } }),
    // Check parent exists before creating subtask
    entry({ domain: 'tasks', operation: 'exists', timestamp: ts(4000), metadata: { source: 'mcp', gateway: 'cleo_query' } }),
    // Create subtask with proper description
    entry({
      domain: 'tasks',
      operation: 'add',
      timestamp: ts(5000),
      params: { title: 'Implement feature X', description: 'Build the X feature as described in spec', parent: 'T100' },
      result: { success: true, exitCode: 0, duration: 50 },
      metadata: { source: 'mcp', gateway: 'cleo_mutate' },
    }),
    // Complete a task
    entry({
      domain: 'tasks',
      operation: 'complete',
      timestamp: ts(6000),
      params: { taskId: 'T101' },
      result: { success: true, exitCode: 0, duration: 30 },
      metadata: { source: 'mcp', gateway: 'cleo_mutate' },
    }),
    // End session properly
    entry({ domain: 'session', operation: 'end', timestamp: ts(7000), metadata: { source: 'mcp', gateway: 'cleo_mutate' } }),
  ];
}

/** A sloppy agent session: skips session check, uses list, creates without descriptions, no error recovery. */
function sloppySession(): AuditEntry[] {
  return [
    // Jump straight to task discovery without checking sessions
    entry({ domain: 'tasks', operation: 'list', timestamp: ts(0) }),
    // Use list again instead of find
    entry({ domain: 'tasks', operation: 'list', timestamp: ts(1000) }),
    // Create task without description
    entry({
      domain: 'tasks',
      operation: 'add',
      timestamp: ts(2000),
      params: { title: 'Do something' },
      result: { success: true, exitCode: 0, duration: 20 },
    }),
    // Hit a not-found error
    entry({
      domain: 'tasks',
      operation: 'show',
      timestamp: ts(3000),
      result: { success: false, exitCode: 4, duration: 5 },
    }),
    // No recovery — just try again with same failing pattern
    entry({
      domain: 'tasks',
      operation: 'show',
      timestamp: ts(4000),
      result: { success: false, exitCode: 4, duration: 5 },
    }),
    // Create duplicate task
    entry({
      domain: 'tasks',
      operation: 'add',
      timestamp: ts(5000),
      params: { title: 'Do something', description: 'Duplicate' },
      result: { success: true, exitCode: 0, duration: 20 },
    }),
    // No session.end, no help calls, no MCP gateway
  ];
}

// ---- Integration Test Suite ----

describe('Session grade integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-grade-integ-'));
    mocks.tempCleoDir.value = join(tempDir, '.cleo');
    await mkdir(join(tempDir, '.cleo', 'metrics'), { recursive: true });
    mocks.queryAudit.mockReset();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('grades an exemplary session with score 100/100', async () => {
    mocks.queryAudit.mockResolvedValue(exemplarySession());

    const result = await gradeSession('exemplary-1', tempDir);

    expect(result.sessionId).toBe('exemplary-1');
    expect(result.totalScore).toBe(100);
    expect(result.maxScore).toBe(100);
    expect(result.entryCount).toBe(8);

    // All dimensions maxed
    expect(result.dimensions.sessionDiscipline.score).toBe(20);
    expect(result.dimensions.discoveryEfficiency.score).toBe(20);
    expect(result.dimensions.taskHygiene.score).toBe(20);
    expect(result.dimensions.errorProtocol.score).toBe(20);
    expect(result.dimensions.disclosureUse.score).toBe(20);

    // Minimal flags — none for a perfect session
    const violationFlags = result.flags.filter(
      f => !f.startsWith('No audit entries'),
    );
    expect(violationFlags).toEqual([]);
  });

  it('grades a sloppy session with low score and flags', async () => {
    mocks.queryAudit.mockResolvedValue(sloppySession());

    const result = await gradeSession('sloppy-1', tempDir);

    // Session discipline: no session.list before tasks (0), no session.end (0) = 0
    expect(result.dimensions.sessionDiscipline.score).toBe(0);

    // Discovery: 0 find, 2 list = 0% ratio -> 0 points + 5 (show bonus from failed show calls) = 5
    expect(result.dimensions.discoveryEfficiency.score).toBe(5);

    // Task hygiene: 20 - 5 (no desc on first add) = 15
    // (second add has description so only -5 once, but also duplicate detected in errorProtocol)
    expect(result.dimensions.taskHygiene.score).toBeLessThanOrEqual(15);

    // Error protocol: 2 unrecovered E_NOT_FOUND (-10) + 1 duplicate (-5) = max(0, 20-15) = 5
    expect(result.dimensions.errorProtocol.score).toBeLessThanOrEqual(10);

    // Disclosure: no help (0), no cleo_query (0) = 0
    expect(result.dimensions.disclosureUse.score).toBe(0);

    // Total should be low
    expect(result.totalScore).toBeLessThan(50);

    // Should have multiple flags
    expect(result.flags.length).toBeGreaterThan(3);
  });

  it('full round-trip: grade → persist → readGrades', async () => {
    // Grade two sessions
    mocks.queryAudit.mockResolvedValue(exemplarySession());
    const grade1 = await gradeSession('roundtrip-a', tempDir);

    mocks.queryAudit.mockResolvedValue(sloppySession());
    const grade2 = await gradeSession('roundtrip-b', tempDir);

    // Verify GRADES.jsonl exists
    const gradesPath = join(tempDir, '.cleo', 'metrics', 'GRADES.jsonl');
    expect(existsSync(gradesPath)).toBe(true);

    // Read all grades back
    const allGrades = await readGrades(undefined, tempDir);
    expect(allGrades).toHaveLength(2);
    expect(allGrades[0].sessionId).toBe('roundtrip-a');
    expect(allGrades[1].sessionId).toBe('roundtrip-b');

    // Filter by session
    const filtered = await readGrades('roundtrip-a', tempDir);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].totalScore).toBe(grade1.totalScore);

    // Verify stored data is valid JSON with evaluator field
    const raw = await readFile(gradesPath, 'utf8');
    const lines = raw.trim().split('\n');
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.evaluator).toBe('auto');
      expect(parsed.dimensions).toBeDefined();
      expect(typeof parsed.totalScore).toBe('number');
      expect(typeof parsed.timestamp).toBe('string');
    }
  });

  it('handles grading the same session multiple times', async () => {
    mocks.queryAudit.mockResolvedValue(exemplarySession());

    await gradeSession('multi-grade', tempDir);
    await gradeSession('multi-grade', tempDir);

    const grades = await readGrades('multi-grade', tempDir);
    expect(grades).toHaveLength(2);
    // Both should have same score since entries are the same
    expect(grades[0].totalScore).toBe(grades[1].totalScore);
  });

  it('scores empty session as 0 with informative flag', async () => {
    mocks.queryAudit.mockResolvedValue([]);

    const result = await gradeSession('empty-integ', tempDir);

    expect(result.totalScore).toBe(0);
    expect(result.entryCount).toBe(0);
    expect(result.flags).toContain(
      'No audit entries found for session (use --grade flag when starting session)',
    );

    // Still persists to GRADES.jsonl
    const grades = await readGrades('empty-integ', tempDir);
    expect(grades).toHaveLength(1);
  });

  it('GradeResult conforms to expected schema shape', async () => {
    mocks.queryAudit.mockResolvedValue(exemplarySession());

    const result = await gradeSession('schema-check', tempDir);

    // Required fields per grade.schema.json
    expect(result).toHaveProperty('sessionId');
    expect(result).toHaveProperty('totalScore');
    expect(result).toHaveProperty('maxScore');
    expect(result).toHaveProperty('dimensions');
    expect(result).toHaveProperty('flags');
    expect(result).toHaveProperty('timestamp');
    expect(result).toHaveProperty('entryCount');

    // Dimension shape
    for (const dim of Object.values(result.dimensions)) {
      expect(dim).toHaveProperty('score');
      expect(dim).toHaveProperty('max');
      expect(dim).toHaveProperty('evidence');
      expect(typeof dim.score).toBe('number');
      expect(typeof dim.max).toBe('number');
      expect(Array.isArray(dim.evidence)).toBe(true);
      expect(dim.score).toBeGreaterThanOrEqual(0);
      expect(dim.score).toBeLessThanOrEqual(dim.max);
    }

    // totalScore bounds
    expect(result.totalScore).toBeGreaterThanOrEqual(0);
    expect(result.totalScore).toBeLessThanOrEqual(100);
    expect(result.maxScore).toBe(100);

    // Timestamp is ISO string
    expect(() => new Date(result.timestamp)).not.toThrow();
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });

  it('dimension scores sum to totalScore', async () => {
    mocks.queryAudit.mockResolvedValue(sloppySession());

    const result = await gradeSession('sum-check', tempDir);

    const dimensionSum = Object.values(result.dimensions).reduce(
      (sum, d) => sum + d.score,
      0,
    );
    expect(result.totalScore).toBe(dimensionSum);
  });
});
