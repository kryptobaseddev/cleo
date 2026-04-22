/**
 * Tests for system.ts renderer functions.
 *
 * Covers:
 * - T1194: renderTree handles data.waves (no "No tree data." fallthrough)
 * - T1195: orchestrate key in renderer registry routes to renderTree
 * - T1198: quiet mode in renderTreeNodes preserves tree connectors
 *
 * @task T1194
 * @task T1195
 * @task T1198
 * @epic T1188
 */

import { describe, expect, it } from 'vitest';
import { renderTree } from '../system.js';

// ---------------------------------------------------------------------------
// T1194: renderTree handles data.waves
// ---------------------------------------------------------------------------

describe('renderTree — waves branch (T1194)', () => {
  const sampleWaves = [
    {
      waveNumber: 1,
      status: 'completed',
      tasks: [
        { id: 'T001', title: 'Implement auth', status: 'done' },
        { id: 'T002', title: 'Setup DB', status: 'done' },
      ],
    },
    {
      waveNumber: 2,
      status: 'in_progress',
      tasks: [{ id: 'T003', title: 'Build UI', status: 'active' }],
    },
    {
      waveNumber: 3,
      status: 'pending',
      tasks: [{ id: 'T004', title: 'Write tests', status: 'pending' }],
    },
  ];

  it('renders wave header with epicId and counts', () => {
    const data = { waves: sampleWaves, epicId: 'T100', totalWaves: 3, totalTasks: 4 };
    const output = renderTree(data, false);
    expect(output).toContain('Waves for T100');
    expect(output).toContain('3 waves');
    expect(output).toContain('4 tasks');
  });

  it('renders wave numbers', () => {
    const data = { waves: sampleWaves, epicId: 'T100' };
    const output = renderTree(data, false);
    expect(output).toContain('Wave 1');
    expect(output).toContain('Wave 2');
    expect(output).toContain('Wave 3');
  });

  it('renders task IDs within waves', () => {
    const data = { waves: sampleWaves, epicId: 'T100' };
    const output = renderTree(data, false);
    expect(output).toContain('T001');
    expect(output).toContain('T003');
    expect(output).toContain('T004');
  });

  it('shows status badge for completed wave', () => {
    const data = { waves: sampleWaves, epicId: 'T100' };
    const output = renderTree(data, false);
    expect(output).toContain('completed');
  });

  it('shows status badge for in_progress wave', () => {
    const data = { waves: sampleWaves, epicId: 'T100' };
    const output = renderTree(data, false);
    expect(output).toContain('in_progress');
  });

  it('shows status badge for pending wave', () => {
    const data = { waves: sampleWaves, epicId: 'T100' };
    const output = renderTree(data, false);
    expect(output).toContain('pending');
  });

  it('does NOT return "No tree data." when waves is present', () => {
    const data = { waves: sampleWaves };
    const output = renderTree(data, false);
    expect(output).not.toContain('No tree data.');
  });

  it('quiet mode emits <waveNumber>\\t<taskId> per line (T1201)', () => {
    // T1201 upgraded quiet mode to include the wave number for script-extractability.
    // Format: "<waveNumber>\t<taskId>" — one line per task across all waves.
    const data = { waves: sampleWaves };
    const output = renderTree(data, true);
    const lines = output.split('\n').filter(Boolean);
    expect(lines).toContain('1\tT001');
    expect(lines).toContain('1\tT002');
    expect(lines).toContain('2\tT003');
    expect(lines).toContain('3\tT004');
  });

  it('quiet mode emits no ANSI decorations', () => {
    const data = { waves: sampleWaves };
    const output = renderTree(data, true);
    expect(output).not.toMatch(/\x1b\[/);
  });

  it('handles empty waves array gracefully', () => {
    const data = { waves: [], epicId: 'T999', totalWaves: 0, totalTasks: 0 };
    const output = renderTree(data, false);
    expect(output).toContain('Waves for T999');
    expect(output).not.toContain('No tree data.');
  });

  it('renders "Execution Waves" header when no epicId provided', () => {
    const data = { waves: sampleWaves };
    const output = renderTree(data, false);
    expect(output).toContain('Execution Waves');
  });

  it('handles string task entries (non-enriched wave format)', () => {
    const data = {
      waves: [{ waveNumber: 1, status: 'pending', tasks: ['T010', 'T011'] }],
    };
    const output = renderTree(data, false);
    expect(output).toContain('T010');
    expect(output).toContain('T011');
  });

  it('quiet mode handles string task entries (T1201 format)', () => {
    // T1201: quiet mode now emits "<waveNumber>\t<taskId>" for string tasks too.
    const data = {
      waves: [{ waveNumber: 1, status: 'pending', tasks: ['T010', 'T011'] }],
    };
    const output = renderTree(data, true);
    const lines = output.split('\n').filter(Boolean);
    expect(lines).toContain('1\tT010');
    expect(lines).toContain('1\tT011');
  });
});

// ---------------------------------------------------------------------------
// T1194 + T1195: tree and tasks fallbacks still work
// ---------------------------------------------------------------------------

describe('renderTree — tree and tasks fallbacks', () => {
  it('renders tree data when waves absent', () => {
    const data = {
      tree: [
        {
          id: 'T001',
          title: 'Root',
          status: 'pending',
          children: [{ id: 'T002', title: 'Child', status: 'active', children: [] }],
        },
      ],
    };
    const output = renderTree(data, false);
    expect(output).toContain('T001');
    expect(output).toContain('T002');
    expect(output).not.toContain('No tree data.');
  });

  it('renders flat tasks when neither tree nor waves present', () => {
    const data = {
      tasks: [
        { id: 'T005', title: 'Task five', status: 'pending' },
        { id: 'T006', title: 'Task six', status: 'done' },
      ],
    };
    const output = renderTree(data as Record<string, unknown>, false);
    expect(output).toContain('T005');
    expect(output).toContain('T006');
    expect(output).not.toContain('No tree data.');
  });

  it('returns "No tree data." when all branches absent', () => {
    const output = renderTree({}, false);
    expect(output).toBe('No tree data.');
  });

  it('returns empty string in quiet mode when no data', () => {
    const output = renderTree({}, true);
    expect(output).toBe('');
  });
});

// ---------------------------------------------------------------------------
// T1198: quiet mode tree connectors
// ---------------------------------------------------------------------------

describe('renderTreeNodes quiet mode — connectors preserved (T1198)', () => {
  it('quiet mode includes tree connectors (└── or ├──)', () => {
    const data = {
      tree: [
        {
          id: 'T001',
          title: 'Root task',
          status: 'pending',
          children: [
            { id: 'T002', title: 'First child', status: 'pending', children: [] },
            { id: 'T003', title: 'Last child', status: 'pending', children: [] },
          ],
        },
      ],
    };
    const output = renderTree(data, true);
    // Connectors must appear
    expect(output).toMatch(/[├└]/);
  });

  it('quiet mode: last child uses └── connector', () => {
    const data = {
      tree: [
        {
          id: 'T001',
          title: 'Root',
          status: 'pending',
          children: [{ id: 'T002', title: 'Only child', status: 'pending', children: [] }],
        },
      ],
    };
    const output = renderTree(data, true);
    // The only child is the last, so its connector is └──
    expect(output).toContain('└');
    // ID must appear after connector on the same line
    const lines = output.split('\n');
    const childLine = lines.find((l) => l.includes('T002'));
    expect(childLine).toBeDefined();
    expect(childLine).toMatch(/└.*T002/);
  });

  it('quiet mode: non-last child uses ├── connector', () => {
    const data = {
      tree: [
        {
          id: 'T001',
          title: 'Root',
          status: 'pending',
          children: [
            { id: 'T002', title: 'First', status: 'pending', children: [] },
            { id: 'T003', title: 'Last', status: 'pending', children: [] },
          ],
        },
      ],
    };
    const output = renderTree(data, true);
    const lines = output.split('\n');
    const firstChildLine = lines.find((l) => l.includes('T002'));
    expect(firstChildLine).toMatch(/├.*T002/);
  });

  it('quiet mode: IDs are the last word on each line (script-extractable)', () => {
    const data = {
      tree: [
        {
          id: 'T001',
          title: 'Root',
          status: 'pending',
          children: [{ id: 'T002', title: 'Child', status: 'pending', children: [] }],
        },
      ],
    };
    const output = renderTree(data, true);
    const lines = output.split('\n').filter(Boolean);
    for (const line of lines) {
      // Strip ANSI escapes and trim — last token should be a task ID
      const stripped = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
      // Each line ends with a task ID matching T\d+
      expect(stripped).toMatch(/T\d+$/);
    }
  });

  it('quiet mode: no task titles in output', () => {
    const data = {
      tree: [
        {
          id: 'T001',
          title: 'Should not appear',
          status: 'pending',
          children: [],
        },
      ],
    };
    const output = renderTree(data, true);
    expect(output).not.toContain('Should not appear');
  });
});
