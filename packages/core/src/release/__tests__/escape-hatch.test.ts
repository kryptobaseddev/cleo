/**
 * Unit tests for {@link appendReleaseWorkflowBypass} — T9538 audit logger.
 *
 * Verifies SPEC-T9345 §12.3 / R-441:
 *   1. A record is appended to `.cleo/audit/release-workflow-bypass.jsonl`.
 *   2. The record carries severity='critical', the version, the operator, the
 *      reason, and the timestamp.
 *   3. Multiple invocations append multiple JSONL lines (no truncation).
 *   4. The parent directory is created on demand (.cleo/audit/ may not exist
 *      yet on fresh projects).
 *   5. Filesystem errors do NOT throw (best-effort audit per R-441).
 *
 * @task T9538
 * @epic T9498
 * @spec SPEC-T9345 §12.3 / R-441
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendReleaseWorkflowBypass,
  RELEASE_WORKFLOW_BYPASS_FILE,
  type ReleaseWorkflowBypassRecord,
} from '../escape-hatch.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let projectRoot: string;

beforeEach(() => {
  projectRoot = join(
    tmpdir(),
    `cleo-escape-hatch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  if (projectRoot && existsSync(projectRoot)) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

/** Read all JSONL lines from the audit file and parse each one. */
function readAuditRecords(): ReleaseWorkflowBypassRecord[] {
  const path = join(projectRoot, RELEASE_WORKFLOW_BYPASS_FILE);
  if (!existsSync(path)) return [];
  const body = readFileSync(path, 'utf-8');
  return body
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ReleaseWorkflowBypassRecord);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('appendReleaseWorkflowBypass — T9538', () => {
  it('creates .cleo/audit/release-workflow-bypass.jsonl and appends one record', () => {
    appendReleaseWorkflowBypass({
      projectRoot,
      version: '2026.6.0',
      reason: 'gha is down',
      operator: 'kryptokeaton',
      epicId: 'T9498',
    });

    const records = readAuditRecords();
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record).toMatchObject({
      version: '2026.6.0',
      operator: 'kryptokeaton',
      severity: 'critical',
      reason: 'gha is down',
      epicId: 'T9498',
      source: 'cli-flag',
    });
    expect(record?.timestamp).toEqual(expect.any(String));
    expect(new Date(record?.timestamp ?? '').toString()).not.toBe('Invalid Date');
  });

  it('appends additional records on subsequent calls (no truncation)', () => {
    appendReleaseWorkflowBypass({
      projectRoot,
      version: '2026.6.0',
      reason: 'first',
    });
    appendReleaseWorkflowBypass({
      projectRoot,
      version: '2026.6.1',
      reason: 'second',
    });
    appendReleaseWorkflowBypass({
      projectRoot,
      version: '2026.6.2',
      reason: 'third',
    });

    const records = readAuditRecords();
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.reason)).toEqual(['first', 'second', 'third']);
    expect(records.every((r) => r.severity === 'critical')).toBe(true);
  });

  it('uses process.env.USER when operator is not supplied', () => {
    const previous = process.env.USER;
    process.env.USER = 'env-user';
    try {
      appendReleaseWorkflowBypass({
        projectRoot,
        version: '2026.6.0',
        reason: 'env-test',
      });
      const records = readAuditRecords();
      expect(records[0]?.operator).toBe('env-user');
    } finally {
      if (previous === undefined) delete process.env.USER;
      else process.env.USER = previous;
    }
  });

  it('falls back to "unknown" when process.env.USER is absent', () => {
    const previous = process.env.USER;
    delete process.env.USER;
    try {
      appendReleaseWorkflowBypass({
        projectRoot,
        version: '2026.6.0',
        reason: 'no-user',
      });
      const records = readAuditRecords();
      expect(records[0]?.operator).toBe('unknown');
    } finally {
      if (previous !== undefined) process.env.USER = previous;
    }
  });

  it('honours an explicit timestamp override', () => {
    const fixed = '2026-05-18T12:00:00.000Z';
    appendReleaseWorkflowBypass({
      projectRoot,
      version: '2026.6.0',
      reason: 'fixed-ts',
      timestamp: fixed,
    });
    const records = readAuditRecords();
    expect(records[0]?.timestamp).toBe(fixed);
  });

  it('does not throw when the project root path is not writable', () => {
    // Pointing at a clearly invalid path. The helper MUST swallow the error
    // per R-441 (best-effort audit must never block the operation).
    expect(() => {
      appendReleaseWorkflowBypass({
        projectRoot: '/nonexistent/forbidden/path/should-not-be-writable',
        version: '2026.6.0',
        reason: 'fs-fail',
      });
    }).not.toThrow();
  });
});
