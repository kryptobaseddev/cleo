import { describe, expect, it, vi } from 'vitest';
import {
  enforceNodeVersion,
  evaluateNodeVersion,
  FALLBACK_MIN_NODE,
  getRequiredNodeVersion,
  parseSemver,
} from '../node-version-gate.js';

describe('node-version-gate', () => {
  describe('parseSemver', () => {
    it('parses x.y.z, v-prefix, and >= ranges', () => {
      expect(parseSemver('24.16.0')).toEqual({ major: 24, minor: 16, patch: 0 });
      expect(parseSemver('v24.16.0')).toEqual({ major: 24, minor: 16, patch: 0 });
      expect(parseSemver('>=24.16.0 <27')).toEqual({ major: 24, minor: 16, patch: 0 });
    });

    it('returns null for unparseable input', () => {
      expect(parseSemver('latest')).toBeNull();
      expect(parseSemver('')).toBeNull();
    });
  });

  describe('getRequiredNodeVersion (SSoT from engines.node)', () => {
    it('reads a parseable triple from the package manifest', () => {
      const required = getRequiredNodeVersion();
      expect(required).toMatch(/^\d+\.\d+\.\d+$/);
      expect(parseSemver(required)).not.toBeNull();
    });

    it('FALLBACK_MIN_NODE is itself a valid triple', () => {
      expect(parseSemver(FALLBACK_MIN_NODE)).not.toBeNull();
    });
  });

  describe('evaluateNodeVersion', () => {
    const required = getRequiredNodeVersion();
    const req = parseSemver(required)!;

    it('flags the 24.13.1 hole as non-compliant (the bug this gate closes)', () => {
      // 24.13.1 has major 24 — the old major-only guards waved it through, but
      // it is below the 24.16.0 SQLite-WAL-reset floor.
      expect(evaluateNodeVersion('24.13.1').compliant).toBe(false);
    });

    it('accepts the exact required floor', () => {
      expect(evaluateNodeVersion(required).compliant).toBe(true);
    });

    it('accepts higher patch / minor / major', () => {
      expect(evaluateNodeVersion(`${req.major}.${req.minor}.${req.patch + 1}`).compliant).toBe(
        true,
      );
      expect(evaluateNodeVersion(`${req.major}.${req.minor + 1}.0`).compliant).toBe(true);
      expect(evaluateNodeVersion(`${req.major + 1}.0.0`).compliant).toBe(true);
    });

    it('rejects below-floor minor and pre-floor major', () => {
      expect(evaluateNodeVersion(`${req.major}.${Math.max(req.minor - 1, 0)}.99`).compliant).toBe(
        req.minor === 0,
      );
      expect(evaluateNodeVersion('22.9.0').compliant).toBe(false);
    });

    it('fails closed on a malformed version', () => {
      expect(evaluateNodeVersion('not-a-version').compliant).toBe(false);
    });

    it('emits a hint containing the required version when non-compliant', () => {
      const v = evaluateNodeVersion('24.13.1');
      expect(v.hints.length).toBeGreaterThan(0);
      expect(v.hints.some((h) => h.command.includes(required))).toBe(true);
    });

    it('emits no hints when compliant', () => {
      expect(evaluateNodeVersion(required).hints).toEqual([]);
    });
  });

  describe('enforceNodeVersion', () => {
    it('is a no-op (no write, no exit) when compliant', () => {
      const write = vi.fn();
      const exit = vi.fn() as unknown as (code: number) => never;
      const verdict = enforceNodeVersion({ current: '26.2.0', write, exit });
      expect(verdict.compliant).toBe(true);
      expect(write).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    });

    it('writes guidance and exits 1 in enforce mode when below floor', () => {
      const chunks: string[] = [];
      const exit = vi.fn() as unknown as (code: number) => never;
      enforceNodeVersion({
        current: '24.13.1',
        mode: 'enforce',
        write: (s) => chunks.push(s),
        exit,
      });
      const out = chunks.join('');
      expect(out).toContain('requires Node.js >=');
      expect(out).toContain('24.13.1');
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('warn mode writes but does NOT exit', () => {
      const exit = vi.fn() as unknown as (code: number) => never;
      const verdict = enforceNodeVersion({
        current: '24.13.1',
        mode: 'warn',
        write: () => {},
        exit,
      });
      expect(verdict.compliant).toBe(false);
      expect(exit).not.toHaveBeenCalled();
    });
  });
});
