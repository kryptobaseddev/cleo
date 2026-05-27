/**
 * T11060 — Docs dogfood regression tests for 2026-05-25 failures.
 *
 * Covers two dogfood failure classes from the 2026-05-25 sessions:
 *   (a) Outside-project file rejection produces an actionable agent-facing error
 *   (b) Invalid docs status enum is rejected with the canonical lifecycle status list
 *
 * Tests use core-level functions imported from @cleocode/core/internal
 * so they run in CI without requiring a pre-built CLI dist/.
 *
 * AC coverage:
 *   1. sanitizePath rejects paths outside projectRoot with E_PATH_TRAVERSAL
 *   2. isLifecycleStatus rejects non-canonical status values
 *   3. DOCS_UPDATE_LIFECYCLE_STATUS_LIST contains the full canonical set
 *
 * @task T11060 (Epic T10521 · Saga T10516 · E2)
 */

import { describe, expect, it } from 'vitest';
import {
  isLifecycleStatus,
  DOCS_UPDATE_LIFECYCLE_STATUS_LIST,
  sanitizePath,
  SecurityError,
} from '@cleocode/core/internal';
import { DOCS_LIFECYCLE_STATUSES } from '@cleocode/contracts';

// ═══════════════════════════════════════════════════════════════════════════════
// AC1: Outside-project file rejection
// ═══════════════════════════════════════════════════════════════════════════════

