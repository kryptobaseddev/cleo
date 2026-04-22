/**
 * Tests for priority color and blocker indicator rendering in renderTreeNodes (T1200).
 *
 * These tests cover:
 * - Priority colors: critical=RED, high=YELLOW, medium=no extra color, low=DIM
 * - Blocker indicator for tasks blocked by open deps: ⊗(N)
 * - Ready indicator for immediately actionable tasks: ●
 * - Quiet mode is unaffected by priority/blocker data
 * - JSON/markdown output modes are unaffected (renderTree passes tree data
 *   through unchanged; indicators are terminal-only in renderTreeNodes)
 *
 * @task T1200
 * @epic T1187
 */

import { describe, expect, it } from 'vitest';
import { renderTree } from '../system.js';

// ---------------------------------------------------------------------------
// Helpers: build minimal FlatTreeNode-shaped objects
// ---------------------------------------------------------------------------

/**
 * Build a minimal node with the dependency metadata fields introduced in T1199.
 * Fields default to no-deps, medium priority, pending status.
 */
function makeNode(
  overrides: {
    id?: string;
    title?: string;
    status?: string;
    priority?: string;
    depends?: string[];
    blockedBy?: string[];
    ready?: boolean;
    children?: Record<string, unknown>[];
  } = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? 'T001',
    title: overrides.title ?? 'Test task',
    status: overrides.status ?? 'pending',
    priority: overrides.priority ?? 'medium',
    depends: overrides.depends ?? [],
    blockedBy: overrides.blockedBy ?? [],
    ready: overrides.ready ?? true,
    children: overrides.children ?? [],
  };
}

// ---------------------------------------------------------------------------
// Priority color rendering
// ---------------------------------------------------------------------------

