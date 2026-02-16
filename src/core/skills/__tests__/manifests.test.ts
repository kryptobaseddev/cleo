/**
 * Tests for manifest operations and contribution protocol.
 * @task T4522
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ManifestEntry } from '../types.js';
import {
  generateContributionId,
  detectConflicts,
  computeConsensus,
  createContributionManifestEntry,
} from '../manifests/contribution.js';
import type { ContributionDecision } from '../manifests/contribution.js';

describe('generateContributionId', () => {
  it('should generate unique IDs', () => {
    const id1 = generateContributionId('T001');
    const id2 = generateContributionId('T001');

    expect(id1).toMatch(/^contrib-T001-\d{4}-\d{2}-\d{2}-[a-f0-9]+$/);
    expect(id1).not.toBe(id2); // Should be unique
  });

  it('should include task ID', () => {
    const id = generateContributionId('T999');
    expect(id).toContain('T999');
  });
});

describe('detectConflicts', () => {
  it('should detect conflicting decisions', () => {
    const decisions1: ContributionDecision[] = [
      { agentId: 'agent-1', taskId: 'T001', decision: 'approve', confidence: 0.9, rationale: 'Good' },
    ];
    const decisions2: ContributionDecision[] = [
      { agentId: 'agent-2', taskId: 'T001', decision: 'reject', confidence: 0.4, rationale: 'Bad' },
    ];

    const conflicts = detectConflicts(decisions1, decisions2);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].severity).toBe('medium'); // 0.5 diff (boundary: >0.5 = high)
    expect(conflicts[0].agent1).toBe('agent-1');
    expect(conflicts[0].agent2).toBe('agent-2');
  });

  it('should not report conflicts for matching decisions', () => {
    const decisions1: ContributionDecision[] = [
      { agentId: 'agent-1', taskId: 'T001', decision: 'approve', confidence: 0.9, rationale: 'Good' },
    ];
    const decisions2: ContributionDecision[] = [
      { agentId: 'agent-2', taskId: 'T001', decision: 'approve', confidence: 0.8, rationale: 'Also good' },
    ];

    const conflicts = detectConflicts(decisions1, decisions2);

    expect(conflicts).toHaveLength(0);
  });

  it('should only compare same-task decisions', () => {
    const decisions1: ContributionDecision[] = [
      { agentId: 'agent-1', taskId: 'T001', decision: 'approve', confidence: 0.9, rationale: '' },
    ];
    const decisions2: ContributionDecision[] = [
      { agentId: 'agent-2', taskId: 'T002', decision: 'reject', confidence: 0.4, rationale: '' },
    ];

    const conflicts = detectConflicts(decisions1, decisions2);
    expect(conflicts).toHaveLength(0);
  });
});

describe('computeConsensus', () => {
  it('should compute consensus from unanimous decisions', () => {
    const decisions: ContributionDecision[] = [
      { agentId: 'a1', taskId: 'T001', decision: 'approve', confidence: 0.9, rationale: '' },
      { agentId: 'a2', taskId: 'T001', decision: 'approve', confidence: 0.8, rationale: '' },
    ];

    const result = computeConsensus(decisions);

    expect(result.decision).toBe('approve');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.conflicts).toHaveLength(0);
  });

  it('should select majority decision', () => {
    const decisions: ContributionDecision[] = [
      { agentId: 'a1', taskId: 'T001', decision: 'approve', confidence: 0.9, rationale: '' },
      { agentId: 'a2', taskId: 'T001', decision: 'approve', confidence: 0.8, rationale: '' },
      { agentId: 'a3', taskId: 'T001', decision: 'reject', confidence: 0.3, rationale: '' },
    ];

    const result = computeConsensus(decisions);

    expect(result.decision).toBe('approve');
    expect(result.conflicts.length).toBeGreaterThan(0); // There's a disagreement
  });

  it('should return empty for no decisions', () => {
    const result = computeConsensus([]);

    expect(result.decision).toBe('');
    expect(result.confidence).toBe(0);
  });

  it('should respect custom weights', () => {
    const decisions: ContributionDecision[] = [
      { agentId: 'a1', taskId: 'T001', decision: 'approve', confidence: 0.5, rationale: '' },
      { agentId: 'a2', taskId: 'T001', decision: 'reject', confidence: 0.9, rationale: '' },
    ];

    // Give agent 1 a very high weight
    const result = computeConsensus(decisions, { a1: 10, a2: 0.1 });

    expect(result.decision).toBe('approve');
  });
});

describe('createContributionManifestEntry', () => {
  it('should create valid manifest entry', () => {
    const decisions: ContributionDecision[] = [
      { agentId: 'a1', taskId: 'T001', decision: 'approve', confidence: 0.9, rationale: 'Good' },
    ];

    const entry = createContributionManifestEntry('T001', 'contrib-T001-2026-01-15-abc', decisions);

    expect(entry.id).toBe('contrib-T001-2026-01-15-abc');
    expect(entry.status).toBe('complete');
    expect(entry.agent_type).toBe('contribution');
    expect(entry.linked_tasks).toEqual(['T001']);
    expect(entry.actionable).toBe(true);
  });
});
