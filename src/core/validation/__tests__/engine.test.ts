/**
 * Tests for validation engine.
 * @task T4528
 * @epic T4454
 */

import { describe, it, expect } from 'vitest';
import {
  validateTitle,
  validateDescription,
  validateNote,
  validateBlockedBy,
  validateSessionNote,
  validateCancelReason,
  validateStatusTransition,
  isValidStatus,
  checkTimestampSanity,
  isMetadataOnlyUpdate,
  normalizeLabels,
  checkIdUniqueness,
  validateTask,
  validateNoCircularDeps,
  validateSingleActivePhase,
  validateCurrentPhaseConsistency,
  validatePhaseTimestamps,
  validateAll,
  sanitizeFilePath,
  FIELD_LIMITS,
} from '../engine.js';

// ============================================================================
// Title Validation
// ============================================================================

describe('validateTitle', () => {
  it('accepts valid title', () => {
    const result = validateTitle('Implement authentication');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects empty title', () => {
    const result = validateTitle('');
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('empty');
  });

  it('rejects title with newlines', () => {
    const result = validateTitle('Line one\nLine two');
    expect(result.valid).toBe(false);
  });

  it('rejects title with escaped newline sequences', () => {
    const result = validateTitle('Line one\\nLine two');
    expect(result.valid).toBe(false);
  });

  it('rejects title with zero-width characters', () => {
    const result = validateTitle('Hello\u200BWorld');
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('invisible');
  });

  it('rejects title exceeding max length', () => {
    const longTitle = 'a'.repeat(FIELD_LIMITS.MAX_TITLE_LENGTH + 1);
    const result = validateTitle(longTitle);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('too long');
  });

  it('warns about leading/trailing whitespace', () => {
    const result = validateTitle('  padded title  ');
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].message).toContain('whitespace');
  });
});

// ============================================================================
// Field Length Validators
// ============================================================================

describe('field length validators', () => {
  it('validateDescription accepts valid description', () => {
    expect(validateDescription('A short description').valid).toBe(true);
  });

  it('validateDescription rejects too long', () => {
    const result = validateDescription('x'.repeat(FIELD_LIMITS.MAX_DESCRIPTION_LENGTH + 1));
    expect(result.valid).toBe(false);
  });

  it('validateNote accepts valid note', () => {
    expect(validateNote('A note').valid).toBe(true);
  });

  it('validateNote rejects too long', () => {
    const result = validateNote('x'.repeat(FIELD_LIMITS.MAX_NOTE_LENGTH + 1));
    expect(result.valid).toBe(false);
  });

  it('validateBlockedBy accepts valid', () => {
    expect(validateBlockedBy('Waiting on T123').valid).toBe(true);
  });

  it('validateSessionNote rejects too long', () => {
    const result = validateSessionNote('x'.repeat(FIELD_LIMITS.MAX_SESSION_NOTE_LENGTH + 1));
    expect(result.valid).toBe(false);
  });
});

// ============================================================================
// Cancellation Validation
// ============================================================================

describe('validateCancelReason', () => {
  it('accepts valid reason', () => {
    const result = validateCancelReason('No longer needed due to redesign');
    expect(result.valid).toBe(true);
  });

  it('rejects empty reason', () => {
    const result = validateCancelReason('');
    expect(result.valid).toBe(false);
  });

  it('rejects too short', () => {
    const result = validateCancelReason('no');
    expect(result.valid).toBe(false);
  });

  it('rejects disallowed characters', () => {
    const result = validateCancelReason('reason with $pecial chars');
    expect(result.valid).toBe(false);
  });
});

// ============================================================================
// Status Validation
// ============================================================================

describe('status validation', () => {
  it('isValidStatus returns true for valid statuses', () => {
    expect(isValidStatus('pending')).toBe(true);
    expect(isValidStatus('active')).toBe(true);
    expect(isValidStatus('done')).toBe(true);
    expect(isValidStatus('blocked')).toBe(true);
    expect(isValidStatus('cancelled')).toBe(true);
  });

  it('isValidStatus returns false for invalid', () => {
    expect(isValidStatus('completed')).toBe(false);
    expect(isValidStatus('')).toBe(false);
    expect(isValidStatus('ACTIVE')).toBe(false);
  });

  it('validates allowed transitions', () => {
    expect(validateStatusTransition('pending', 'active').valid).toBe(true);
    expect(validateStatusTransition('active', 'done').valid).toBe(true);
    expect(validateStatusTransition('active', 'blocked').valid).toBe(true);
    expect(validateStatusTransition('blocked', 'active').valid).toBe(true);
  });

  it('rejects invalid transitions', () => {
    expect(validateStatusTransition('pending', 'done').valid).toBe(false);
    expect(validateStatusTransition('done', 'active').valid).toBe(false);
  });

  it('allows same status transition', () => {
    expect(validateStatusTransition('active', 'active').valid).toBe(true);
  });
});

// ============================================================================
// Timestamp Validation
// ============================================================================

describe('checkTimestampSanity', () => {
  it('accepts valid timestamp', () => {
    const result = checkTimestampSanity('2025-01-15T10:00:00Z');
    expect(result.valid).toBe(true);
  });

  it('rejects invalid format', () => {
    const result = checkTimestampSanity('2025-01-15 10:00:00');
    expect(result.valid).toBe(false);
  });

  it('rejects future timestamp', () => {
    const result = checkTimestampSanity('2099-01-01T00:00:00Z');
    expect(result.valid).toBe(false);
  });

  it('validates completed_at ordering', () => {
    const result = checkTimestampSanity(
      '2025-01-15T10:00:00Z',
      '2025-01-14T10:00:00Z', // before created_at
    );
    expect(result.valid).toBe(false);
  });
});

