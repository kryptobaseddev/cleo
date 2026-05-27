/**
 * Tests for core/otel — OpenTelemetry token metrics module.
 *
 * All filesystem operations are mocked via vi.mock so no real files are
 * created or read. Tests cover:
 *   - readJsonlFile: missing file, empty file, valid JSONL, malformed lines
 *   - getOtelStatus: empty data + populated data
 *   - getOtelSummary: empty data + session/spawn breakdown
 *   - getOtelSessions: filter by session ID
 *   - getOtelSpawns: filter by task ID
 *   - getRealTokenUsage: otel disabled + session filter
 *   - clearOtelData: no file + file present (backup + clear)
 *
 * @task T1526
 * @epic T1520
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --------------------------------------------------------------------------
// Module mocks
// --------------------------------------------------------------------------

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    copyFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

import * as fs from 'node:fs';
import {
  clearOtelData,
  getOtelSessions,
  getOtelSpawns,
  getOtelStatus,
  getOtelSummary,
  getRealTokenUsage,
} from '../index.js';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

type FsMock = ReturnType<typeof vi.fn>;

function mockFileExists(exists: boolean): void {
  (fs.existsSync as unknown as FsMock).mockReturnValue(exists);
}

function mockFileContent(content: string): void {
  (fs.readFileSync as unknown as FsMock).mockReturnValue(content);
}

/** Build a JSONL string from an array of objects. */
function toJsonl(entries: Record<string, unknown>[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n');
}

/** Standard token entries for most tests. */
const SESSION_ENTRY = {
  event_type: 'session_start',
  task_id: 'T100',
  estimated_tokens: 1000,
  input_tokens: 600,
  output_tokens: 400,
  timestamp: '2026-04-28T10:00:00Z',
  context: { session_id: 'sess-abc' },
};

const SPAWN_ENTRY = {
  event_type: 'spawn',
  task_id: 'T100',
  estimated_tokens: 500,
  input_tokens: 300,
  output_tokens: 200,
  timestamp: '2026-04-28T10:01:00Z',
};

const MANIFEST_ENTRY = {
  event_type: 'manifest_read',
  task_id: 'T101',
  estimated_tokens: 200,
  timestamp: '2026-04-28T10:02:00Z',
};

// --------------------------------------------------------------------------
// Lifecycle
// --------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Default: token file exists with sample entries
  mockFileExists(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --------------------------------------------------------------------------
// readJsonlFile (via getOtelStatus)
// --------------------------------------------------------------------------

describe('readJsonlFile resilience', () => {
  it('returns empty when token file does not exist', async () => {
    mockFileExists(false);
    const status = await getOtelStatus();
    expect(status.events).toBe(0);
    expect(status.totalTokens).toBe(0);
  });

  it('returns empty when token file is empty', async () => {
    mockFileExists(true);
    mockFileContent('');
    const status = await getOtelStatus();
    expect(status.events).toBe(0);
  });

  it('returns empty when token file contains only whitespace', async () => {
    mockFileExists(true);
    mockFileContent('   \n  \n  ');
    const status = await getOtelStatus();
    expect(status.events).toBe(0);
  });

  it('parses valid JSONL entries', async () => {
    mockFileContent(toJsonl([SESSION_ENTRY, SPAWN_ENTRY]));
    const status = await getOtelStatus();
    expect(status.events).toBe(2);
    expect(status.totalTokens).toBe(1500);
  });

  it('skips malformed lines without throwing', async () => {
    const jsonl = [
      JSON.stringify(SESSION_ENTRY),
      'this is not valid json }{',
      JSON.stringify(SPAWN_ENTRY),
    ].join('\n');
    mockFileContent(jsonl);
    // Should not throw — should return the 2 valid entries
    const status = await getOtelStatus();
    expect(status.events).toBe(2);
    expect(status.totalTokens).toBe(1500);
  });

  it('skips blank lines interspersed with valid entries', async () => {
    const jsonl = [JSON.stringify(SESSION_ENTRY), '', JSON.stringify(SPAWN_ENTRY), ''].join('\n');
    mockFileContent(jsonl);
    const status = await getOtelStatus();
    expect(status.events).toBe(2);
  });
});

// --------------------------------------------------------------------------
// getOtelStatus
// --------------------------------------------------------------------------

describe('getOtelStatus', () => {
  it('returns zero counts for an empty file', async () => {
    mockFileExists(false);
    const result = await getOtelStatus();
    expect(result.events).toBe(0);
    expect(result.totalTokens).toBe(0);
    expect((result.breakdown as Record<string, number>).manifestReads).toBe(0);
    expect((result.breakdown as Record<string, number>).fullFileReads).toBe(0);
  });

  it('correctly aggregates manifest and full_file_read tokens', async () => {
    const fullFileEntry = {
      event_type: 'full_file_read',
      estimated_tokens: 300,
    };
    mockFileContent(toJsonl([MANIFEST_ENTRY, fullFileEntry, SESSION_ENTRY]));

    const result = await getOtelStatus();
    const breakdown = result.breakdown as Record<string, number>;
    expect(result.totalTokens).toBe(1500);
    expect(breakdown.manifestReads).toBe(200);
    expect(breakdown.fullFileReads).toBe(300);
    expect(breakdown.other).toBe(1000);
  });
});

// --------------------------------------------------------------------------
// getOtelSummary
// --------------------------------------------------------------------------

describe('getOtelSummary', () => {
  it('returns no-data message when file does not exist', async () => {
    mockFileExists(false);
    const result = await getOtelSummary();
    expect(result.message).toBe('No token tracking data yet');
    expect(result.events).toBe(0);
  });

  it('returns session and spawn breakdown', async () => {
    mockFileContent(toJsonl([SESSION_ENTRY, SPAWN_ENTRY, MANIFEST_ENTRY]));
    const result = await getOtelSummary();

    const sessions = result.sessions as { count: number; tokens: number };
    const spawns = result.spawns as { count: number; tokens: number };

    expect(result.totalEvents).toBe(3);
    expect(sessions.count).toBe(1);
    expect(sessions.tokens).toBe(1000);
    // spawns includes non-session entries (spawn + manifest_read)
    expect(spawns.count).toBe(2);
    expect(spawns.tokens).toBe(700);
  });
});

// --------------------------------------------------------------------------
// getOtelSessions
// --------------------------------------------------------------------------

describe('getOtelSessions', () => {
  beforeEach(() => {
    mockFileContent(
      toJsonl([
        SESSION_ENTRY,
        { ...SESSION_ENTRY, task_id: 'T200', context: { session_id: 'sess-xyz' } },
        SPAWN_ENTRY, // not a session — should be excluded
      ]),
    );
  });

  it('returns all session entries when no filter given', async () => {
    const result = await getOtelSessions({});
    expect(result.count).toBe(2);
  });

  it('filters by session ID', async () => {
    const result = await getOtelSessions({ session: 'sess-abc' });
    expect(result.count).toBe(1);
    const sessions = result.sessions as Record<string, unknown>[];
    expect((sessions[0]?.context as Record<string, unknown>)?.session_id).toBe('sess-abc');
  });

  it('filters by task ID', async () => {
    const result = await getOtelSessions({ task: 'T200' });
    expect(result.count).toBe(1);
  });

  it('returns empty when no sessions match filter', async () => {
    const result = await getOtelSessions({ session: 'sess-nonexistent' });
    expect(result.count).toBe(0);
  });
});

// --------------------------------------------------------------------------
// getOtelSpawns
// --------------------------------------------------------------------------

describe('getOtelSpawns', () => {
  beforeEach(() => {
    mockFileContent(
      toJsonl([
        SESSION_ENTRY, // excluded (session_start)
        SPAWN_ENTRY, // included
        { ...SPAWN_ENTRY, task_id: 'T200' }, // included with different task
        MANIFEST_ENTRY, // included (non-session)
      ]),
    );
  });

  it('returns all non-session entries when no filter given', async () => {
    const result = await getOtelSpawns({});
    expect(result.count).toBe(3);
  });

  it('filters spawns by task ID', async () => {
    const result = await getOtelSpawns({ task: 'T100' });
    expect(result.count).toBe(1);
  });

  it('returns empty when task has no spawns', async () => {
    const result = await getOtelSpawns({ task: 'T999' });
    expect(result.count).toBe(0);
  });
});

// --------------------------------------------------------------------------
// getRealTokenUsage
// --------------------------------------------------------------------------

describe('getRealTokenUsage', () => {
  it('returns no-data message when file is empty', async () => {
    mockFileExists(false);
    const result = await getRealTokenUsage({});
    expect(result.totalEvents).toBe(0);
    expect(typeof result.message).toBe('string');
  });

  it('aggregates tokens across all entries', async () => {
    mockFileContent(toJsonl([SESSION_ENTRY, SPAWN_ENTRY]));
    const result = await getRealTokenUsage({});
    expect(result.totalEvents).toBe(2);
    expect(result.totalTokens).toBe(1500);
    expect(result.inputTokens).toBe(900);
    expect(result.outputTokens).toBe(600);
  });

  it('filters by session ID', async () => {
    mockFileContent(
      toJsonl([
        SESSION_ENTRY, // context.session_id = 'sess-abc'
        SPAWN_ENTRY, // no context.session_id
      ]),
    );
    const result = await getRealTokenUsage({ session: 'sess-abc' });
    expect(result.totalEvents).toBe(1);
    expect(result.totalTokens).toBe(1000);
  });

  it('filters by since timestamp', async () => {
    mockFileContent(
      toJsonl([
        SESSION_ENTRY, // 10:00:00
        { ...SPAWN_ENTRY, timestamp: '2026-04-27T09:00:00Z' }, // earlier — excluded
      ]),
    );
    const result = await getRealTokenUsage({ since: '2026-04-28T00:00:00Z' });
    expect(result.totalEvents).toBe(1);
  });
});

// --------------------------------------------------------------------------
// clearOtelData
// --------------------------------------------------------------------------

describe('clearOtelData', () => {
  it('returns "no file to clear" when token file does not exist', async () => {
    mockFileExists(false);
    const result = await clearOtelData();
    expect(result.message).toBe('No token file to clear');
    expect(fs.copyFileSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('creates a backup and clears the file when it exists', async () => {
    mockFileExists(true);
    const result = await clearOtelData();

    expect(result.message).toBe('Token tracking cleared');
    expect(typeof result.backup).toBe('string');
    // Backup path should contain the original filename
    expect(result.backup as string).toContain('TOKEN_USAGE.jsonl');

    // copyFileSync should have been called with (source, backup)
    expect(fs.copyFileSync).toHaveBeenCalledTimes(1);
    // writeFileSync should have been called to clear the original file
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.stringContaining('TOKEN_USAGE.jsonl'), '');
  });
});
