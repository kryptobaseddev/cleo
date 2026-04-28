/**
 * Tests for T1501 / P0-5 — per-session CLEO_OWNER_OVERRIDE cap with
 * waiver-doc requirement.
 *
 * Acceptance criteria (from task brief):
 *   1. 3 overrides succeed, 4th rejects without waiver
 *   2. 4th succeeds with valid waiver path
 *   3. 4th rejects with malformed/missing waiver file
 *
 * @task T1501
 * @adr ADR-059
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkAndIncrementOverrideCap,
  DEFAULT_OVERRIDE_CAP_PER_SESSION,
  getSessionOverrideCountPath,
  readSessionOverrideCount,
  validateWaiverDoc,
} from '../../../security/override-cap.js';

describe('override-cap (T1501 / P0-5)', () => {
  let tmpDir: string;
  const SESSION_ID = 'ses_test_override_cap';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'override-cap-'));
    delete process.env['CLEO_OWNER_OVERRIDE_WAIVER'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env['CLEO_OWNER_OVERRIDE_WAIVER'];
  });

  describe('DEFAULT_OVERRIDE_CAP_PER_SESSION', () => {
    it('is 3', () => {
      expect(DEFAULT_OVERRIDE_CAP_PER_SESSION).toBe(3);
    });
  });

  describe('readSessionOverrideCount', () => {
    it('returns 0 when no count file exists', () => {
      const count = readSessionOverrideCount(tmpDir, SESSION_ID);
      expect(count).toBe(0);
    });

    it('returns 0 for a malformed count file', () => {
      const path = getSessionOverrideCountPath(tmpDir, SESSION_ID);
      // Create audit dir
      const { mkdirSync } = require('node:fs');
      mkdirSync(require('node:path').dirname(path), { recursive: true });
      writeFileSync(path, 'not json', 'utf-8');
      const count = readSessionOverrideCount(tmpDir, SESSION_ID);
      expect(count).toBe(0);
    });
  });

  describe('checkAndIncrementOverrideCap', () => {
    it('1. first 3 overrides succeed and return sequential ordinals', () => {
      const r1 = checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      expect(r1.allowed).toBe(true);
      expect(r1.sessionOverrideOrdinal).toBe(1);

      const r2 = checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      expect(r2.allowed).toBe(true);
      expect(r2.sessionOverrideOrdinal).toBe(2);

      const r3 = checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      expect(r3.allowed).toBe(true);
      expect(r3.sessionOverrideOrdinal).toBe(3);
    });

    it('2. 4th call is rejected without a waiver (no CLEO_OWNER_OVERRIDE_WAIVER set)', () => {
      // Use up 3 overrides
      checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      checkAndIncrementOverrideCap(tmpDir, SESSION_ID);

      const r4 = checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      expect(r4.allowed).toBe(false);
      expect(r4.errorCode).toBe('E_OVERRIDE_CAP_EXCEEDED');
      expect(r4.errorMessage).toContain('cap exceeded');
    });

    it('3. 4th call succeeds with a valid waiver file', () => {
      // Use up 3 overrides
      checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      checkAndIncrementOverrideCap(tmpDir, SESSION_ID);

      // Create a valid waiver file
      const waiverPath = join(tmpDir, 'cap-waiver.md');
      writeFileSync(
        waiverPath,
        '---\ncap-waiver: true\nrationale: Emergency incident override approval\n---\n',
        'utf-8',
      );
      process.env['CLEO_OWNER_OVERRIDE_WAIVER'] = waiverPath;

      const r4 = checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      expect(r4.allowed).toBe(true);
      expect(r4.sessionOverrideOrdinal).toBe(4);
    });

    it('4. 4th call is rejected when waiver file does not exist', () => {
      checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      checkAndIncrementOverrideCap(tmpDir, SESSION_ID);

      process.env['CLEO_OWNER_OVERRIDE_WAIVER'] = join(tmpDir, 'nonexistent-waiver.md');

      const r4 = checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      expect(r4.allowed).toBe(false);
      expect(r4.errorCode).toBe('E_OVERRIDE_CAP_EXCEEDED');
      expect(r4.errorMessage).toContain('Waiver rejected');
      expect(r4.errorMessage).toContain('not found');
    });

    it('5. 4th call is rejected when waiver file is missing cap-waiver: true', () => {
      checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      checkAndIncrementOverrideCap(tmpDir, SESSION_ID);

      const waiverPath = join(tmpDir, 'bad-waiver.md');
      writeFileSync(
        waiverPath,
        '# No marker here\nrationale: missing the required line\n',
        'utf-8',
      );
      process.env['CLEO_OWNER_OVERRIDE_WAIVER'] = waiverPath;

      const r4 = checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      expect(r4.allowed).toBe(false);
      expect(r4.errorCode).toBe('E_OVERRIDE_CAP_EXCEEDED');
      expect(r4.errorMessage).toContain('cap-waiver: true');
    });

    it('6. count persists across separate calls (simulating separate CLI invocations)', () => {
      checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      checkAndIncrementOverrideCap(tmpDir, SESSION_ID);

      // Re-read count from disk — simulates a new process reading the persisted state
      const count = readSessionOverrideCount(tmpDir, SESSION_ID);
      expect(count).toBe(2);

      // Third call succeeds
      const r3 = checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      expect(r3.allowed).toBe(true);
      expect(r3.sessionOverrideOrdinal).toBe(3);

      // Fourth call fails
      const r4 = checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      expect(r4.allowed).toBe(false);
    });
  });

  describe('validateWaiverDoc', () => {
    it('rejects empty path', () => {
      const result = validateWaiverDoc('');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('empty');
    });

    it('rejects nonexistent file', () => {
      const result = validateWaiverDoc(join(tmpDir, 'missing.md'));
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('not found');
    });

    it('rejects file without cap-waiver: true', () => {
      const path = join(tmpDir, 'no-marker.md');
      writeFileSync(path, '# Just a doc\nNo marker here.\n', 'utf-8');
      const result = validateWaiverDoc(path);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('cap-waiver: true');
    });

    it('accepts file containing cap-waiver: true in body', () => {
      const path = join(tmpDir, 'valid.md');
      writeFileSync(path, 'cap-waiver: true\nrationale: approved by owner\n', 'utf-8');
      const result = validateWaiverDoc(path);
      expect(result.valid).toBe(true);
    });

    it('accepts file with cap-waiver: true in YAML front-matter', () => {
      const path = join(tmpDir, 'yaml-frontmatter.md');
      writeFileSync(path, '---\ncap-waiver: true\n---\n# Waiver doc\n', 'utf-8');
      const result = validateWaiverDoc(path);
      expect(result.valid).toBe(true);
    });
  });
});
