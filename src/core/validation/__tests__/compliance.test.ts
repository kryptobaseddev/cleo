/**
 * Tests for compliance checking.
 * @task T4528
 * @epic T4454
 */

import { describe, it, expect } from 'vitest';
import {
  checkManifestEntry,
  checkReturnFormat,
  scoreSubagentCompliance,
  calculateTokenEfficiency,
  calculateOrchestrationOverhead,
} from '../compliance.js';

describe('checkManifestEntry', () => {
  it('returns missing for null entry', () => {
    expect(checkManifestEntry(null)).toBe('missing');
  });

  it('returns valid for complete entry', () => {
    const entry = {
      id: 'T123-research',
      title: 'Research output',
      status: 'complete',
      key_findings: ['finding 1', 'finding 2'],
      linked_tasks: ['T123'],
    };
    expect(checkManifestEntry(entry)).toBe('valid');
  });

  it('returns partial for entry missing linked_tasks', () => {
    const entry = {
      id: 'T123-research',
      title: 'Research output',
      status: 'complete',
      key_findings: ['finding 1'],
    };
    expect(checkManifestEntry(entry)).toBe('partial');
  });

  it('returns invalid for entry missing most fields', () => {
    const entry = { id: 'T123' };
    expect(checkManifestEntry(entry)).toBe('invalid');
  });
});

describe('checkReturnFormat', () => {
  it('matches valid return format', () => {
    expect(checkReturnFormat('Research complete. See MANIFEST.jsonl for summary.')).toBe(true);
  });

  it('rejects invalid format', () => {
    expect(checkReturnFormat('Done!')).toBe(false);
  });
});

describe('scoreSubagentCompliance', () => {
  it('scores perfect compliance', () => {
    const entry = {
      id: 'T1-res',
      title: 'Research',
      status: 'complete',
      key_findings: ['f1', 'f2'],
      linked_tasks: ['T1'],
    };
    const result = scoreSubagentCompliance(
      'T1',
      'agent-1',
      entry,
      true,
      'Research complete. See MANIFEST.jsonl for summary.',
    );
    expect(result.compliance.compliancePassRate).toBe(1.0);
    expect(result.compliance.violationCount).toBe(0);
  });

  it('penalizes missing manifest', () => {
    const result = scoreSubagentCompliance(
      'T1',
      'agent-1',
      null,
      true,
      'Research complete. See MANIFEST.jsonl for summary.',
    );
    expect(result.compliance.violationCount).toBeGreaterThan(0);
    expect(result.compliance.manifestIntegrity).toBe('missing');
  });
});

describe('calculateTokenEfficiency', () => {
  it('calculates correct utilization', () => {
    const result = calculateTokenEfficiency(50000, 200000, 5, 40000, 10000);
    expect(result.contextUtilization).toBe(0.25);
    expect(result.tokensUsed).toBe(50000);
    expect(result.tasksCompleted).toBe(5);
  });

  it('handles zero tokens gracefully', () => {
    const result = calculateTokenEfficiency(0, 0, 0, 0, 0);
    expect(result.tokensUsed).toBe(1); // safe default
    expect(result.maxTokens).toBe(200000);
  });
});

describe('calculateOrchestrationOverhead', () => {
  it('calculates overhead ratio', () => {
    const result = calculateOrchestrationOverhead(10000, 90000, 3);
    expect(result.overheadRatio).toBe(0.1);
    expect(result.tokensPerSubagent).toBe(30000);
  });
});
