/**
 * Tests for the exported renderWaves function (T1201).
 *
 * Covers all four output modes:
 * - rich (default): ANSI wave headers, status badges, task lines with priority
 *   color and blocker indicators.
 * - json: passthrough { waves } as JSON string.
 * - markdown: GFM `## Wave N — status\n- [status] ID Title`.
 * - quiet: `<waveNumber>\t<taskId>` per line.
 *
 * Also covers:
 * - renderTree delegates to renderWaves when data.waves present.
 * - Existing callers unchanged.
 * - Empty waves array handled gracefully.
 * - String task entries (non-enriched wave format).
 *
 * @task T1201
 * @epic T1187
 */

import { describe, expect, it } from 'vitest';
import { renderTree, renderWaves } from '../system.js';

// ---------------------------------------------------------------------------
// Sample wave data
// ---------------------------------------------------------------------------

/** Enriched waves with all T1202 fields populated. */
const sampleWaves = [
  {
    waveNumber: 1,
    status: 'completed',
    tasks: [
      {
        id: 'T001',
        title: 'Implement auth',
        status: 'done',
        priority: 'critical',
        depends: [],
        blockedBy: [],
        ready: false,
      },
      {
        id: 'T002',
        title: 'Setup DB',
        status: 'done',
        priority: 'high',
        depends: [],
        blockedBy: [],
        ready: false,
      },
    ],
    completedAt: '2026-01-10T00:00:00Z',
  },
  {
    waveNumber: 2,
    status: 'in_progress',
    tasks: [
      {
        id: 'T003',
        title: 'Build UI',
        status: 'active',
        priority: 'medium',
        depends: ['T001'],
        blockedBy: [],
        ready: false,
      },
    ],
  },
  {
    waveNumber: 3,
    status: 'pending',
    tasks: [
      {
        id: 'T004',
        title: 'Write tests',
        status: 'pending',
        priority: 'low',
        depends: ['T003'],
        blockedBy: ['T003'],
        ready: false,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Rich mode (default)
// ---------------------------------------------------------------------------

describe('renderWaves — rich mode (T1201)', () => {
  it('renders wave headers with wave numbers', () => {
    const output = renderWaves({ waves: sampleWaves });
    expect(output).toContain('Wave 1');
    expect(output).toContain('Wave 2');
    expect(output).toContain('Wave 3');
  });

  it('renders status badges: completed, in_progress, pending', () => {
    const output = renderWaves({ waves: sampleWaves });
    expect(output).toContain('completed');
    expect(output).toContain('in_progress');
    expect(output).toContain('pending');
  });

  it('renders task IDs and titles', () => {
    const output = renderWaves({ waves: sampleWaves });
    expect(output).toContain('T001');
    expect(output).toContain('Implement auth');
    expect(output).toContain('T004');
    expect(output).toContain('Write tests');
  });

  it('shows blocker indicator ⊗(N) for blocked tasks', () => {
    const output = renderWaves({ waves: sampleWaves });
    // T004 has blockedBy: ['T003'] → ⊗(1)
    expect(output).toContain('⊗(1)');
  });

  it('shows ready indicator ● for ready tasks', () => {
    // T003 has blockedBy: [] and status: active → not ready (active not pending)
    // Use a wave with a genuinely ready task.
    const readyWaves = [
      {
        waveNumber: 1,
        status: 'pending',
        tasks: [
          {
            id: 'T010',
            title: 'Ready task',
            status: 'pending',
            priority: 'medium',
            depends: [],
            blockedBy: [],
            ready: true,
          },
        ],
      },
    ];
    const output = renderWaves({ waves: readyWaves });
    expect(output).toContain('●');
    expect(output).not.toContain('⊗');
  });

  it('renders empty wave as "(no tasks)" placeholder', () => {
    const emptyWave = [{ waveNumber: 1, status: 'pending', tasks: [] }];
    const output = renderWaves({ waves: emptyWave });
    expect(output).toContain('(no tasks)');
  });

  it('handles string task entries (non-enriched format)', () => {
    const data = { waves: [{ waveNumber: 1, status: 'pending', tasks: ['T010', 'T011'] }] };
    const output = renderWaves(data);
    expect(output).toContain('T010');
    expect(output).toContain('T011');
  });

  it('defaults to rich mode when opts is omitted', () => {
    const output = renderWaves({ waves: sampleWaves });
    // Rich mode includes wave header — not a plain tab-separated line.
    expect(output).not.toMatch(/^\d+\t/m);
    expect(output).toContain('Wave 1');
  });

  it('returns "No wave data." when waves is absent', () => {
    const output = renderWaves({});
    expect(output).toBe('No wave data.');
  });
});

// ---------------------------------------------------------------------------
// JSON mode
// ---------------------------------------------------------------------------

describe('renderWaves — json mode (T1201)', () => {
  it('returns parseable JSON with waves array', () => {
    const output = renderWaves({ waves: sampleWaves }, { mode: 'json' });
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('waves');
    expect(Array.isArray(parsed.waves)).toBe(true);
    expect(parsed.waves).toHaveLength(3);
  });

  it('wave tasks are preserved in JSON output', () => {
    const output = renderWaves({ waves: sampleWaves }, { mode: 'json' });
    const parsed = JSON.parse(output);
    const allIds = parsed.waves.flatMap((w: { tasks: Array<{ id: string }> }) =>
      w.tasks.map((t) => t.id),
    );
    expect(allIds).toContain('T001');
    expect(allIds).toContain('T004');
  });

  it('returns JSON string for empty waves', () => {
    const output = renderWaves({ waves: [] }, { mode: 'json' });
    const parsed = JSON.parse(output);
    expect(parsed.waves).toEqual([]);
  });

  it('returns "No wave data." when waves absent in json mode', () => {
    const output = renderWaves({}, { mode: 'json' });
    expect(output).toBe('No wave data.');
  });
});

// ---------------------------------------------------------------------------
// Markdown mode
// ---------------------------------------------------------------------------

describe('renderWaves — markdown mode (T1201)', () => {
  it('renders ## Wave N headers', () => {
    const output = renderWaves({ waves: sampleWaves }, { mode: 'markdown' });
    expect(output).toContain('## Wave 1');
    expect(output).toContain('## Wave 2');
    expect(output).toContain('## Wave 3');
  });

  it('includes status in wave header', () => {
    const output = renderWaves({ waves: sampleWaves }, { mode: 'markdown' });
    expect(output).toContain('## Wave 1 — completed');
    expect(output).toContain('## Wave 2 — in_progress');
    expect(output).toContain('## Wave 3 — pending');
  });

  it('renders task list items with [status] prefix', () => {
    const output = renderWaves({ waves: sampleWaves }, { mode: 'markdown' });
    expect(output).toContain('- [done] T001 Implement auth');
    expect(output).toContain('- [active] T003 Build UI');
    expect(output).toContain('- [pending] T004 Write tests');
  });

  it('does NOT contain ANSI escape codes', () => {
    const output = renderWaves({ waves: sampleWaves }, { mode: 'markdown' });
    expect(output).not.toMatch(/\x1b\[/);
  });

  it('does NOT contain blocker indicators (⊗/●)', () => {
    const output = renderWaves({ waves: sampleWaves }, { mode: 'markdown' });
    expect(output).not.toContain('⊗');
    expect(output).not.toContain('●');
  });

  it('renders empty wave as _No tasks in this wave._', () => {
    const emptyWave = [{ waveNumber: 1, status: 'pending', tasks: [] }];
    const output = renderWaves({ waves: emptyWave }, { mode: 'markdown' });
    expect(output).toContain('_No tasks in this wave._');
  });

  it('handles string task entries', () => {
    const data = { waves: [{ waveNumber: 1, status: 'pending', tasks: ['T010', 'T011'] }] };
    const output = renderWaves(data, { mode: 'markdown' });
    expect(output).toContain('- T010');
    expect(output).toContain('- T011');
  });

  it('returns "No wave data." when waves absent', () => {
    const output = renderWaves({}, { mode: 'markdown' });
    expect(output).toBe('No wave data.');
  });
});

// ---------------------------------------------------------------------------
// Quiet mode
// ---------------------------------------------------------------------------

describe('renderWaves — quiet mode (T1201)', () => {
  it('emits <waveNumber>\\t<taskId> per line', () => {
    const output = renderWaves({ waves: sampleWaves }, { mode: 'quiet' });
    const lines = output.split('\n').filter(Boolean);
    expect(lines).toContain('1\tT001');
    expect(lines).toContain('1\tT002');
    expect(lines).toContain('2\tT003');
    expect(lines).toContain('3\tT004');
  });

  it('emits no ANSI escape codes', () => {
    const output = renderWaves({ waves: sampleWaves }, { mode: 'quiet' });
    expect(output).not.toMatch(/\x1b\[/);
  });

  it('emits no wave headers or status badges', () => {
    const output = renderWaves({ waves: sampleWaves }, { mode: 'quiet' });
    expect(output).not.toContain('Wave 1');
    expect(output).not.toContain('completed');
    expect(output).not.toContain('in_progress');
  });

  it('emits no blocker indicators', () => {
    const output = renderWaves({ waves: sampleWaves }, { mode: 'quiet' });
    expect(output).not.toContain('⊗');
    expect(output).not.toContain('●');
  });

  it('handles string task entries', () => {
    const data = { waves: [{ waveNumber: 1, status: 'pending', tasks: ['T010', 'T011'] }] };
    const output = renderWaves(data, { mode: 'quiet' });
    const lines = output.split('\n').filter(Boolean);
    expect(lines).toContain('1\tT010');
    expect(lines).toContain('1\tT011');
  });

  it('returns empty string when waves absent', () => {
    const output = renderWaves({}, { mode: 'quiet' });
    expect(output).toBe('');
  });
});

// ---------------------------------------------------------------------------
// renderTree delegation
// ---------------------------------------------------------------------------

describe('renderTree — delegates to renderWaves (T1201)', () => {
  it('quiet=false: produces wave header + rich body', () => {
    const data = { waves: sampleWaves, epicId: 'T100', totalWaves: 3, totalTasks: 4 };
    const output = renderTree(data, false);
    expect(output).toContain('Waves for T100');
    expect(output).toContain('Wave 1');
    expect(output).toContain('T001');
  });

  it('quiet=true: emits <waveNumber>\\t<taskId> lines', () => {
    const data = { waves: sampleWaves };
    const output = renderTree(data, true);
    const lines = output.split('\n').filter(Boolean);
    expect(lines).toContain('1\tT001');
    expect(lines).toContain('2\tT003');
  });

  it('quiet=true: no ANSI codes', () => {
    const data = { waves: sampleWaves };
    const output = renderTree(data, true);
    expect(output).not.toMatch(/\x1b\[/);
  });

  it('existing tree rendering unaffected when no waves', () => {
    const data = {
      tree: [{ id: 'T999', title: 'Root', status: 'pending', children: [] }],
    };
    const output = renderTree(data, false);
    expect(output).toContain('T999');
    expect(output).not.toContain('Wave');
  });

  it('existing flat task fallback unaffected', () => {
    const data = { tasks: [{ id: 'T888', title: 'Flat task', status: 'pending' }] };
    const output = renderTree(data as Record<string, unknown>, false);
    expect(output).toContain('T888');
    expect(output).not.toContain('Wave');
  });
});
