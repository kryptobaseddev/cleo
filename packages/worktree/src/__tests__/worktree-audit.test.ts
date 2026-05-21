/**
 * Unit tests for the worktree lifecycle audit-log helper (T9805 AC3).
 *
 * Verifies that:
 *  - `appendWorktreeAuditLog` writes valid JSONL to the designated file.
 *  - Multiple calls append separate lines (no overwrite, no JSON array).
 *  - The auto-filled `ts` field is a valid ISO-8601 string.
 *  - The sentinel-index helpers add and remove entries correctly.
 *  - `auditLogPathOverride` / `indexPathOverride` let tests redirect I/O.
 *
 * @task T9805
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addWorktreeToSentinelIndex,
  appendWorktreeAuditLog,
  removeWorktreeFromSentinelIndex,
  resolveWorktreeIndexPath,
  WORKTREE_INDEX_RELATIVE_PATH,
  WORKTREE_LIFECYCLE_AUDIT_FILE,
} from '../worktree-audit.js';

/** Scratch directory created fresh for each test. */
let tmpDir: string;
let auditLogPath: string;
let indexPath: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `wt-audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  auditLogPath = join(tmpDir, 'worktree-lifecycle.jsonl');
  indexPath = join(tmpDir, 'worktrees.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveWorktreeIndexPath
// ---------------------------------------------------------------------------

describe('resolveWorktreeIndexPath', () => {
  it('returns <gitRoot>/<WORKTREE_INDEX_RELATIVE_PATH>', () => {
    const gitRoot = '/some/project';
    expect(resolveWorktreeIndexPath(gitRoot)).toBe(join(gitRoot, WORKTREE_INDEX_RELATIVE_PATH));
  });
});

// ---------------------------------------------------------------------------
// appendWorktreeAuditLog
// ---------------------------------------------------------------------------

describe('appendWorktreeAuditLog', () => {
  it('creates the file and writes a JSONL record on first call', () => {
    appendWorktreeAuditLog(
      tmpDir,
      {
        action: 'create',
        xdgPath: '/xdg/T9805',
        taskId: 'T9805',
        branch: 'task/T9805',
        reason: 'spawn',
        success: true,
      },
      auditLogPath,
    );

    expect(existsSync(auditLogPath)).toBe(true);
    const lines = readFileSync(auditLogPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(record['action']).toBe('create');
    expect(record['xdgPath']).toBe('/xdg/T9805');
    expect(record['taskId']).toBe('T9805');
    expect(record['branch']).toBe('task/T9805');
    expect(record['reason']).toBe('spawn');
    expect(record['success']).toBe(true);
    expect(typeof record['ts']).toBe('string');
    // ts must be a valid ISO-8601 date
    expect(() => new Date(record['ts'] as string).toISOString()).not.toThrow();
  });

  it('appends a second line on subsequent calls (no overwrite)', () => {
    appendWorktreeAuditLog(
      tmpDir,
      { action: 'create', xdgPath: '/wt/T0001', success: true },
      auditLogPath,
    );
    appendWorktreeAuditLog(
      tmpDir,
      { action: 'destroy', xdgPath: '/wt/T0001', reason: 'manual', success: true },
      auditLogPath,
    );

    const lines = readFileSync(auditLogPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])['action']).toBe('create');
    expect(JSON.parse(lines[1])['action']).toBe('destroy');
  });

  it('omits optional fields when not provided', () => {
    appendWorktreeAuditLog(
      tmpDir,
      { action: 'prune', xdgPath: '/wt/T0002', success: true },
      auditLogPath,
    );
    const record = JSON.parse(readFileSync(auditLogPath, 'utf-8').trim()) as Record<
      string,
      unknown
    >;
    expect('taskId' in record).toBe(false);
    expect('branch' in record).toBe(false);
    expect('reason' in record).toBe(false);
    expect('error' in record).toBe(false);
  });

  it('includes error field when success is false', () => {
    appendWorktreeAuditLog(
      tmpDir,
      {
        action: 'destroy',
        xdgPath: '/wt/T0003',
        success: false,
        error: 'Permission denied',
      },
      auditLogPath,
    );
    const record = JSON.parse(readFileSync(auditLogPath, 'utf-8').trim()) as Record<
      string,
      unknown
    >;
    expect(record['success']).toBe(false);
    expect(record['error']).toBe('Permission denied');
  });

  it('uses CLEO_AGENT_ID env var as agentId when set', () => {
    const originalEnv = process.env['CLEO_AGENT_ID'];
    process.env['CLEO_AGENT_ID'] = 'test-agent-42';
    try {
      appendWorktreeAuditLog(
        tmpDir,
        { action: 'prune', xdgPath: '/wt/T0004', success: true },
        auditLogPath,
      );
      const record = JSON.parse(readFileSync(auditLogPath, 'utf-8').trim()) as Record<
        string,
        unknown
      >;
      expect(record['agentId']).toBe('test-agent-42');
    } finally {
      if (originalEnv === undefined) {
        delete process.env['CLEO_AGENT_ID'];
      } else {
        process.env['CLEO_AGENT_ID'] = originalEnv;
      }
    }
  });

  it('falls back to "cleo" agentId when CLEO_AGENT_ID is unset', () => {
    const originalEnv = process.env['CLEO_AGENT_ID'];
    delete process.env['CLEO_AGENT_ID'];
    try {
      appendWorktreeAuditLog(
        tmpDir,
        { action: 'adopt', xdgPath: '/wt/T0005', success: true },
        auditLogPath,
      );
      const record = JSON.parse(readFileSync(auditLogPath, 'utf-8').trim()) as Record<
        string,
        unknown
      >;
      expect(record['agentId']).toBe('cleo');
    } finally {
      if (originalEnv !== undefined) {
        process.env['CLEO_AGENT_ID'] = originalEnv;
      }
    }
  });

  it('creates the audit directory when it does not exist', () => {
    const nestedPath = join(tmpDir, 'deeply', 'nested', 'audit.jsonl');
    appendWorktreeAuditLog(
      tmpDir,
      { action: 'create', xdgPath: '/wt/T0006', success: true },
      nestedPath,
    );
    expect(existsSync(nestedPath)).toBe(true);
  });

  it('uses canonical path relative to projectRoot when no override is given', () => {
    appendWorktreeAuditLog(tmpDir, {
      action: 'create',
      xdgPath: '/wt/T0007',
      success: true,
    });
    const canonicalPath = join(tmpDir, WORKTREE_LIFECYCLE_AUDIT_FILE);
    expect(existsSync(canonicalPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sentinel index helpers
// ---------------------------------------------------------------------------

describe('addWorktreeToSentinelIndex', () => {
  it('creates the index file with the given entry', () => {
    addWorktreeToSentinelIndex(
      tmpDir,
      'T9805',
      { path: '/xdg/T9805', branch: 'task/T9805', createdAt: '2026-05-21T00:00:00.000Z' },
      indexPath,
    );

    expect(existsSync(indexPath)).toBe(true);
    const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as Record<string, unknown>;
    expect(index['T9805']).toBeDefined();
    expect((index['T9805'] as Record<string, string>)['branch']).toBe('task/T9805');
  });

  it('preserves existing entries when adding a new one', () => {
    addWorktreeToSentinelIndex(
      tmpDir,
      'T0001',
      { path: '/xdg/T0001', branch: 'task/T0001', createdAt: '2026-01-01T00:00:00.000Z' },
      indexPath,
    );
    addWorktreeToSentinelIndex(
      tmpDir,
      'T0002',
      { path: '/xdg/T0002', branch: 'task/T0002', createdAt: '2026-01-02T00:00:00.000Z' },
      indexPath,
    );

    const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as Record<string, unknown>;
    expect(Object.keys(index)).toHaveLength(2);
    expect(index['T0001']).toBeDefined();
    expect(index['T0002']).toBeDefined();
  });
});

describe('removeWorktreeFromSentinelIndex', () => {
  it('removes the entry from an existing index', () => {
    addWorktreeToSentinelIndex(
      tmpDir,
      'T9805',
      { path: '/xdg/T9805', branch: 'task/T9805', createdAt: '2026-05-21T00:00:00.000Z' },
      indexPath,
    );
    addWorktreeToSentinelIndex(
      tmpDir,
      'T9806',
      { path: '/xdg/T9806', branch: 'task/T9806', createdAt: '2026-05-21T00:00:00.000Z' },
      indexPath,
    );

    removeWorktreeFromSentinelIndex(tmpDir, 'T9805', indexPath);

    const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as Record<string, unknown>;
    expect(Object.keys(index)).toHaveLength(1);
    expect('T9805' in index).toBe(false);
    expect('T9806' in index).toBe(true);
  });

  it('is a no-op when the entry does not exist in the index', () => {
    addWorktreeToSentinelIndex(
      tmpDir,
      'T9806',
      { path: '/xdg/T9806', branch: 'task/T9806', createdAt: '2026-05-21T00:00:00.000Z' },
      indexPath,
    );
    // Should not throw even though T9999 was never added.
    expect(() => removeWorktreeFromSentinelIndex(tmpDir, 'T9999', indexPath)).not.toThrow();

    const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as Record<string, unknown>;
    expect(Object.keys(index)).toHaveLength(1);
  });

  it('is a no-op when the index file does not exist', () => {
    expect(() => removeWorktreeFromSentinelIndex(tmpDir, 'T9999', indexPath)).not.toThrow();
  });
});
