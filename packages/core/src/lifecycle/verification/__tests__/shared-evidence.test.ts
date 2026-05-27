/**
 * Tests for T1502 / P0-6 — --shared-evidence flag when same atom closes >3 tasks.
 *
 * Acceptance criteria (from task brief):
 *   1. 3 distinct atoms across 3 tasks: no warning
 *   2. 1 shared atom across 4 tasks without flag: warning logged + sharedAtomWarning:true
 *   3. 1 shared atom across 4 tasks with flag: silent + sharedEvidence:true
 *   4. Same conditions in strict mode: rejects without flag
 *
 * @task T1502
 * @adr ADR-059
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  atomKey,
  checkAndRecordSharedEvidence,
  enforceSharedEvidence,
  extractAtomKeys,
  getSharedEvidencePath,
  readAtomUsageMap,
  SHARED_EVIDENCE_THRESHOLD,
} from '../../../security/shared-evidence-tracker.js';

describe('shared-evidence-tracker (T1502 / P0-6)', () => {
  let tmpDir: string;
  const SESSION_ID = 'ses_test_shared_evidence';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shared-ev-'));
    delete process.env['CLEO_STRICT_EVIDENCE'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env['CLEO_STRICT_EVIDENCE'];
  });

  describe('SHARED_EVIDENCE_THRESHOLD', () => {
    it('is 3', () => {
      expect(SHARED_EVIDENCE_THRESHOLD).toBe(3);
    });
  });

  describe('atomKey', () => {
    it('lowercases and trims input', () => {
      expect(atomKey('  Commit:ABC123  ')).toBe('commit:abc123');
      expect(atomKey('TOOL:pnpm-test')).toBe('tool:pnpm-test');
    });
  });

  describe('extractAtomKeys', () => {
    it('splits on semicolons and returns canonical keys', () => {
      const keys = extractAtomKeys('commit:abc123;tool:pnpm-test;files:src/a.ts');
      expect(keys).toEqual(['commit:abc123', 'tool:pnpm-test', 'files:src/a.ts']);
    });

    it('ignores empty segments', () => {
      const keys = extractAtomKeys('commit:abc;;tool:x;');
      expect(keys).toEqual(['commit:abc', 'tool:x']);
    });
  });

  describe('readAtomUsageMap', () => {
    it('returns empty map when file absent', () => {
      const map = readAtomUsageMap(tmpDir, SESSION_ID);
      expect(map.size).toBe(0);
    });
  });

  describe('checkAndRecordSharedEvidence', () => {
    it('1. 3 distinct tasks with the same atom do NOT trigger check (threshold=3 means >3)', () => {
      // Apply atom to 3 tasks — threshold is 3, so we need >3 to trigger
      checkAndRecordSharedEvidence(tmpDir, SESSION_ID, 'T001', 'commit:abc123');
      checkAndRecordSharedEvidence(tmpDir, SESSION_ID, 'T002', 'commit:abc123');
      const result = checkAndRecordSharedEvidence(tmpDir, SESSION_ID, 'T003', 'commit:abc123');
      expect(result.triggered).toBe(false);
    });

    it('2. 4th task with the same atom DOES trigger check', () => {
      checkAndRecordSharedEvidence(tmpDir, SESSION_ID, 'T001', 'commit:abc123');
      checkAndRecordSharedEvidence(tmpDir, SESSION_ID, 'T002', 'commit:abc123');
      checkAndRecordSharedEvidence(tmpDir, SESSION_ID, 'T003', 'commit:abc123');
      const result = checkAndRecordSharedEvidence(tmpDir, SESSION_ID, 'T004', 'commit:abc123');
      expect(result.triggered).toBe(true);
      expect(result.triggeredAtoms).toContain('commit:abc123');
    });

    it('3. atoms from a different session are NOT counted', () => {
      checkAndRecordSharedEvidence(tmpDir, 'other-session', 'T001', 'commit:abc123');
      checkAndRecordSharedEvidence(tmpDir, 'other-session', 'T002', 'commit:abc123');
      checkAndRecordSharedEvidence(tmpDir, 'other-session', 'T003', 'commit:abc123');
      // Our session starts fresh
      const result = checkAndRecordSharedEvidence(tmpDir, SESSION_ID, 'T004', 'commit:abc123');
      expect(result.triggered).toBe(false);
    });

    it('4. entries are persisted to the rolling log file', () => {
      checkAndRecordSharedEvidence(tmpDir, SESSION_ID, 'T001', 'tool:pnpm-test');
      const map = readAtomUsageMap(tmpDir, SESSION_ID);
      expect(map.get('tool:pnpm-test')?.has('T001')).toBe(true);
    });
  });

  describe('enforceSharedEvidence', () => {
    it('5. no trigger → allowed without flags', () => {
      const result = enforceSharedEvidence(tmpDir, SESSION_ID, 'T001', 'commit:unique1', false);
      expect(result.allowed).toBe(true);
      expect(result.warned).toBeUndefined();
      expect(result.acknowledged).toBeUndefined();
    });

    it('6. trigger WITHOUT --shared-evidence in non-strict mode → warned + allowed', () => {
      checkAndRecordSharedEvidence(tmpDir, SESSION_ID, 'T001', 'commit:shared');
      checkAndRecordSharedEvidence(tmpDir, SESSION_ID, 'T002', 'commit:shared');
      checkAndRecordSharedEvidence(tmpDir, SESSION_ID, 'T003', 'commit:shared');

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const result = enforceSharedEvidence(tmpDir, SESSION_ID, 'T004', 'commit:shared', false);

      stderrSpy.mockRestore();

      expect(result.allowed).toBe(true);
      expect(result.warned).toBe(true);
      expect(result.acknowledged).toBeUndefined();
    });

    it('7. trigger WITH --shared-evidence → acknowledged + allowed silently', () => {
      checkAndRecordSharedEvidence(tmpDir, SESSION_ID, 'T001', 'commit:shared');
      checkAndRecordSharedEvidence(tmpDir, SESSION_ID, 'T002', 'commit:shared');
      checkAndRecordSharedEvidence(tmpDir, SESSION_ID, 'T003', 'commit:shared');

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const result = enforceSharedEvidence(tmpDir, SESSION_ID, 'T004', 'commit:shared', true);

      // No warning should have been written
      expect(stderrSpy).not.toHaveBeenCalled();
      stderrSpy.mockRestore();

      expect(result.allowed).toBe(true);
      expect(result.acknowledged).toBe(true);
      expect(result.warned).toBeUndefined();
    });

    it('8. trigger WITHOUT --shared-evidence in STRICT mode → hard reject', () => {
      process.env['CLEO_STRICT_EVIDENCE'] = '1';

      checkAndRecordSharedEvidence(tmpDir, SESSION_ID, 'T001', 'tool:pnpm-test');
      checkAndRecordSharedEvidence(tmpDir, SESSION_ID, 'T002', 'tool:pnpm-test');
      checkAndRecordSharedEvidence(tmpDir, SESSION_ID, 'T003', 'tool:pnpm-test');

      const result = enforceSharedEvidence(tmpDir, SESSION_ID, 'T004', 'tool:pnpm-test', false);

      expect(result.allowed).toBe(false);
      expect(result.errorCode).toBe('E_SHARED_EVIDENCE_FLAG_REQUIRED');
      expect(result.errorMessage).toContain('--shared-evidence');
    });

    it('9. trigger WITH --shared-evidence in STRICT mode → allowed (flag overrides strict)', () => {
      process.env['CLEO_STRICT_EVIDENCE'] = '1';

      checkAndRecordSharedEvidence(tmpDir, SESSION_ID, 'T001', 'tool:pnpm-test');
      checkAndRecordSharedEvidence(tmpDir, SESSION_ID, 'T002', 'tool:pnpm-test');
      checkAndRecordSharedEvidence(tmpDir, SESSION_ID, 'T003', 'tool:pnpm-test');

      const result = enforceSharedEvidence(tmpDir, SESSION_ID, 'T004', 'tool:pnpm-test', true);

      expect(result.allowed).toBe(true);
      expect(result.acknowledged).toBe(true);
    });
  });

  describe('getSharedEvidencePath', () => {
    it('returns project-relative .cleo/audit/shared-evidence-recent.jsonl', () => {
      const path = getSharedEvidencePath(tmpDir);
      expect(path).toBe(join(tmpDir, '.cleo', 'audit', 'shared-evidence-recent.jsonl'));
    });
  });
});