// ============================================================================
// Metadata & Labels
// ============================================================================

describe('isMetadataOnlyUpdate', () => {
  it('returns true for metadata fields', () => {
    expect(isMetadataOnlyUpdate(['type', 'labels'])).toBe(true);
    expect(isMetadataOnlyUpdate(['parentId', 'size'])).toBe(true);
  });

  it('returns false for non-metadata fields', () => {
    expect(isMetadataOnlyUpdate(['status'])).toBe(false);
    expect(isMetadataOnlyUpdate(['type', 'content'])).toBe(false);
  });
});

describe('normalizeLabels', () => {
  it('deduplicates and sorts labels', () => {
    expect(normalizeLabels('beta,alpha,beta')).toBe('alpha,beta');
  });

  it('trims whitespace', () => {
    expect(normalizeLabels('  a , b , c ')).toBe('a,b,c');
  });

  it('handles empty input', () => {
    expect(normalizeLabels('')).toBe('');
  });
});

// ============================================================================
// ID Uniqueness
// ============================================================================

describe('checkIdUniqueness', () => {
  it('passes with unique IDs', () => {
    const result = checkIdUniqueness({
      tasks: [{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }],
    });
    expect(result.valid).toBe(true);
  });

  it('fails with duplicate IDs', () => {
    const result = checkIdUniqueness({
      tasks: [{ id: 'T1' }, { id: 'T2' }, { id: 'T1' }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('T1');
  });

  it('fails with cross-file duplicates', () => {
    const result = checkIdUniqueness(
      { tasks: [{ id: 'T1' }, { id: 'T2' }] },
      { archived_tasks: [{ id: 'T2' }, { id: 'T3' }] },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('T2');
  });
});

// ============================================================================
// Task Validation
// ============================================================================

describe('validateTask', () => {
  it('validates a well-formed task', () => {
    const result = validateTask({
      id: 'T1',
      content: 'Fix the bug',
      status: 'active',
      activeForm: 'Fixing the bug',
      created_at: '2025-01-01T00:00:00Z',
    });
    expect(result.valid).toBe(true);
  });

  it('fails when missing required fields', () => {
    const result = validateTask({});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('fails for invalid status', () => {
    const result = validateTask({
      id: 'T1',
      content: 'Task',
      status: 'invalid',
      activeForm: 'Working',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'status')).toBe(true);
  });
});

// ============================================================================
// Circular Dependencies
// ============================================================================

describe('validateNoCircularDeps', () => {
  it('passes with no cycle', () => {
    const tasks = [
      { id: 'T1', depends: ['T2'] },
      { id: 'T2', depends: ['T3'] },
      { id: 'T3', depends: [] },
    ];
    const result = validateNoCircularDeps(tasks, 'T1', ['T2']);
    expect(result.valid).toBe(true);
  });

  it('detects direct cycle', () => {
    const tasks = [
      { id: 'T1', depends: ['T2'] },
      { id: 'T2', depends: ['T1'] },
    ];
    const result = validateNoCircularDeps(tasks, 'T1', ['T2']);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Circular');
  });

  it('passes with empty deps', () => {
    const tasks = [{ id: 'T1', depends: [] }];
    const result = validateNoCircularDeps(tasks, 'T1', []);
    expect(result.valid).toBe(true);
  });
});

// ============================================================================
// Phase Validation
// ============================================================================

describe('phase validation', () => {
  it('validates single active phase', () => {
    const result = validateSingleActivePhase({
      tasks: [],
      project: {
        phases: {
          design: { status: 'completed' },
          build: { status: 'active' },
        },
      },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects multiple active phases', () => {
    const result = validateSingleActivePhase({
      tasks: [],
      project: {
        phases: {
          design: { status: 'active' },
          build: { status: 'active' },
        },
      },
    });
    expect(result.valid).toBe(false);
  });

  it('validates currentPhase consistency', () => {
    const result = validateCurrentPhaseConsistency({
      tasks: [],
      project: {
        currentPhase: 'build',
        phases: {
          build: { status: 'active' },
        },
      },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects inconsistent currentPhase', () => {
    const result = validateCurrentPhaseConsistency({
      tasks: [],
      project: {
        currentPhase: 'build',
        phases: {
          build: { status: 'completed' },
        },
      },
    });
    expect(result.valid).toBe(false);
  });
});

// ============================================================================
// Path Security
// ============================================================================

describe('sanitizeFilePath', () => {
  it('accepts valid paths', () => {
    expect(sanitizeFilePath('/home/user/file.txt')).toBe('/home/user/file.txt');
  });

  it('rejects shell metacharacters', () => {
    expect(() => sanitizeFilePath('/home/user/$(cmd)')).toThrow();
    expect(() => sanitizeFilePath('/home/user/file;rm -rf')).toThrow();
  });

  it('rejects empty path', () => {
    expect(() => sanitizeFilePath('')).toThrow();
  });
});

// ============================================================================
// Comprehensive Validation
// ============================================================================

describe('validateAll', () => {
  it('passes for valid todo file', () => {
    const result = validateAll({
      tasks: [
        {
          id: 'T1',
          content: 'Task one',
          status: 'active',
          activeForm: 'Working on task one',
          created_at: '2025-01-01T00:00:00Z',
        },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.schemaErrors).toBe(0);
    expect(result.semanticErrors).toBe(0);
  });

  it('catches semantic errors', () => {
    const result = validateAll({
      tasks: [
        { id: 'T1', content: 'Task', status: 'invalid', activeForm: 'Working' },
      ],
    });
    expect(result.semanticErrors).toBeGreaterThan(0);
  });
});
