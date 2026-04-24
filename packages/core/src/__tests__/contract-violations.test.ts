/**
 * appendContractViolation audit trail tests (T1261 PSYCHE E4).
 *
 * Validates that contract violations are written to
 * `.cleo/audit/contract-violations.jsonl` in the correct LAFS envelope
 * format (standalone JSON lines, append-only).
 *
 * @task T1261 PSYCHE E4
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContractViolationRecord } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendContractViolation, CONTRACT_VIOLATIONS_FILE } from '../audit.js';

describe('T1261-E4: appendContractViolation', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'contract-violations-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates the audit file and appends a valid JSON line', () => {
    appendContractViolation(tmpDir, {
      runId: 'run_test_001',
      nodeId: 'validate',
      field: 'requires',
      key: 'diff',
      message: 'requires.fields[diff] not present in context',
      playbookName: 'ivtr',
    });

    const content = readFileSync(join(tmpDir, CONTRACT_VIOLATIONS_FILE), 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]) as ContractViolationRecord;
    expect(record.runId).toBe('run_test_001');
    expect(record.nodeId).toBe('validate');
    expect(record.field).toBe('requires');
    expect(record.key).toBe('diff');
    expect(record.playbookName).toBe('ivtr');
    expect(typeof record.timestamp).toBe('string');
    // timestamp must be ISO-8601
    expect(() => new Date(record.timestamp).toISOString()).not.toThrow();
  });

  it('accepts an explicit timestamp', () => {
    const ts = '2026-04-24T10:00:00.000Z';
    appendContractViolation(tmpDir, {
      runId: 'run_002',
      nodeId: 'test',
      field: 'ensures',
      key: 'testReport',
      message: 'ensures check failed',
      playbookName: 'rcasd',
      timestamp: ts,
    });

    const content = readFileSync(join(tmpDir, CONTRACT_VIOLATIONS_FILE), 'utf8');
    const record = JSON.parse(content.trim()) as ContractViolationRecord;
    expect(record.timestamp).toBe(ts);
  });

  it('appends multiple records without overwriting', () => {
    for (let i = 0; i < 3; i++) {
      appendContractViolation(tmpDir, {
        runId: `run_${i}`,
        nodeId: 'node',
        field: 'requires',
        key: 'key',
        message: `violation ${i}`,
        playbookName: 'test',
      });
    }

    const content = readFileSync(join(tmpDir, CONTRACT_VIOLATIONS_FILE), 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);

    for (let i = 0; i < 3; i++) {
      const record = JSON.parse(lines[i]) as ContractViolationRecord;
      expect(record.runId).toBe(`run_${i}`);
      expect(record.message).toBe(`violation ${i}`);
    }
  });

  it('creates intermediate directories if missing', () => {
    // tmpDir/.cleo/audit/ doesn't exist yet — function must create it
    appendContractViolation(tmpDir, {
      runId: 'run_mkdir',
      nodeId: 'node',
      field: 'ensures',
      key: 'output',
      message: 'ensures check failed',
      playbookName: 'release',
    });

    const filePath = join(tmpDir, CONTRACT_VIOLATIONS_FILE);
    expect(() => readFileSync(filePath, 'utf8')).not.toThrow();
  });

  it('is non-fatal when projectRoot is undefined', () => {
    // Should not throw even with undefined projectRoot
    expect(() =>
      appendContractViolation(undefined as unknown as string, {
        runId: 'run_noop',
        nodeId: 'node',
        field: 'requires',
        key: 'key',
        message: 'noop',
        playbookName: 'test',
      }),
    ).not.toThrow();
  });
});