describe('renderTreeNodes — priority colors (T1200)', () => {
  // NOTE: ANSI color codes are disabled in the test environment (no TTY /
  // FORCE_COLOR not set).  These tests verify the structural rendering —
  // that each priority level's title text is present and positioned correctly.
  // Color emission is tested indirectly via the priorityColor unit in colors.ts.

  it('critical priority: title is included in the output line', () => {
    const data = {
      tree: [makeNode({ id: 'T001', priority: 'critical', title: 'Critical task' })],
    };
    const output = renderTree(data, false);
    expect(output).toContain('T001');
    expect(output).toContain('Critical task');
  });

  it('high priority: title is included in the output line', () => {
    const data = {
      tree: [makeNode({ id: 'T001', priority: 'high', title: 'High task' })],
    };
    const output = renderTree(data, false);
    expect(output).toContain('T001');
    expect(output).toContain('High task');
  });

  it('medium priority: title is included in the output line', () => {
    const data = {
      tree: [makeNode({ id: 'T001', priority: 'medium', title: 'Medium task', ready: false })],
    };
    const output = renderTree(data, false);
    expect(output).toContain('T001');
    expect(output).toContain('Medium task');
  });

  it('low priority: title is included in the output line', () => {
    const data = {
      tree: [makeNode({ id: 'T001', priority: 'low', title: 'Low task' })],
    };
    const output = renderTree(data, false);
    expect(output).toContain('T001');
    expect(output).toContain('Low task');
  });

  it('quiet mode does not emit ANSI codes regardless of priority', () => {
    const data = {
      tree: [makeNode({ id: 'T001', priority: 'critical', title: 'Critical task' })],
    };
    const output = renderTree(data, true);
    // Quiet mode: no ANSI codes
    expect(output).not.toMatch(/\x1b\[/);
    // ID is present
    expect(output).toContain('T001');
  });
});

// ---------------------------------------------------------------------------
// Blocker indicator rendering
// ---------------------------------------------------------------------------

describe('renderTreeNodes — blocker indicators (T1200)', () => {
  it('shows ⊗ indicator when task has open deps', () => {
    const data = {
      tree: [
        makeNode({
          id: 'T002',
          blockedBy: ['T001'],
          ready: false,
          status: 'pending',
        }),
      ],
    };
    const output = renderTree(data, false);
    expect(output).toContain('⊗(1)');
  });

  it('shows dep count in ⊗(N) indicator — 3 blockers', () => {
    const data = {
      tree: [
        makeNode({
          id: 'T005',
          blockedBy: ['T001', 'T002', 'T003'],
          ready: false,
          status: 'pending',
        }),
      ],
    };
    const output = renderTree(data, false);
    expect(output).toContain('⊗(3)');
  });

  it('shows ● indicator when task is ready (no open deps, pending)', () => {
    const data = {
      tree: [
        makeNode({
          id: 'T003',
          blockedBy: [],
          ready: true,
          status: 'pending',
        }),
      ],
    };
    const output = renderTree(data, false);
    expect(output).toContain('●');
    expect(output).not.toContain('⊗');
  });

  it('shows no indicator for done tasks', () => {
    const data = {
      tree: [
        makeNode({
          id: 'T004',
          blockedBy: [],
          ready: false, // done tasks are not ready
          status: 'done',
        }),
      ],
    };
    const output = renderTree(data, false);
    expect(output).not.toContain('⊗');
    expect(output).not.toContain('●');
  });

  it('⊗(N) indicator appears on the same line as the task ID', () => {
    // ANSI codes are disabled in test (no TTY). Verify the symbol is present.
    const data = {
      tree: [
        makeNode({
          id: 'T002',
          blockedBy: ['T001'],
          ready: false,
        }),
      ],
    };
    const output = renderTree(data, false);
    expect(output).toContain('⊗(1)');
    // Symbol and ID appear on the same line
    const line = output.split('\n').find((l) => l.includes('T002'));
    expect(line).toBeDefined();
    expect(line).toContain('⊗(1)');
  });

  it('● indicator appears on the same line as the task ID', () => {
    // ANSI codes are disabled in test (no TTY). Verify the symbol is present.
    const data = {
      tree: [
        makeNode({
          id: 'T003',
          blockedBy: [],
          ready: true,
          status: 'pending',
        }),
      ],
    };
    const output = renderTree(data, false);
    expect(output).toContain('●');
    const line = output.split('\n').find((l) => l.includes('T003'));
    expect(line).toBeDefined();
    expect(line).toContain('●');
  });

  it('quiet mode does not show blocker indicators', () => {
    const data = {
      tree: [
        makeNode({
          id: 'T002',
          blockedBy: ['T001'],
          ready: false,
        }),
      ],
    };
    const output = renderTree(data, true);
    expect(output).not.toContain('⊗');
    expect(output).not.toContain('●');
    expect(output).toContain('T002');
  });

  it('quiet mode does not show ready indicator', () => {
    const data = {
      tree: [
        makeNode({
          id: 'T003',
          blockedBy: [],
          ready: true,
        }),
      ],
    };
    const output = renderTree(data, true);
    expect(output).not.toContain('●');
    expect(output).toContain('T003');
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility: nodes without T1199 fields
// ---------------------------------------------------------------------------

describe('renderTreeNodes — backward compat (nodes without T1199 fields)', () => {
  it('renders correctly when blockedBy and ready are undefined', () => {
    // Legacy nodes that predate T1199 won't have blockedBy/ready
    const data = {
      tree: [
        {
          id: 'T001',
          title: 'Legacy node',
          status: 'pending',
          children: [],
          // no priority, blockedBy, ready
        },
      ],
    };
    const output = renderTree(data, false);
    expect(output).toContain('T001');
    expect(output).toContain('Legacy node');
    // No crash, no spurious indicator
    expect(output).not.toContain('⊗');
    expect(output).not.toContain('●');
  });
});

// ---------------------------------------------------------------------------
// JSON / markdown output modes unaffected
// ---------------------------------------------------------------------------

describe('renderTree — JSON/markdown unchanged (T1200)', () => {
  it('tree data payload is passed through unmodified — no indicator strings injected', () => {
    // renderTree returns a string; the *input* data object should not be mutated.
    const nodeData = makeNode({
      id: 'T001',
      blockedBy: ['T002'],
      ready: false,
    });
    const dataBefore = JSON.stringify(nodeData);
    renderTree({ tree: [nodeData] }, false);
    // Data object must not have been mutated
    expect(JSON.stringify(nodeData)).toBe(dataBefore);
  });
});
