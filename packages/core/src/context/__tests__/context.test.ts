/**
 * Unit tests for core/src/context module.
 *
 * Covers all three exported functions:
 *   - getContextStatus
 *   - checkContextThreshold (including the exit-code map)
 *   - listContextSessions
 *
 * @task T1530
 * @epic T1520
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkContextThreshold, getContextStatus, listContextSessions } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a minimal context-state JSON file. */
async function writeStateFile(
  filePath: string,
  opts: {
    status: string;
    percentage?: number;
    currentTokens?: number;
    maxTokens?: number;
    /** If true, set timestamp to 1 hour ago (stale). */
    stale?: boolean;
    staleAfterMs?: number;
    sessionId?: string;
  },
): Promise<void> {
  const age = opts.stale ? 3_600_000 : 0;
  const ts = new Date(Date.now() - age).toISOString();
  const payload = {
    status: opts.status,
    timestamp: ts,
    staleAfterMs: opts.staleAfterMs ?? 5000,
    sessionId: opts.sessionId ?? null,
    contextWindow: {
      percentage: opts.percentage ?? 42,
      currentTokens: opts.currentTokens ?? 42000,
      maxTokens: opts.maxTokens ?? 100000,
    },
  };
  await mkdir(filePath.replace(/\/[^/]+$/, ''), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload), 'utf-8');
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let tempDir: string;
let cleoDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-ctx-test-'));
  cleoDir = join(tempDir, '.cleo');
  await mkdir(cleoDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getContextStatus
// ---------------------------------------------------------------------------

describe('getContextStatus', () => {
  it('returns available:false when no state file exists', async () => {
    const result = await getContextStatus({ cwd: tempDir });
    expect(result.available).toBe(false);
    expect(result.message).toBeTruthy();
  });

  it('returns status and token fields from singleton .context-state.json', async () => {
    const stateFile = join(cleoDir, '.context-state.json');
    await writeStateFile(stateFile, {
      status: 'ok',
      percentage: 30,
      currentTokens: 30000,
      maxTokens: 100000,
    });

    const result = await getContextStatus({ cwd: tempDir });
    expect(result.available).toBe(true);
    expect(result.status).toBe('ok');
    expect(result.percentage).toBe(30);
    expect(result.currentTokens).toBe(30000);
    expect(result.maxTokens).toBe(100000);
    expect(result.stale).toBe(false);
  });

  it('marks status as stale when timestamp is older than staleAfterMs', async () => {
    const stateFile = join(cleoDir, '.context-state.json');
    await writeStateFile(stateFile, { status: 'ok', stale: true, staleAfterMs: 5000 });

    const result = await getContextStatus({ cwd: tempDir });
    expect(result.available).toBe(true);
    expect(result.status).toBe('stale');
    expect(result.stale).toBe(true);
  });

  it('resolves session-specific state file when session is specified', async () => {
    const sessionId = 'abc123';
    const statesDir = join(cleoDir, 'context-states');
    await mkdir(statesDir, { recursive: true });
    const sessionFile = join(statesDir, `context-state-${sessionId}.json`);
    await writeStateFile(sessionFile, { status: 'warning', percentage: 65, sessionId });

    const result = await getContextStatus({ cwd: tempDir, session: sessionId });
    expect(result.available).toBe(true);
    expect(result.status).toBe('warning');
    expect(result.percentage).toBe(65);
  });
});

// ---------------------------------------------------------------------------
// checkContextThreshold — exit-code map
// ---------------------------------------------------------------------------

describe('checkContextThreshold', () => {
  it('returns exitCode 54 (stale) when no state file exists', async () => {
    const result = await checkContextThreshold({ cwd: tempDir });
    expect(result.status).toBe('stale');
    expect(result.exitCode).toBe(54);
  });

  const exitCodeCases: Array<{ status: string; exitCode: number }> = [
    { status: 'ok', exitCode: 0 },
    { status: 'warning', exitCode: 50 },
    { status: 'caution', exitCode: 51 },
    { status: 'critical', exitCode: 52 },
    { status: 'emergency', exitCode: 53 },
    { status: 'stale', exitCode: 54 },
  ];

  for (const { status, exitCode } of exitCodeCases) {
    it(`maps status "${status}" to exitCode ${exitCode}`, async () => {
      const stateFile = join(cleoDir, '.context-state.json');
      // Use a large staleAfterMs so non-stale statuses are not overridden
      await writeStateFile(stateFile, { status, staleAfterMs: 3_600_000 });

      const result = await checkContextThreshold({ cwd: tempDir });
      expect(result.status).toBe(status);
      expect(result.exitCode).toBe(exitCode);
    });
  }

  it('returns exitCode 54 when state file timestamp is stale', async () => {
    const stateFile = join(cleoDir, '.context-state.json');
    await writeStateFile(stateFile, { status: 'ok', stale: true, staleAfterMs: 5000 });

    const result = await checkContextThreshold({ cwd: tempDir });
    expect(result.status).toBe('stale');
    expect(result.exitCode).toBe(54);
  });

  it('returns percentage from state file', async () => {
    const stateFile = join(cleoDir, '.context-state.json');
    await writeStateFile(stateFile, { status: 'ok', percentage: 71, staleAfterMs: 3_600_000 });

    const result = await checkContextThreshold({ cwd: tempDir });
    expect(result.percentage).toBe(71);
  });
});

// ---------------------------------------------------------------------------
// listContextSessions
// ---------------------------------------------------------------------------

describe('listContextSessions', () => {
  it('returns count:0 when no state files exist', async () => {
    const result = await listContextSessions(tempDir);
    expect(result.count).toBe(0);
    expect(result.sessions).toHaveLength(0);
  });

  it('includes singleton .context-state.json as "global" session', async () => {
    const stateFile = join(cleoDir, '.context-state.json');
    await writeStateFile(stateFile, { status: 'ok', percentage: 20, sessionId: 'global-id' });

    const result = await listContextSessions(tempDir);
    expect(result.count).toBe(1);
    const sessions = result.sessions as Array<Record<string, unknown>>;
    const global = sessions.find((s) => s['file'] === '.context-state.json');
    expect(global).toBeDefined();
    expect(global!['status']).toBe('ok');
    expect(global!['percentage']).toBe(20);
  });

  it('includes all session-specific state files from context-states/', async () => {
    const statesDir = join(cleoDir, 'context-states');
    await mkdir(statesDir, { recursive: true });
    await writeStateFile(join(statesDir, 'context-state-s1.json'), {
      status: 'warning',
      percentage: 55,
      sessionId: 's1',
    });
    await writeStateFile(join(statesDir, 'context-state-s2.json'), {
      status: 'ok',
      percentage: 10,
      sessionId: 's2',
    });

    const result = await listContextSessions(tempDir);
    expect(result.count).toBe(2);
    const sessions = result.sessions as Array<Record<string, unknown>>;
    const s1 = sessions.find((s) => s['sessionId'] === 's1');
    const s2 = sessions.find((s) => s['sessionId'] === 's2');
    expect(s1!['status']).toBe('warning');
    expect(s2!['status']).toBe('ok');
  });

  it('silently skips malformed JSON files', async () => {
    const statesDir = join(cleoDir, 'context-states');
    await mkdir(statesDir, { recursive: true });
    await writeFile(join(statesDir, 'context-state-bad.json'), '{not valid json', 'utf-8');
    await writeStateFile(join(statesDir, 'context-state-good.json'), {
      status: 'ok',
      sessionId: 'good',
    });

    const result = await listContextSessions(tempDir);
    expect(result.count).toBe(1);
    const sessions = result.sessions as Array<Record<string, unknown>>;
    expect(sessions[0]!['sessionId']).toBe('good');
  });
});
