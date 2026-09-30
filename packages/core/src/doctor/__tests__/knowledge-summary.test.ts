/**
 * Token economy of the orientation knowledge summary (T12522 · epic T12484).
 *
 * `cleo briefing` and `cleo focus` used to emit the compact coverage object
 * twice: once at the top level and again inside `knowledgeHealth`. This test
 * measures the envelope before and after the dedup with the same estimator
 * the CLI budget uses (~4 chars per token) and asserts that the reduction is
 * the full size of the duplicated copy, with no meaning-bearing field dropped.
 *
 * @task T12522
 */
import type {
  KnowledgeCoverage,
  KnowledgeHealth,
  KnowledgeRepairFinding,
  KnowledgeRepairState,
} from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../../metrics/token-estimation.js';
import { compactKnowledgeCoverage, compactKnowledgeHealth } from '../knowledge-summary.js';

const PROJECT_ID = 'proj-7f3a9c2e';

/** One repair-matrix row in the given lifecycle state. */
function finding(id: string, state: KnowledgeRepairState): KnowledgeRepairFinding {
  return {
    id,
    projectId: PROJECT_ID,
    affectedRecordIds: [`O-${id}`],
    description: `Fixture finding ${id}.`,
    evidence: [],
    repairClass: 'agent-resolvable',
    state,
    proposedAction: null,
    verification: [],
    recovery: null,
  };
}

/** A realistic partial-coverage assessment, as bounded maintenance produces it. */
function fixtureHealth(): KnowledgeHealth {
  const coverage: KnowledgeCoverage = {
    status: 'partial',
    projectId: PROJECT_ID,
    assessedRevision: '45ab286fa0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5',
    indexedRevision: '440a16368a1b2c3d4e5f60718293a4b5c6d7e8f9',
    assessedAt: '2026-09-29T19:00:00.000Z',
    reasons: [
      'Index revision 440a16368 is behind the assessed revision 45ab286fa.',
      '17 source files changed since the last nexus analyze.',
      'Extraction for .rs files is not available on this host.',
    ],
    evidence: [
      {
        id: 'nexus:index',
        projectId: PROJECT_ID,
        source: 'index',
        revision: '440a16368a1b2c3d4e5f60718293a4b5c6d7e8f9',
        precision: 'project',
        excerpt: 'nexus index row for the project',
      },
      {
        id: 'git:HEAD',
        projectId: PROJECT_ID,
        source: 'commit',
        revision: '45ab286fa0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5',
        precision: 'project',
      },
    ],
    limitations: [
      'Static analysis cannot prove all runtime callers.',
      'Dynamic imports are resolved only when the specifier is a string literal.',
    ],
  };
  return {
    structure: { status: 'clean', reasons: [], evidence: [] },
    semantics: {
      status: 'findings',
      reasons: ['2 memory records conflict on the release branch convention.'],
      evidence: [],
    },
    extraction: {
      status: 'unavailable',
      reasons: ['tree-sitter-rust is not installed.'],
      evidence: [],
    },
    coverage,
    findings: [finding('f1', 'pending'), finding('f2', 'pending'), finding('f3', 'unresolved')],
  };
}

describe('orientation knowledge coverage is emitted once (T12522)', () => {
  it('saves the full duplicated coverage copy, measured in estimated tokens', () => {
    const health = fixtureHealth();
    const coverage = compactKnowledgeCoverage(health.coverage);
    const summary = compactKnowledgeHealth(health, '/coverage');
    const { coverageRef: _ref, ...summaryFields } = summary;

    // Before T12522: knowledgeHealth repeated the compact coverage object.
    const before = JSON.stringify({ coverage, knowledgeHealth: { ...summaryFields, coverage } });
    // After T12522: knowledgeHealth points at the single copy.
    const after = JSON.stringify({ coverage, knowledgeHealth: summary });

    const beforeTokens = estimateTokens(before);
    const afterTokens = estimateTokens(after);
    const coverageTokens = estimateTokens(JSON.stringify(coverage));
    const savedTokens = beforeTokens - afterTokens;

    // The pointer costs a few tokens; the removed copy is the whole coverage object.
    const pointerTokens = estimateTokens(JSON.stringify({ coverageRef: '/coverage' }));
    expect(savedTokens).toBeGreaterThanOrEqual(coverageTokens - pointerTokens);
    // For this fixture the knowledge block shrinks by more than a third.
    expect(afterTokens).toBeLessThan(beforeTokens * (2 / 3));
    // The coverage text appears exactly once in the emitted block.
    expect(after.match(/"assessedAt"/g)).toHaveLength(1);
    expect(before.match(/"assessedAt"/g)).toHaveLength(2);
  });

  it('keeps every meaning-bearing field: statuses, counts, negations and the pointer', () => {
    const health = fixtureHealth();
    const coverage = compactKnowledgeCoverage(health.coverage);
    const summary = compactKnowledgeHealth(health, '/knowledgeCoverage');

    expect(summary).not.toHaveProperty('coverage');
    expect(summary.coverageRef).toBe('/knowledgeCoverage');
    // Diagnostic outcomes, including the negative ones, stay visible.
    expect(summary.structure.status).toBe('clean');
    expect(summary.semantics.status).toBe('findings');
    expect(summary.extraction.status).toBe('unavailable');
    expect(summary.extraction.reasons).toEqual(['tree-sitter-rust is not installed.']);
    // Real finding counts, never an implied empty healthy result.
    expect(summary.findings).toEqual([]);
    expect(summary.findingCount).toBe(3);
    expect(summary.findingStates).toEqual({ pending: 2, unresolved: 1 });
    expect(summary.detailsCommand).toBe('cleo doctor knowledge');
    // The single coverage copy keeps status, provenance (null-able revisions) and exact totals.
    expect(coverage).toMatchObject({
      status: 'partial',
      projectId: PROJECT_ID,
      assessedRevision: health.coverage.assessedRevision,
      indexedRevision: health.coverage.indexedRevision,
      reasonCount: 3,
      evidenceCount: 2,
      detailsCommand: 'cleo doctor knowledge',
    });
  });
});
