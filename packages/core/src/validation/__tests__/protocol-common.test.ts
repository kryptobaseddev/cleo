/**
 * Tests for protocol validation common utilities.
 * @task T4528
 * @epic T4454
 */

import { describe, expect, it } from 'vitest';
import {
  checkAgentType,
  checkKeyFindingsCount,
  checkLinkedTasksPresent,
  checkManifestFieldPresent,
  checkManifestFieldType,
  checkReturnMessageFormat,
  checkStatusValid,
  parseReturnMessage,
  validateCommonManifestRequirements,
} from '../protocol-common.js';

describe('checkReturnMessageFormat', () => {
  it('accepts valid research format', () => {
    expect(
      checkReturnMessageFormat('Research completed. Manifest appended to pipeline_manifest.'),
    ).toBe(true);
  });

  it('accepts valid implementation format', () => {
    expect(
      checkReturnMessageFormat('Implementation completed. Manifest appended to pipeline_manifest.'),
    ).toBe(true);
  });

  it('accepts partial status', () => {
    expect(
      checkReturnMessageFormat('Research partial. Manifest appended to pipeline_manifest.'),
    ).toBe(true);
  });

  it('accepts blocked status', () => {
    expect(
      checkReturnMessageFormat('Implementation blocked. Manifest appended to pipeline_manifest.'),
    ).toBe(true);
  });

  it('rejects invalid format', () => {
    expect(checkReturnMessageFormat('Done')).toBe(false);
    expect(
      checkReturnMessageFormat(
        'Research complete. Manifest appended to pipeline_manifest.\ncommits: none',
      ),
    ).toBe(false);
    expect(checkReturnMessageFormat('Research done. Manifest appended to pipeline_manifest.')).toBe(
      false,
    );
  });

  it('accepts the compressed return block (T12521)', () => {
    const block =
      'Consensus partial. manifest:T1-consensus-20260929\ncommits: abc1234,def5678\ngates: implemented=pass testsPassed=skip\nblocker: waiting on owner vote';
    expect(checkReturnMessageFormat(block)).toBe(true);
    expect(checkReturnMessageFormat(block, 'consensus')).toBe(true);
    expect(checkReturnMessageFormat(block, 'research')).toBe(false);
  });

  it('accepts the spawn-prompt spelling `complete` and the ADR type (T12521)', () => {
    expect(
      checkReturnMessageFormat(
        'ADR complete. Manifest appended to pipeline_manifest.',
        'architecture_decision',
      ),
    ).toBe(true);
    expect(checkReturnMessageFormat('ADR complete. manifest:e1', 'architecture_decision')).toBe(
      true,
    );
  });
});

describe('parseReturnMessage (T12521)', () => {
  it('parses the compressed form into its parts', () => {
    expect(
      parseReturnMessage(
        'Implementation blocked. manifest:none\ncommits: none\nblocker: manifest append failed',
      ),
    ).toEqual({
      form: 'compressed',
      type: 'Implementation',
      status: 'blocked',
      entryId: 'none',
      commits: 'none',
      gates: null,
      blocker: 'manifest append failed',
    });
  });

  it('parses the legacy one-liner', () => {
    expect(
      parseReturnMessage('Research completed. Manifest appended to pipeline_manifest.'),
    ).toMatchObject({ form: 'legacy', type: 'Research', status: 'completed', entryId: null });
  });

  it('rejects unknown, duplicate or empty detail lines and a blocker on complete', () => {
    expect(parseReturnMessage('Research complete. manifest:e1\nnotes: x')).toBeNull();
    expect(parseReturnMessage('Research complete. manifest:e1\ngates: a\ngates: b')).toBeNull();
    expect(parseReturnMessage('Research complete. manifest:e1\ncommits: ')).toBeNull();
    expect(parseReturnMessage('Research complete. manifest:e1\nblocker: CI red')).toBeNull();
    expect(parseReturnMessage('Research complete. manifest:e1\nblocker: none')).not.toBeNull();
  });

  it('restricts the type word when a type list is given', () => {
    expect(parseReturnMessage('Epic created. manifest:e1', ['Research'])).toBeNull();
    expect(parseReturnMessage('Research partial. manifest:e1', ['Research'])).not.toBeNull();
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
    expect(checkKeyFindingsCount({ key_findings: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] })).toBe(
      false,
    );
  });
});

describe('checkStatusValid', () => {
  it('accepts valid statuses', () => {
    expect(checkStatusValid({ status: 'completed' })).toBe(true);
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
    expect(checkLinkedTasksPresent({ linked_tasks: ['T1', 'T2', 'T3'] }, ['T1', 'T2'])).toBe(true);
  });

  it('fails when IDs missing', () => {
    expect(checkLinkedTasksPresent({ linked_tasks: ['T1'] }, ['T1', 'T2'])).toBe(false);
  });
});

describe('validateCommonManifestRequirements', () => {
  it('passes with all fields', () => {
    const entry = {
      id: 'T1-research',
      file: 'output.md',
      status: 'completed',
      key_findings: ['a', 'b', 'c'],
      linked_tasks: ['T1'],
    };
    const result = validateCommonManifestRequirements(entry);
    expect(result.valid).toBe(true);
    expect(result.score).toBe(100);
  });

  it('deducts for missing fields', () => {
    const entry = { status: 'completed' };
    const result = validateCommonManifestRequirements(entry);
    expect(result.valid).toBe(false);
    expect(result.score).toBeLessThan(70);
  });
});
