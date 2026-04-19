/**
 * Unit tests for the audit log append + read helpers.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readAuditLog, recordAudit, resolveAuditLogPath } from '../audit-log.js';

let projectPath = '';

beforeEach(() => {
  projectPath = mkdtempSync(join(tmpdir(), 'cleo-audit-'));
});

describe('resolveAuditLogPath', () => {
  it('lives under .cleo/audit/studio-actions.jsonl', () => {
    const p = resolveAuditLogPath('/foo/bar');
    expect(p).toBe('/foo/bar/.cleo/audit/studio-actions.jsonl');
  });
});

describe('recordAudit + readAuditLog round-trip', () => {
  it('returns [] when the file does not exist', () => {
    expect(readAuditLog(projectPath)).toEqual([]);
  });

  it('appends entries in newest-first order on read', () => {
    recordAudit(projectPath, {
      actor: 'studio-admin',
      action: 'project.scan',
      target: null,
      result: 'success',
    });
    recordAudit(projectPath, {
      actor: 'studio-admin',
      action: 'project.delete',
      target: 'proj-x',
      result: 'failure',
      detail: 'oops',
    });

    const entries = readAuditLog(projectPath);
    expect(entries).toHaveLength(2);
    // newest first
    expect(entries[0]?.action).toBe('project.delete');
    expect(entries[0]?.detail).toBe('oops');
    expect(entries[1]?.action).toBe('project.scan');
    expect(entries[0]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    rmSync(projectPath, { recursive: true, force: true });
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      recordAudit(projectPath, {
        actor: 'studio-admin',
        action: `action-${i}`,
        target: null,
        result: 'success',
      });
    }
    const entries = readAuditLog(projectPath, 3);
    expect(entries).toHaveLength(3);

    rmSync(projectPath, { recursive: true, force: true });
  });

  it('never throws on filesystem failure', () => {
    expect(() =>
      recordAudit('/definitely/not/a/writable/path/at/all', {
        actor: 'studio-admin',
        action: 'project.scan',
        target: null,
        result: 'success',
      }),
    ).not.toThrow();
  });
});
