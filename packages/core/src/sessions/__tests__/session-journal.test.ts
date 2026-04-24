/**
 * E2E tests for the session journal substrate (T1263 PSYCHE E6).
 *
 * Covers:
 *   - appendSessionJournalEntry: writes valid JSONL line, creates directory
 *   - readRecentJournals: reads back entries in reverse-chronological order
 *   - getSessionJournalPath: date-based file naming
 *   - handleSessionEndJournal: hook writes entry with doctorSummary
 *   - rotateSessionJournals: hot/warm/archive/purge tier enforcement
 *
 * @task T1263
 * @epic T1075
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainDoctorResult } from '../../memory/brain-doctor.js';

// ── Hoisted mock refs ──────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  scanBrainNoise: vi.fn<() => Promise<BrainDoctorResult>>(),
  cleoDirAbsolute: { value: '' },
}));

// Mock brain-doctor so we can inject clean/noisy scan results
vi.mock('../../memory/brain-doctor.js', () => ({
  scanBrainNoise: mocks.scanBrainNoise,
}));

// Redirect getCleoDirAbsolute so appendSessionJournalEntry
// does NOT require a real project init
vi.mock('../../paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../paths.js')>('../../paths.js');
  return {
    ...actual,
    getCleoDirAbsolute: (cwd?: string) => (cwd ? join(cwd, '.cleo') : mocks.cleoDirAbsolute.value),
  };
});

// ── Import after mocks ─────────────────────────────────────────────────────

import type { SessionJournalEntry } from '@cleocode/contracts';
import { SESSION_JOURNAL_SCHEMA_VERSION } from '@cleocode/contracts';
import {
  appendSessionJournalEntry,
  getSessionJournalPath,
  readRecentJournals,
  rotateSessionJournals,
} from '../session-journal.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<SessionJournalEntry> = {}): SessionJournalEntry {
  return {
    schemaVersion: SESSION_JOURNAL_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    sessionId: 'ses_test_001',
    eventType: 'session_end',
    ...overrides,
  };
}

function cleanDoctorResult(totalScanned = 5): BrainDoctorResult {
  return {
    isClean: true,
    findings: [],
    totalScanned,
    scannedAt: new Date().toISOString(),
  };
}

function noisyDoctorResult(): BrainDoctorResult {
  return {
    isClean: false,
    findings: [
      {
        pattern: 'duplicate-content',
        count: 3,
        sampleIds: ['id1', 'id2', 'id3'],
        description: 'Entries with duplicate content hashes',
      },
    ],
    totalScanned: 10,
    scannedAt: new Date().toISOString(),
  };
}

// ── Test setup ─────────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'cleo-journal-test-'));
  mocks.cleoDirAbsolute.value = join(tmpRoot, '.cleo');
  mocks.scanBrainNoise.mockResolvedValue(cleanDoctorResult());
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('getSessionJournalPath', () => {
  it('returns a YYYY-MM-DD.jsonl path for today by default', () => {
    const path = getSessionJournalPath(tmpRoot);
    expect(path).toMatch(/\d{4}-\d{2}-\d{2}\.jsonl$/);
    expect(path).toContain('.cleo/session-journals/');
    expect(path).toContain(tmpRoot);
  });

  it('returns the correct path for a given date', () => {
    const date = new Date('2026-04-24T10:00:00.000Z');
    const path = getSessionJournalPath(tmpRoot, date);
    expect(path).toContain('2026-04-24.jsonl');
  });
});

describe('appendSessionJournalEntry', () => {
  it('creates the session-journals directory and writes a valid JSONL line', async () => {
    const entry = makeEntry({ eventType: 'session_start' });
    await appendSessionJournalEntry(tmpRoot, entry);

    const filePath = getSessionJournalPath(tmpRoot);
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content.trim()) as SessionJournalEntry;

    expect(parsed.schemaVersion).toBe('1.0');
    expect(parsed.sessionId).toBe('ses_test_001');
    expect(parsed.eventType).toBe('session_start');
  });

  it('appends multiple entries as separate lines', async () => {
    const entry1 = makeEntry({ sessionId: 'ses_001', eventType: 'session_start' });
    const entry2 = makeEntry({ sessionId: 'ses_001', eventType: 'session_end' });

    await appendSessionJournalEntry(tmpRoot, entry1);
    await appendSessionJournalEntry(tmpRoot, entry2);

    const filePath = getSessionJournalPath(tmpRoot);
    const content = await readFile(filePath, 'utf-8');
    const lines = content
      .trim()
      .split('\n')
      .filter((l) => l.trim().length > 0);

    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0]) as SessionJournalEntry).eventType).toBe('session_start');
    expect((JSON.parse(lines[1]) as SessionJournalEntry).eventType).toBe('session_end');
  });

  it('is idempotent about directory creation (mkdir recursive)', async () => {
    // Call twice — should not throw even though dir already exists after first call
    const entry = makeEntry();
    await appendSessionJournalEntry(tmpRoot, entry);
    await expect(appendSessionJournalEntry(tmpRoot, makeEntry())).resolves.not.toThrow();
  });
});

describe('readRecentJournals', () => {
  it('returns empty array when directory does not exist', async () => {
    const result = await readRecentJournals('/nonexistent/path/xyz');
    expect(result).toEqual([]);
  });

  it('reads entries from the most recent daily file', async () => {
    const entry = makeEntry({ sessionId: 'ses_recent', eventType: 'session_end' });
    await appendSessionJournalEntry(tmpRoot, entry);

    const result = await readRecentJournals(tmpRoot, 10);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]?.sessionId).toBe('ses_recent');
  });

  it('respects maxEntries limit', async () => {
    // Write 5 entries
    for (let i = 0; i < 5; i++) {
      await appendSessionJournalEntry(tmpRoot, makeEntry({ sessionId: `ses_${i}` }));
    }

    const result = await readRecentJournals(tmpRoot, 3);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it('skips malformed lines gracefully', async () => {
    const journalsDir = join(tmpRoot, '.cleo', 'session-journals');
    await mkdir(journalsDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const filePath = join(journalsDir, `${today}.jsonl`);

    await writeFile(
      filePath,
      ['NOT VALID JSON', JSON.stringify(makeEntry({ sessionId: 'ses_valid' })), ''].join('\n'),
      'utf-8',
    );

    const result = await readRecentJournals(tmpRoot, 10);
    expect(result.some((e) => e.sessionId === 'ses_valid')).toBe(true);
  });
});

describe('handleSessionEndJournal — hook integration', () => {
  it('writes a session_end entry with doctorSummary (clean brain)', async () => {
    mocks.scanBrainNoise.mockResolvedValue(cleanDoctorResult(42));

    // Import hook dynamically to use mocked dependencies
    const { handleSessionEndJournal } = await import('../../hooks/handlers/session-hooks.js');

    await handleSessionEndJournal(tmpRoot, {
      timestamp: new Date().toISOString(),
      sessionId: 'ses_hook_clean',
      duration: 300,
      tasksCompleted: ['T100', 'T101'],
    });

    const entries = await readRecentJournals(tmpRoot, 10);
    const hookEntry = entries.find((e) => e.sessionId === 'ses_hook_clean');
    expect(hookEntry).toBeDefined();
    expect(hookEntry?.eventType).toBe('session_end');
    expect(hookEntry?.duration).toBe(300);
    expect(hookEntry?.tasksCompleted).toEqual(['T100', 'T101']);
    expect(hookEntry?.doctorSummary?.isClean).toBe(true);
    expect(hookEntry?.doctorSummary?.totalScanned).toBe(42);
  });

  it('writes a session_end entry with doctorSummary (noisy brain)', async () => {
    mocks.scanBrainNoise.mockResolvedValue(noisyDoctorResult());

    const { handleSessionEndJournal } = await import('../../hooks/handlers/session-hooks.js');

    await handleSessionEndJournal(tmpRoot, {
      timestamp: new Date().toISOString(),
      sessionId: 'ses_hook_noisy',
      duration: 120,
      tasksCompleted: [],
    });

    const entries = await readRecentJournals(tmpRoot, 10);
    const hookEntry = entries.find((e) => e.sessionId === 'ses_hook_noisy');
    expect(hookEntry?.doctorSummary?.isClean).toBe(false);
    expect(hookEntry?.doctorSummary?.findingsCount).toBe(1);
    expect(hookEntry?.doctorSummary?.patterns).toContain('duplicate-content');
  });

  it('does not throw even when scanBrainNoise fails', async () => {
    mocks.scanBrainNoise.mockRejectedValue(new Error('brain.db not found'));

    const { handleSessionEndJournal } = await import('../../hooks/handlers/session-hooks.js');

    await expect(
      handleSessionEndJournal(tmpRoot, {
        timestamp: new Date().toISOString(),
        sessionId: 'ses_hook_err',
        duration: 0,
        tasksCompleted: [],
      }),
    ).resolves.not.toThrow();
  });
});

describe('rotateSessionJournals', () => {
  it('no-ops when the journals directory does not exist', async () => {
    await expect(rotateSessionJournals('/nonexistent/project/xyz')).resolves.not.toThrow();
  });

  it('leaves hot-tier files (≤7 days) untouched', async () => {
    // Write an entry to today's file
    const entry = makeEntry({ eventType: 'session_end' });
    await appendSessionJournalEntry(tmpRoot, entry);

    await rotateSessionJournals(tmpRoot, { hotDays: 7, warmDays: 30, archiveDays: 90 });

    const filePath = getSessionJournalPath(tmpRoot);
    const content = await readFile(filePath, 'utf-8');
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it('warm-tier rewrite keeps only session_end entries', async () => {
    const journalsDir = join(tmpRoot, '.cleo', 'session-journals');
    await mkdir(journalsDir, { recursive: true });

    // Write a "10-day-old" file by naming it 10 days ago
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const dateStr = tenDaysAgo.toISOString().slice(0, 10);
    const filePath = join(journalsDir, `${dateStr}.jsonl`);

    const startEntry = makeEntry({ eventType: 'session_start', sessionId: 'ses_start' });
    const endEntry = makeEntry({ eventType: 'session_end', sessionId: 'ses_end' });
    await writeFile(
      filePath,
      `${JSON.stringify(startEntry)}\n${JSON.stringify(endEntry)}\n`,
      'utf-8',
    );

    // hotDays=7 means 10-day-old file is warm (8-30d range)
    await rotateSessionJournals(tmpRoot, { hotDays: 7, warmDays: 30, archiveDays: 90 });

    const content = await readFile(filePath, 'utf-8');
    const lines = content
      .trim()
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]) as SessionJournalEntry).eventType).toBe('session_end');
  });

  it('archive-tier deletes files older than warmDays', async () => {
    const journalsDir = join(tmpRoot, '.cleo', 'session-journals');
    await mkdir(journalsDir, { recursive: true });

    // Write a "40-day-old" file (archive tier: 31-90d)
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const dateStr = fortyDaysAgo.toISOString().slice(0, 10);
    const filePath = join(journalsDir, `${dateStr}.jsonl`);
    await writeFile(filePath, `${JSON.stringify(makeEntry())}\n`, 'utf-8');

    await rotateSessionJournals(tmpRoot, { hotDays: 7, warmDays: 30, archiveDays: 90 });

    // File should be deleted
    const { existsSync } = await import('node:fs');
    expect(existsSync(filePath)).toBe(false);
  });

  it('purge-tier deletes files older than archiveDays', async () => {
    const journalsDir = join(tmpRoot, '.cleo', 'session-journals');
    await mkdir(journalsDir, { recursive: true });

    // Write a "100-day-old" file (purge tier: >90d)
    const hundredDaysAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const dateStr = hundredDaysAgo.toISOString().slice(0, 10);
    const filePath = join(journalsDir, `${dateStr}.jsonl`);
    await writeFile(filePath, `${JSON.stringify(makeEntry())}\n`, 'utf-8');

    await rotateSessionJournals(tmpRoot, { hotDays: 7, warmDays: 30, archiveDays: 90 });

    const { existsSync } = await import('node:fs');
    expect(existsSync(filePath)).toBe(false);
  });
});
