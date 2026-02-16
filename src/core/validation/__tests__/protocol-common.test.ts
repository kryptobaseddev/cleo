/**
 * Tests for protocol validation common utilities.
 * @task T4528
 * @epic T4454
 */

import { describe, it, expect } from 'vitest';
import {
  checkReturnMessageFormat,
  checkManifestFieldPresent,
  checkManifestFieldType,
  checkKeyFindingsCount,
  checkStatusValid,
  checkAgentType,
  checkLinkedTasksPresent,
  validateCommonManifestRequirements,
} from '../protocol-common.js';

describe('checkReturnMessageFormat', () => {
  it('accepts valid research format', () => {
    expect(checkReturnMessageFormat('Research complete. See MANIFEST.jsonl for summary.')).toBe(true);
  });

  it('accepts valid implementation format', () => {
    expect(checkReturnMessageFormat('Implementation complete. See MANIFEST.jsonl for summary.')).toBe(true);
  });

  it('accepts partial status', () => {
    expect(checkReturnMessageFormat('Research partial. See MANIFEST.jsonl for details.')).toBe(true);
  });

  it('accepts blocked status', () => {
    expect(checkReturnMessageFormat('Implementation blocked. See MANIFEST.jsonl for blocker details.')).toBe(true);
  });

  it('rejects invalid format', () => {
    expect(checkReturnMessageFormat('Done')).toBe(false);
    expect(checkReturnMessageFormat('Research done. See MANIFEST.jsonl for summary.')).toBe(false);
  });
});

describe('checkManifestFieldPresent', () => {
  it('returns true for present field', () => {
    expect(checkManifestFieldPresent({ id: 'T1' }, 'id')).toBe(true);
  });

  it('returns false for missing field', () => {
    expect(checkManifestFieldPresent({}, 'id')).toBe(false);
  });

  it('returns false for null field', () => {
    expect(checkManifestFieldPresent({ id: null }, 'id')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(checkManifestFieldPresent({ id: '' }, 'id')).toBe(false);
  });
});

describe('checkManifestFieldType', () => {
  it('validates string type', () => {
    expect(checkManifestFieldType({ name: 'hello' }, 'name', 'string')).toBe(true);
  });

  it('validates array type', () => {
    expect(checkManifestFieldType({ items: [1, 2] }, 'items', 'array')).toBe(true);
  });

  it('validates number type', () => {
    expect(checkManifestFieldType({ count: 5 }, 'count', 'number')).toBe(true);
  });

  it('rejects wrong type', () => {
    expect(checkManifestFieldType({ name: 123 }, 'name', 'string')).toBe(false);
  });
});

describe('checkKeyFindingsCount', () => {
  it('accepts 3-7 findings', () => {
    expect(checkKeyFindingsCount({ key_findings: ['a', 'b', 'c'] })).toBe(true);
    expect(checkKeyFindingsCount({ key_findings: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })).toBe(true);
  });

  it('rejects too few', () => {
    expect(checkKeyFindingsCount({ key_findings: ['a', 'b'] })).toBe(false);
  });

  it('rejects too many', () => {
    expect(checkKeyFindingsCount({ key_findings: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] })).toBe(false);
  });
});

describe('checkStatusValid', () => {
  it('accepts valid statuses', () => {
    expect(checkStatusValid({ status: 'complete' })).toBe(true);
    expect(checkStatusValid({ status: 'partial' })).toBe(true);
    expect(checkStatusValid({ status: 'blocked' })).toBe(true);
  });

  it('rejects invalid status', () => {
    expect(checkStatusValid({ status: 'done' })).toBe(false);
  });
});

describe('checkAgentType', () => {
  it('matches expected type', () => {
    expect(checkAgentType({ agent_type: 'research' }, 'research')).toBe(true);
  });

  it('rejects mismatch', () => {
    expect(checkAgentType({ agent_type: 'research' }, 'implementation')).toBe(false);
  });
});

describe('checkLinkedTasksPresent', () => {
  it('passes when all required IDs present', () => {
    expect(checkLinkedTasksPresent(
      { linked_tasks: ['T1', 'T2', 'T3'] },
      ['T1', 'T2'],
    )).toBe(true);
  });

  it('fails when IDs missing', () => {
    expect(checkLinkedTasksPresent(
      { linked_tasks: ['T1'] },
      ['T1', 'T2'],
    )).toBe(false);
  });
});

describe('validateCommonManifestRequirements', () => {
  it('passes with all fields', () => {
    const entry = {
      id: 'T1-research',
      file: 'output.md',
      status: 'complete',
      key_findings: ['a', 'b', 'c'],
      linked_tasks: ['T1'],
    };
    const result = validateCommonManifestRequirements(entry);
    expect(result.valid).toBe(true);
    expect(result.score).toBe(100);
  });

  it('deducts for missing fields', () => {
    const entry = { status: 'complete' };
    const result = validateCommonManifestRequirements(entry);
    expect(result.valid).toBe(false);
    expect(result.score).toBeLessThan(70);
  });
});