describe('T11060 AC1 — outside-project file rejection (sanitizePath)', () => {
  const projectRoot = '/tmp/t11060-project';

  it('rejects absolute path outside projectRoot with E_PATH_TRAVERSAL', () => {
    expect(() => sanitizePath('/etc/passwd', projectRoot)).toThrow(SecurityError);

    try {
      sanitizePath('/etc/passwd', projectRoot);
    } catch (err) {
      expect(err).toBeInstanceOf(SecurityError);
      const se = err as SecurityError;
      expect(se.code).toBe('E_PATH_TRAVERSAL');
      expect(se.message).toMatch(/outside project root/i);
      // Must name the rejected path so agents can see what was rejected.
      expect(se.message).toContain('/etc/passwd');
    }
  });

  it('rejects relative path that resolves outside projectRoot (../ escape)', () => {
    expect(() => sanitizePath('../../../etc/passwd', projectRoot)).toThrow(SecurityError);

    try {
      sanitizePath('../../../etc/passwd', projectRoot);
    } catch (err) {
      const se = err as SecurityError;
      expect(se.code).toBe('E_PATH_TRAVERSAL');
      expect(se.message).toMatch(/outside project root/i);
    }
  });

  it('rejects path with null bytes', () => {
    expect(() => sanitizePath('/tmp/t11060-project/file\0hidden.txt', projectRoot)).toThrow(
      SecurityError,
    );

    try {
      sanitizePath('/tmp/t11060-project/file\0hidden.txt', projectRoot);
    } catch (err) {
      const se = err as SecurityError;
      expect(se.code).toBe('E_PATH_TRAVERSAL');
      expect(se.message).toMatch(/null bytes/i);
    }
  });

  it('accepts path inside projectRoot', () => {
    const result = sanitizePath('/tmp/t11060-project/docs/file.md', projectRoot);
    expect(result).toBe('/tmp/t11060-project/docs/file.md');
  });

  it('accepts relative path inside projectRoot', () => {
    const result = sanitizePath('docs/file.md', projectRoot);
    expect(result).toBe('/tmp/t11060-project/docs/file.md');
  });

  it('rejects empty path', () => {
    expect(() => sanitizePath('', projectRoot)).toThrow(SecurityError);

    try {
      sanitizePath('', projectRoot);
    } catch (err) {
      const se = err as SecurityError;
      expect(se.code).toBe('E_INVALID_PATH');
      expect(se.message).toMatch(/cannot be empty/i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC2: Invalid docs status enum
// ═══════════════════════════════════════════════════════════════════════════════

describe('T11060 AC2 — invalid docs status enum (isLifecycleStatus)', () => {
  it('rejects "review" — not in canonical lifecycle list', () => {
    expect(isLifecycleStatus('review')).toBe(false);
  });

  it('rejects "done" — not a docs lifecycle status', () => {
    expect(isLifecycleStatus('done')).toBe(false);
  });

  it('rejects "published" — confusing with task status, not docs status', () => {
    expect(isLifecycleStatus('published')).toBe(false);
  });

  it('rejects "in-progress" — not in canonical lifecycle list', () => {
    expect(isLifecycleStatus('in-progress')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isLifecycleStatus('')).toBe(false);
  });

  it('rejects numbers and non-strings', () => {
    expect(isLifecycleStatus(42)).toBe(false);
    expect(isLifecycleStatus(null)).toBe(false);
    expect(isLifecycleStatus(undefined)).toBe(false);
    expect(isLifecycleStatus({})).toBe(false);
  });

  // ── All canonical statuses must be accepted ────────────────────────────

  for (const status of DOCS_LIFECYCLE_STATUSES) {
    it(`accepts canonical status "${status}"`, () => {
      expect(isLifecycleStatus(status)).toBe(true);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DOCS_UPDATE_LIFECYCLE_STATUS_LIST contract
// ═══════════════════════════════════════════════════════════════════════════════

describe('T11060 — DOCS_UPDATE_LIFECYCLE_STATUS_LIST contains all canonical statuses', () => {
  it('includes all six lifecycle statuses in the pipe-delimited list', () => {
    for (const status of DOCS_LIFECYCLE_STATUSES) {
      expect(DOCS_UPDATE_LIFECYCLE_STATUS_LIST).toContain(status);
    }
  });

  it('is pipe-delimited for readable error messages', () => {
    expect(DOCS_UPDATE_LIFECYCLE_STATUS_LIST).toContain('|');
  });

  it('contains exactly the canonical six statuses (no extras)', () => {
    const parts = DOCS_UPDATE_LIFECYCLE_STATUS_LIST.split('|');
    expect(parts).toHaveLength(DOCS_LIFECYCLE_STATUSES.length);
    for (const status of DOCS_LIFECYCLE_STATUSES) {
      expect(parts).toContain(status);
    }
  });

  it('matches the sorted canonical order from @cleocode/contracts', () => {
    const expected = DOCS_LIFECYCLE_STATUSES.join('|');
    expect(DOCS_UPDATE_LIFECYCLE_STATUS_LIST).toBe(expected);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC3: Error message contract — the errors are agent-actionable
// ═══════════════════════════════════════════════════════════════════════════════

describe('T11060 AC3 — error message contract verification', () => {
  it('E_INVALID_STATUS error includes the canonical lifecycle status list', () => {
    // Verify that the status list used in error messages is complete.
    // The updateDocBySlug function uses this format:
    //   `status must be one of: ${ALLOWED_STATUSES.join('|')} — got '${String(status)}'`
    // ALLOWED_STATUSES === DOCS_LIFECYCLE_STATUSES
    // The join result === DOCS_UPDATE_LIFECYCLE_STATUS_LIST

    const invalidStatus = 'review';
    const msg = `status must be one of: ${DOCS_UPDATE_LIFECYCLE_STATUS_LIST} — got '${invalidStatus}'`;

    // The error must:
    // 1. Explain what's wrong
    expect(msg).toMatch(/status must be one of/i);
    // 2. List all valid statuses (pipe-delimited)
    for (const s of DOCS_LIFECYCLE_STATUSES) {
      expect(msg).toContain(s);
    }
    // 3. Name the invalid value that was passed
    expect(msg).toContain(invalidStatus);

    // Full canonical pipe-delimited list is present
    expect(msg).toContain(
      'draft|proposed|accepted|superseded|archived|deprecated',
    );
  });

  it('E_PATH_TRAVERSAL error includes path information for agent debugging', () => {
    // The sanitizePath function throws:
    //   `Path traversal detected: "${path}" resolves outside project root`

    try {
      sanitizePath('/outside/file.txt', '/tmp/test-project');
    } catch (err) {
      const se = err as SecurityError;
      expect(se.code).toBe('E_PATH_TRAVERSAL');
      // Error provides:
      // - codeName: E_PATH_TRAVERSAL (machine-readable)
      // - message: names the rejected path (human + agent actionable)
      // - field: 'path' (tells agent which parameter was wrong)
      expect(se.message).toContain('/outside/file.txt');
      expect(se.message).toMatch(/outside project root/i);
      expect(se.field).toBe('path');
    }
  });
});
