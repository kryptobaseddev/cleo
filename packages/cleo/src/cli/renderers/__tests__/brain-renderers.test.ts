/**
 * Snapshot tests for brain subcommand renderers.
 *
 * Covers T1722: all 77 raw stdout writes migrated to cliOutput.
 * Tests cover both --human and quiet modes for each subcommand:
 *   - brain-maintenance
 *   - brain-backfill
 *   - brain-purge
 *   - brain-plasticity-stats
 *   - brain-quality
 *   - brain-export
 *
 * @task T1722
 * @epic T1691
 */

import { describe, expect, it } from 'vitest';
import {
  renderBrainBackfill,
  renderBrainExport,
  renderBrainMaintenance,
  renderBrainPlasticityStats,
  renderBrainPurge,
  renderBrainQuality,
} from '../system.js';

// ---------------------------------------------------------------------------
// renderBrainMaintenance
// ---------------------------------------------------------------------------

describe('renderBrainMaintenance', () => {
  const fullData: Record<string, unknown> = {
    duration: 1234,
    decay: { affected: 3 },
    consolidation: { merged: 2, removed: 1 },
    tierPromotion: { promoted: 5, evicted: 1 },
    reconciliation: { decisionsFixed: 2, observationsFixed: 4, linksRemoved: 1 },
    embeddings: { processed: 10, skipped: 2, errors: 0 },
  };

  it('renders full maintenance result with all steps', () => {
    const output = renderBrainMaintenance(fullData, false);
    expect(output).toContain('Maintenance complete.');
    expect(output).toContain('1234ms');
    expect(output).toContain('3 learning(s) updated');
    expect(output).toContain('2 merged');
    expect(output).toContain('1 archived');
    expect(output).toContain('5 promoted');
    expect(output).toContain('1 evicted');
    expect(output).toContain('2 decisions');
    expect(output).toContain('4 observations');
    expect(output).toContain('1 links');
    expect(output).toContain('10 processed');
    expect(output).toContain('2 skipped');
    expect(output).toContain('0 errors');
  });

  it('renders without optional steps when skipped', () => {
    const partialData: Record<string, unknown> = {
      duration: 500,
      decay: { affected: 1 },
    };
    const output = renderBrainMaintenance(partialData, false);
    expect(output).toContain('Maintenance complete.');
    expect(output).toContain('500ms');
    expect(output).toContain('1 learning(s) updated');
    expect(output).not.toContain('Consolidation');
    expect(output).not.toContain('Tier promotion');
    expect(output).not.toContain('Reconcile');
    expect(output).not.toContain('Embeddings');
  });

  it('quiet mode returns duration only', () => {
    const output = renderBrainMaintenance(fullData, true);
    expect(output).toBe('1234');
  });

  it('snapshot — full result', () => {
    const output = renderBrainMaintenance(fullData, false);
    expect(output).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// renderBrainBackfill
// ---------------------------------------------------------------------------

describe('renderBrainBackfill', () => {
  const fullData: Record<string, unknown> = {
    before: {
      nodes: 100,
      edges: 50,
      decisions: 20,
      patterns: 15,
      learnings: 30,
      observations: 35,
      stickyNotes: 0,
    },
    nodesInserted: 25,
    stubsCreated: 5,
    edgesInserted: 18,
    after: { nodes: 125, edges: 68 },
    byType: { decision: 20, pattern: 5 },
  };

  it('renders before and after counts', () => {
    const output = renderBrainBackfill(fullData, false);
    expect(output).toContain('Back-fill complete.');
    expect(output).toContain('100 nodes');
    expect(output).toContain('50 edges');
    expect(output).toContain('125 nodes');
    expect(output).toContain('68 edges');
  });

  it('renders insert stats', () => {
    const output = renderBrainBackfill(fullData, false);
    expect(output).toContain('25');
    expect(output).toContain('5 stub nodes');
    expect(output).toContain('18');
  });

  it('renders byType breakdown', () => {
    const output = renderBrainBackfill(fullData, false);
    expect(output).toContain('By type');
    expect(output).toContain('decision');
    expect(output).toContain('pattern');
  });

  it('quiet mode returns nodes inserted', () => {
    const output = renderBrainBackfill(fullData, true);
    expect(output).toBe('25');
  });

  it('snapshot — full result', () => {
    const output = renderBrainBackfill(fullData, false);
    expect(output).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// renderBrainPurge
// ---------------------------------------------------------------------------

describe('renderBrainPurge', () => {
  const fullData: Record<string, unknown> = {
    patternsDeleted: 10,
    learningsDeleted: 25,
    decisionsDeleted: 3,
    observationsDeleted: 8,
    after: { patterns: 5, learnings: 0, decisions: 17, observations: 42 },
    fts5Rebuilt: true,
  };

  it('renders deleted counts', () => {
    const output = renderBrainPurge(fullData, false);
    expect(output).toContain('Purge complete.');
    expect(output).toContain('10');
    expect(output).toContain('25');
    expect(output).toContain('3');
    expect(output).toContain('8');
  });

  it('renders post-purge counts', () => {
    const output = renderBrainPurge(fullData, false);
    expect(output).toContain('Post-purge counts');
    expect(output).toContain('Patterns');
    expect(output).toContain('Observations');
  });

  it('renders FTS5 rebuilt flag', () => {
    const output = renderBrainPurge(fullData, false);
    expect(output).toContain('true');
  });

  it('quiet mode returns total deleted', () => {
    const output = renderBrainPurge(fullData, true);
    // 10 + 25 + 3 + 8 = 46
    expect(output).toBe('46');
  });

  it('snapshot — full result', () => {
    const output = renderBrainPurge(fullData, false);
    expect(output).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// renderBrainPlasticityStats
// ---------------------------------------------------------------------------

describe('renderBrainPlasticityStats', () => {
  const fullData: Record<string, unknown> = {
    totalEvents: 42,
    ltpCount: 30,
    ltdCount: 12,
    netDeltaW: 0.1234,
    lastEventAt: '2026-05-01T10:00:00Z',
    recentEvents: [
      {
        kind: 'ltp',
        sourceNode: 'obs-001',
        targetNode: 'dec-002',
        deltaW: 0.05,
        timestamp: '2026-05-01T10:00:00Z',
      },
    ],
    limit: 20,
  };

  it('renders summary stats', () => {
    const output = renderBrainPlasticityStats(fullData, false);
    expect(output).toContain('Brain Plasticity Stats (STDP)');
    expect(output).toContain('42');
    expect(output).toContain('30');
    expect(output).toContain('12');
    expect(output).toContain('+0.1234');
    expect(output).toContain('2026-05-01T10:00:00Z');
  });

  it('renders recent events', () => {
    const output = renderBrainPlasticityStats(fullData, false);
    expect(output).toContain('Recent Events');
    expect(output).toContain('LTP');
    expect(output).toContain('obs-001');
    expect(output).toContain('dec-002');
  });

  it('renders empty state message when no events', () => {
    const emptyData: Record<string, unknown> = {
      totalEvents: 0,
      ltpCount: 0,
      ltdCount: 0,
      netDeltaW: 0,
      lastEventAt: null,
      recentEvents: [],
      limit: 20,
    };
    const output = renderBrainPlasticityStats(emptyData, false);
    expect(output).toContain('No plasticity events recorded yet.');
    expect(output).toContain('cleo brain maintenance');
  });

  it('quiet mode returns total events', () => {
    const output = renderBrainPlasticityStats(fullData, true);
    expect(output).toBe('42');
  });

  it('snapshot — full result with events', () => {
    const output = renderBrainPlasticityStats(fullData, false);
    expect(output).toMatchSnapshot();
  });

  it('snapshot — empty result', () => {
    const emptyData: Record<string, unknown> = {
      totalEvents: 0,
      ltpCount: 0,
      ltdCount: 0,
      netDeltaW: 0,
      lastEventAt: null,
      recentEvents: [],
      limit: 20,
    };
    const output = renderBrainPlasticityStats(emptyData, false);
    expect(output).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// renderBrainQuality
// ---------------------------------------------------------------------------

describe('renderBrainQuality', () => {
  const fullData: Record<string, unknown> = {
    totalRetrievals: 500,
    uniqueEntriesRetrieved: 80,
    usageRate: 0.75,
    noiseRatio: 0.12,
    qualityDistribution: { low: 10, medium: 30, high: 40 },
    tierDistribution: { short: 20, medium: 35, long: 25, unknown: 0 },
    topRetrieved: [
      { citationCount: 15, id: 'O-001', title: 'Key architectural decision on brain design' },
      { citationCount: 10, id: 'D-002', title: 'Resolved: migration strategy for v2' },
    ],
    neverRetrieved: [{ qualityScore: 0.2, id: 'O-099', title: 'Old stale note from onboarding' }],
  };

  it('renders summary metrics', () => {
    const output = renderBrainQuality(fullData, false);
    expect(output).toContain('Brain Memory Quality Report');
    expect(output).toContain('500');
    expect(output).toContain('80');
    expect(output).toContain('75.0%');
    expect(output).toContain('12.0%');
  });

  it('renders quality distribution', () => {
    const output = renderBrainQuality(fullData, false);
    expect(output).toContain('Quality Distribution');
    expect(output).toContain('Low');
    expect(output).toContain('Med');
    expect(output).toContain('High');
  });

  it('renders tier distribution', () => {
    const output = renderBrainQuality(fullData, false);
    expect(output).toContain('Tier Distribution');
    expect(output).toContain('Short');
    expect(output).toContain('Medium');
    expect(output).toContain('Long');
  });

  it('renders top retrieved entries', () => {
    const output = renderBrainQuality(fullData, false);
    expect(output).toContain('Top 10 Most Retrieved');
    expect(output).toContain('[15x]');
    expect(output).toContain('O-001');
    expect(output).toContain('Key architectural decision');
  });

  it('renders never retrieved entries', () => {
    const output = renderBrainQuality(fullData, false);
    expect(output).toContain('Never Retrieved');
    expect(output).toContain('O-099');
    expect(output).toContain('0.20');
  });

  it('does not render unknown tier when 0', () => {
    const output = renderBrainQuality(fullData, false);
    expect(output).not.toContain('Unknown');
  });

  it('quiet mode returns usage rate', () => {
    const output = renderBrainQuality(fullData, true);
    expect(output).toBe('75.0%');
  });

  it('snapshot — full report', () => {
    const output = renderBrainQuality(fullData, false);
    expect(output).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// renderBrainExport
// ---------------------------------------------------------------------------

describe('renderBrainExport', () => {
  const fullData: Record<string, unknown> = {
    outputFile: '/tmp/brain-export.gexf',
    nodeCount: 150,
    edgeCount: 300,
    format: 'gexf',
  };

  it('renders export confirmation with file path', () => {
    const output = renderBrainExport(fullData, false);
    expect(output).toContain('/tmp/brain-export.gexf');
    expect(output).toContain('150 nodes');
    expect(output).toContain('300 edges');
    expect(output).toContain('GEXF');
  });

  it('renders JSON format correctly', () => {
    const jsonData: Record<string, unknown> = {
      outputFile: '/tmp/brain-export.json',
      nodeCount: 50,
      edgeCount: 80,
      format: 'json',
    };
    const output = renderBrainExport(jsonData, false);
    expect(output).toContain('JSON');
  });

  it('quiet mode returns output file path', () => {
    const output = renderBrainExport(fullData, true);
    expect(output).toBe('/tmp/brain-export.gexf');
  });

  it('snapshot — GEXF export', () => {
    const output = renderBrainExport(fullData, false);
    expect(output).toMatchSnapshot();
  });
});
