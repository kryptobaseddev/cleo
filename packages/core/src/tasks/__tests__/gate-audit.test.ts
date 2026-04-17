/**
 * Unit tests for T832 / ADR-051 gate audit trail.
 *
 * Verifies append-only semantics, directory creation, and JSON-line format.
 *
 * @task T832
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendForceBypassLine,
  appendGateAuditLine,
  getForceBypassPath,
  getGateAuditPath,
} from '../gate-audit.js';

describe('gate-audit (T832)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gate-audit-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getGateAuditPath returns project-relative .cleo/audit/gates.jsonl', () => {
    const p = getGateAuditPath(tmpDir);
    expect(p).toBe(join(tmpDir, '.cleo', 'audit', 'gates.jsonl'));
  });

  it('getForceBypassPath returns project-relative .cleo/audit/force-bypass.jsonl', () => {
    const p = getForceBypassPath(tmpDir);
    expect(p).toBe(join(tmpDir, '.cleo', 'audit', 'force-bypass.jsonl'));
  });

  it('creates the audit directory on first write', async () => {
    await appendGateAuditLine(tmpDir, {
      timestamp: new Date().toISOString(),
      taskId: 'T001',
      gate: 'implemented',
      action: 'set',
      agent: 'test',
      sessionId: null,
      passed: true,
      override: false,
    });
    const content = await readFile(getGateAuditPath(tmpDir), 'utf-8');
    expect(content).toMatch(/"taskId":"T001"/);
  });

  it('appends one line per write (not overwrite)', async () => {
    const ts = new Date().toISOString();
    for (const id of ['T001', 'T002', 'T003']) {
      await appendGateAuditLine(tmpDir, {
        timestamp: ts,
        taskId: id,
        gate: 'implemented',
        action: 'set',
        agent: 'test',
        sessionId: null,
        passed: true,
        override: false,
      });
    }
    const content = await readFile(getGateAuditPath(tmpDir), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(3);
    lines.forEach((line) => {
      // Each line MUST parse as JSON.
      expect(() => JSON.parse(line)).not.toThrow();
    });
  });

  it('records single-line JSON (no pretty-printing)', async () => {
    await appendGateAuditLine(tmpDir, {
      timestamp: new Date().toISOString(),
      taskId: 'T001',
      gate: 'testsPassed',
      action: 'set',
      evidence: {
        atoms: [{ kind: 'note', note: 'tested manually' }],
        capturedAt: new Date().toISOString(),
        capturedBy: 'test',
      },
      agent: 'test',
      sessionId: 'ses_123',
      passed: true,
      override: false,
    });
    const content = await readFile(getGateAuditPath(tmpDir), 'utf-8');
    // There MUST be exactly one newline at the end.
    const lines = content.split('\n');
    expect(lines.filter((l) => l.length > 0)).toHaveLength(1);
  });

  it('appends force-bypass records with pid + command', async () => {
    await appendForceBypassLine(tmpDir, {
      timestamp: new Date().toISOString(),
      taskId: 'T001',
      gate: 'implemented',
      action: 'set',
      agent: 'owner',
      sessionId: 'ses_abc',
      passed: true,
      override: true,
      overrideReason: 'emergency deploy',
      pid: 12345,
      command: 'cleo verify T001 --gate implemented',
    });
    const content = await readFile(getForceBypassPath(tmpDir), 'utf-8');
    const record = JSON.parse(content.trim());
    expect(record.override).toBe(true);
    expect(record.overrideReason).toBe('emergency deploy');
    expect(record.pid).toBe(12345);
  });
});
