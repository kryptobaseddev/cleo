/**
 * Tests for T1501 / P0-5 — per-session CLEO_OWNER_OVERRIDE cap with
 * waiver-doc requirement; and T1504 — cap default tuning + worktree-context
 * exemption.
 *
 * Acceptance criteria (from T1501 task brief):
 *   1. 10 overrides succeed, 11th rejects without waiver (cap raised 3→10 by T1504)
 *   2. 11th succeeds with valid waiver path
 *   3. 11th rejects with malformed/missing waiver file
 *
 * Acceptance criteria (from T1504 task brief):
 *   7. DEFAULT_OVERRIDE_CAP_PER_SESSION is 10
 *   8. Worktree-context call (command contains /worktrees/) does not increment cap counter
 *   9. Multiple worktree-context calls allowed without hitting cap
 *   10. Worktree exemption disabled when CLEO_OVERRIDE_EXEMPT_WORKTREE=0
 *
 * @task T1501
 * @task T1504
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
  isWorktreeContext,
  isWorktreeExemptionEnabled,
  readSessionOverrideCount,
  validateWaiverDoc,
  WORKTREE_PATH_SEGMENT,
} from '../../../security/override-cap.js';

describe('override-cap (T1501 / P0-5)', () => {
  let tmpDir: string;
  const SESSION_ID = 'ses_test_override_cap';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'override-cap-'));
    delete process.env['CLEO_OWNER_OVERRIDE_WAIVER'];
    delete process.env['CLEO_OVERRIDE_EXEMPT_WORKTREE'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env['CLEO_OWNER_OVERRIDE_WAIVER'];
    delete process.env['CLEO_OVERRIDE_EXEMPT_WORKTREE'];
  });

  describe('DEFAULT_OVERRIDE_CAP_PER_SESSION', () => {
    it('is 10 (raised from 3 by T1504)', () => {
      expect(DEFAULT_OVERRIDE_CAP_PER_SESSION).toBe(10);
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
    it('1. first 10 overrides succeed and return sequential ordinals (T1501 / T1504)', () => {
      for (let i = 1; i <= 10; i++) {
        const r = checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
        expect(r.allowed).toBe(true);
        expect(r.sessionOverrideOrdinal).toBe(i);
      }
    });

    it('2. 11th call is rejected without a waiver (cap raised 3→10 by T1504)', () => {
      // Use up 10 overrides
      for (let i = 0; i < 10; i++) {
        checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      }

      const r11 = checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      expect(r11.allowed).toBe(false);
      expect(r11.errorCode).toBe('E_OVERRIDE_CAP_EXCEEDED');
      expect(r11.errorMessage).toContain('cap exceeded');
    });

    it('3. 11th call succeeds with a valid waiver file', () => {
      // Use up 10 overrides
      for (let i = 0; i < 10; i++) {
        checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      }

      // Create a valid waiver file
      const waiverPath = join(tmpDir, 'cap-waiver.md');
      writeFileSync(
        waiverPath,
        '---\ncap-waiver: true\nrationale: Emergency incident override approval\n---\n',
        'utf-8',
      );
      process.env['CLEO_OWNER_OVERRIDE_WAIVER'] = waiverPath;

      const r11 = checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      expect(r11.allowed).toBe(true);
      expect(r11.sessionOverrideOrdinal).toBe(11);
    });

    it('4. 11th call is rejected when waiver file does not exist', () => {
      for (let i = 0; i < 10; i++) {
        checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      }

      process.env['CLEO_OWNER_OVERRIDE_WAIVER'] = join(tmpDir, 'nonexistent-waiver.md');

      const r11 = checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      expect(r11.allowed).toBe(false);
      expect(r11.errorCode).toBe('E_OVERRIDE_CAP_EXCEEDED');
      expect(r11.errorMessage).toContain('Waiver rejected');
      expect(r11.errorMessage).toContain('not found');
    });

    it('5. 11th call is rejected when waiver file is missing cap-waiver: true', () => {
      for (let i = 0; i < 10; i++) {
        checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      }

      const waiverPath = join(tmpDir, 'bad-waiver.md');
      writeFileSync(
        waiverPath,
        '# No marker here\nrationale: missing the required line\n',
        'utf-8',
      );
      process.env['CLEO_OWNER_OVERRIDE_WAIVER'] = waiverPath;

      const r11 = checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      expect(r11.allowed).toBe(false);
      expect(r11.errorCode).toBe('E_OVERRIDE_CAP_EXCEEDED');
      expect(r11.errorMessage).toContain('cap-waiver: true');
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

      // 4th–10th calls still succeed (cap is 10 now)
      for (let i = 4; i <= 10; i++) {
        const r = checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
        expect(r.allowed).toBe(true);
      }

      // 11th call fails
      const r11 = checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      expect(r11.allowed).toBe(false);
    });

    // T1504 — worktree-context exemption tests

    it('7. worktree-context call is allowed and does not increment the cap counter (T1504)', () => {
      const worktreeCmd = '/home/user/.local/share/cleo/worktrees/abc123/T1234/cleo.js verify T1234';
      // Use up 10 overrides first
      for (let i = 0; i < 10; i++) {
        checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      }

      // 11th call would normally fail, but this has a worktree command — should pass
      const r = checkAndIncrementOverrideCap(tmpDir, SESSION_ID, undefined, worktreeCmd);
      expect(r.allowed).toBe(true);
      expect(r.workTreeContext).toBe(true);

      // Counter should NOT have been incremented (still at 10)
      const countAfter = readSessionOverrideCount(tmpDir, SESSION_ID);
      expect(countAfter).toBe(10);
    });

    it('8. multiple worktree-context calls succeed without consuming cap budget (T1504)', () => {
      const worktreeCmd =
        '/home/user/.local/share/cleo/worktrees/proj_hash/T5555/node_modules/.bin/cleo';
      // Use up 9 overrides (1 under cap)
      for (let i = 0; i < 9; i++) {
        checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      }

      // 10 worktree-context calls should all succeed without touching the counter
      for (let i = 0; i < 10; i++) {
        const r = checkAndIncrementOverrideCap(tmpDir, SESSION_ID, undefined, worktreeCmd);
        expect(r.allowed).toBe(true);
        expect(r.workTreeContext).toBe(true);
      }

      // The 10th non-worktree call should still succeed (counter at 9)
      const rNormal = checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      expect(rNormal.allowed).toBe(true);
      expect(rNormal.sessionOverrideOrdinal).toBe(10);

      // 11th non-worktree call should now fail
      const rOver = checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      expect(rOver.allowed).toBe(false);
    });

    it('9. worktree exemption is disabled when CLEO_OVERRIDE_EXEMPT_WORKTREE=0 (T1504)', () => {
      process.env['CLEO_OVERRIDE_EXEMPT_WORKTREE'] = '0';
      const worktreeCmd = '/home/user/.local/share/cleo/worktrees/abc/T1/cleo.js';
      // Use up 10 overrides
      for (let i = 0; i < 10; i++) {
        checkAndIncrementOverrideCap(tmpDir, SESSION_ID);
      }

      // 11th call with worktree command — exemption disabled, should fail
      const r = checkAndIncrementOverrideCap(tmpDir, SESSION_ID, undefined, worktreeCmd);
      expect(r.allowed).toBe(false);
      expect(r.errorCode).toBe('E_OVERRIDE_CAP_EXCEEDED');
    });

    it('10. non-worktree command is not marked as worktree context (T1504)', () => {
      const normalCmd = '/home/user/.npm-global/lib/node_modules/@cleocode/cleo/dist/cli/index.js';
      const r = checkAndIncrementOverrideCap(tmpDir, SESSION_ID, undefined, normalCmd);
      expect(r.allowed).toBe(true);
      expect(r.workTreeContext).toBeUndefined();
    });
  });

  describe('isWorktreeContext (T1504)', () => {
    it('returns true for command containing /worktrees/ path', () => {
      expect(
        isWorktreeContext(
          '/home/user/.local/share/cleo/worktrees/abc123/T1234/cleo.js verify T1234',
        ),
      ).toBe(true);
    });

    it('returns false for normal cleo command', () => {
      expect(
        isWorktreeContext(
          '/home/user/.npm-global/lib/node_modules/@cleocode/cleo/dist/cli/index.js verify T1234',
        ),
      ).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isWorktreeContext('')).toBe(false);
    });

    it('WORKTREE_PATH_SEGMENT is /worktrees/', () => {
      expect(WORKTREE_PATH_SEGMENT).toBe('/worktrees/');
    });
  });

  describe('isWorktreeExemptionEnabled (T1504)', () => {
    it('returns true by default (env not set)', () => {
      delete process.env['CLEO_OVERRIDE_EXEMPT_WORKTREE'];
      expect(isWorktreeExemptionEnabled()).toBe(true);
    });

    it('returns true when set to "1"', () => {
      process.env['CLEO_OVERRIDE_EXEMPT_WORKTREE'] = '1';
      expect(isWorktreeExemptionEnabled()).toBe(true);
    });

    it('returns false when set to "0"', () => {
      process.env['CLEO_OVERRIDE_EXEMPT_WORKTREE'] = '0';
      expect(isWorktreeExemptionEnabled()).toBe(false);
    });

    it('returns false when set to "false"', () => {
      process.env['CLEO_OVERRIDE_EXEMPT_WORKTREE'] = 'false';
      expect(isWorktreeExemptionEnabled()).toBe(false);
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
