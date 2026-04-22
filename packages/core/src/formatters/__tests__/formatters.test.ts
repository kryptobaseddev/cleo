/**
 * Unit tests for core formatters — formatTree and formatWaves (T1203).
 *
 * Covers all four output modes (rich, json, markdown, quiet) for both
 * formatters.  Tests run without any ANSI injection so output is plain
 * text — the colorize callback is tested separately.
 *
 * @task T1203
 * @epic T1191
 */

import { describe, expect, it } from 'vitest';
import { type FlatTreeNode, formatTree } from '../tree.js';
import { type EnrichedWave, formatWaves } from '../waves.js';

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const sampleNodes: FlatTreeNode[] = [
  {
    id: 'T001',
    title: 'Auth',
    status: 'done',
    priority: 'critical',
    blockedBy: [],
    ready: false,
    children: [
      {
        id: 'T002',
        title: 'Login page',
        status: 'active',
        priority: 'high',
        blockedBy: [],
        ready: true,
      },
    ],
  },
  {
    id: 'T003',
    title: 'Database',
    status: 'pending',
    priority: 'low',
    blockedBy: ['T001'],
    ready: false,
  },
];

const sampleWaves: EnrichedWave[] = [
  {
    waveNumber: 1,
    status: 'completed',
    tasks: [
      {
        id: 'T001',
        title: 'Implement auth',
        status: 'done',
        priority: 'critical',
        blockedBy: [],
        ready: false,
      },
      {
        id: 'T002',
        title: 'Setup DB',
        status: 'done',
        priority: 'high',
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
        blockedBy: ['T003'],
        ready: false,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// formatTree — json mode
// ---------------------------------------------------------------------------

describe('formatTree — json mode (T1203)', () => {
  it('returns parseable JSON with tree array', () => {
    const out = formatTree(sampleNodes, { mode: 'json' });
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('tree');
    expect(Array.isArray(parsed.tree)).toBe(true);
    expect(parsed.tree).toHaveLength(2);
  });

  it('preserves nested children in JSON output', () => {
    const out = formatTree(sampleNodes, { mode: 'json' });
    const parsed = JSON.parse(out);
    expect(parsed.tree[0].children).toHaveLength(1);
    expect(parsed.tree[0].children[0].id).toBe('T002');
  });

  it('returns JSON for empty nodes array', () => {
    const out = formatTree([], { mode: 'json' });
    const parsed = JSON.parse(out);
    expect(parsed.tree).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatTree — markdown mode
// ---------------------------------------------------------------------------

describe('formatTree — markdown mode (T1203)', () => {
  it('renders top-level nodes as list items with [status]', () => {
    const out = formatTree(sampleNodes, { mode: 'markdown' });
    expect(out).toContain('- [done] T001 Auth');
    expect(out).toContain('- [pending] T003 Database');
  });

  it('renders children indented by 2 spaces', () => {
    const out = formatTree(sampleNodes, { mode: 'markdown' });
    expect(out).toContain('  - [active] T002 Login page');
  });

  it('does NOT contain ANSI escape codes', () => {
    const out = formatTree(sampleNodes, { mode: 'markdown' });
    expect(out).not.toMatch(/\x1b\[/);
  });

  it('returns "No tree data." for empty array', () => {
    const out = formatTree([], { mode: 'markdown' });
    expect(out).toBe('No tree data.');
  });
});

// ---------------------------------------------------------------------------
// formatTree — quiet mode
// ---------------------------------------------------------------------------

describe('formatTree — quiet mode (T1203)', () => {
  it('includes IDs as the last token on each line', () => {
    const out = formatTree(sampleNodes, { mode: 'quiet' });
    const lines = out.split('\n').filter(Boolean);
    // Each line ends with the ID
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const lastToken = parts[parts.length - 1];
      expect(['T001', 'T002', 'T003']).toContain(lastToken);
    }
  });

  it('preserves tree connector characters so hierarchy is visible', () => {
    const out = formatTree(sampleNodes, { mode: 'quiet' });
    // Root nodes use branch or last connector
    expect(out).toMatch(/[├└]/);
  });

  it('does NOT include titles or status symbols', () => {
    const out = formatTree(sampleNodes, { mode: 'quiet' });
    expect(out).not.toContain('Auth');
    expect(out).not.toContain('Database');
    expect(out).not.toContain('Login page');
  });

  it('does NOT emit ANSI escape codes', () => {
    const out = formatTree(sampleNodes, { mode: 'quiet' });
    expect(out).not.toMatch(/\x1b\[/);
  });

  it('returns empty string for empty array', () => {
    const out = formatTree([], { mode: 'quiet' });
    expect(out).toBe('');
  });
});

// ---------------------------------------------------------------------------
// formatTree — rich mode
// ---------------------------------------------------------------------------

describe('formatTree — rich mode (T1203)', () => {
  it('includes task IDs and titles', () => {
    const out = formatTree(sampleNodes, { mode: 'rich' });
    expect(out).toContain('T001');
    expect(out).toContain('Auth');
    expect(out).toContain('T003');
    expect(out).toContain('Database');
  });

  it('includes status symbols', () => {
    const out = formatTree(sampleNodes, { mode: 'rich' });
    // done → ✓, pending → ○, active → ●
    expect(out).toContain('✓');
    expect(out).toContain('○');
  });

  it('shows blocker indicator ⊗(N) for blocked nodes', () => {
    const out = formatTree(sampleNodes, { mode: 'rich' });
    // T003 has blockedBy: ['T001']
    expect(out).toContain('⊗(1)');
  });

  it('shows ready indicator ● for ready nodes', () => {
    const out = formatTree(sampleNodes, { mode: 'rich' });
    // T002 has ready: true
    expect(out).toContain(' ● ');
  });

  it('renders children indented under parent', () => {
    const out = formatTree(sampleNodes, { mode: 'rich' });
    const lines = out.split('\n');
    const t001Line = lines.findIndex((l) => l.includes('T001'));
    const t002Line = lines.findIndex((l) => l.includes('T002'));
    // T002 is a child, so it appears after T001
    expect(t002Line).toBeGreaterThan(t001Line);
  });

  it('returns "No tree data." for empty array', () => {
    const out = formatTree([], { mode: 'rich' });
    expect(out).toBe('No tree data.');
  });

  it('defaults to rich mode when opts omitted', () => {
    const out = formatTree(sampleNodes);
    expect(out).toContain('T001');
    expect(out).toContain('✓');
  });
});

// ---------------------------------------------------------------------------
// formatTree — colorize injection
// ---------------------------------------------------------------------------

describe('formatTree — colorize injection (T1203)', () => {
  it('passes style tokens to colorize callback', () => {
    const stylesApplied: string[] = [];
    const out = formatTree(sampleNodes, {
      mode: 'rich',
      colorize: (text, style) => {
        stylesApplied.push(style);
        return `[${style}:${text}]`;
      },
    });
    // bold applied to IDs
    expect(stylesApplied).toContain('bold');
    // priority color applied (critical → red)
    expect(stylesApplied).toContain('red');
    // low → dim
    expect(stylesApplied).toContain('dim');
    // blocker → red
    expect(out).toContain('[red:⊗(1)]');
    // ready → green
    expect(out).toContain('[green:●]');
  });
});

// ---------------------------------------------------------------------------
// formatTree — connector overrides
// ---------------------------------------------------------------------------

describe('formatTree — connector overrides (T1203)', () => {
  it('uses custom connectors when provided', () => {
    const out = formatTree(sampleNodes, {
      mode: 'quiet',
      symbols: { connectors: { branch: '|-- ', last: '`-- ' } },
    });
    expect(out).toContain('|-- ');
    expect(out).toContain('`-- ');
  });
});

// ===========================================================================
// formatWaves
// ===========================================================================

// ---------------------------------------------------------------------------
// formatWaves — json mode
// ---------------------------------------------------------------------------

describe('formatWaves — json mode (T1203)', () => {
  it('returns parseable JSON with waves array', () => {
    const out = formatWaves({ waves: sampleWaves }, { mode: 'json' });
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('waves');
    expect(Array.isArray(parsed.waves)).toBe(true);
    expect(parsed.waves).toHaveLength(3);
  });

  it('preserves task data in JSON output', () => {
    const out = formatWaves({ waves: sampleWaves }, { mode: 'json' });
    const parsed = JSON.parse(out);
    const allIds = parsed.waves.flatMap((w: EnrichedWave) =>
      (w.tasks ?? []).map((t) => (typeof t === 'string' ? t : t.id)),
    );
    expect(allIds).toContain('T001');
    expect(allIds).toContain('T004');
  });

  it('returns JSON for empty waves', () => {
    const out = formatWaves({ waves: [] }, { mode: 'json' });
    const parsed = JSON.parse(out);
    expect(parsed.waves).toEqual([]);
  });

  it('returns "No wave data." when waves absent in json mode', () => {
    const out = formatWaves({}, { mode: 'json' });
    expect(out).toBe('No wave data.');
  });
});

// ---------------------------------------------------------------------------
// formatWaves — markdown mode
// ---------------------------------------------------------------------------

describe('formatWaves — markdown mode (T1203)', () => {
  it('renders ## Wave N — status headers', () => {
    const out = formatWaves({ waves: sampleWaves }, { mode: 'markdown' });
    expect(out).toContain('## Wave 1 — completed');
    expect(out).toContain('## Wave 2 — in_progress');
    expect(out).toContain('## Wave 3 — pending');
  });

  it('renders task list items with [status] prefix', () => {
    const out = formatWaves({ waves: sampleWaves }, { mode: 'markdown' });
    expect(out).toContain('- [done] T001 Implement auth');
    expect(out).toContain('- [active] T003 Build UI');
    expect(out).toContain('- [pending] T004 Write tests');
  });

  it('does NOT contain ANSI escape codes', () => {
    const out = formatWaves({ waves: sampleWaves }, { mode: 'markdown' });
    expect(out).not.toMatch(/\x1b\[/);
  });

  it('does NOT contain blocker indicators (⊗/●)', () => {
    const out = formatWaves({ waves: sampleWaves }, { mode: 'markdown' });
    expect(out).not.toContain('⊗');
    expect(out).not.toContain('●');
  });

  it('renders empty wave as _No tasks in this wave._', () => {
    const emptyWave: EnrichedWave[] = [{ waveNumber: 1, status: 'pending', tasks: [] }];
    const out = formatWaves({ waves: emptyWave }, { mode: 'markdown' });
    expect(out).toContain('_No tasks in this wave._');
  });

  it('handles string task entries', () => {
    const data = { waves: [{ waveNumber: 1, status: 'pending', tasks: ['T010', 'T011'] }] };
    const out = formatWaves(data, { mode: 'markdown' });
    expect(out).toContain('- T010');
    expect(out).toContain('- T011');
  });

  it('returns "No wave data." when waves absent', () => {
    const out = formatWaves({}, { mode: 'markdown' });
    expect(out).toBe('No wave data.');
  });
});

// ---------------------------------------------------------------------------
// formatWaves — quiet mode
// ---------------------------------------------------------------------------

describe('formatWaves — quiet mode (T1203)', () => {
  it('emits <waveNumber>\\t<taskId> per line', () => {
    const out = formatWaves({ waves: sampleWaves }, { mode: 'quiet' });
    const lines = out.split('\n').filter(Boolean);
    expect(lines).toContain('1\tT001');
    expect(lines).toContain('1\tT002');
    expect(lines).toContain('2\tT003');
    expect(lines).toContain('3\tT004');
  });

  it('emits no ANSI escape codes', () => {
    const out = formatWaves({ waves: sampleWaves }, { mode: 'quiet' });
    expect(out).not.toMatch(/\x1b\[/);
  });

  it('emits no wave headers or status badges', () => {
    const out = formatWaves({ waves: sampleWaves }, { mode: 'quiet' });
    expect(out).not.toContain('Wave 1');
    expect(out).not.toContain('completed');
    expect(out).not.toContain('in_progress');
  });

  it('emits no blocker indicators', () => {
    const out = formatWaves({ waves: sampleWaves }, { mode: 'quiet' });
    expect(out).not.toContain('⊗');
    expect(out).not.toContain('●');
  });

  it('handles string task entries', () => {
    const data = { waves: [{ waveNumber: 1, status: 'pending', tasks: ['T010', 'T011'] }] };
    const out = formatWaves(data, { mode: 'quiet' });
    const lines = out.split('\n').filter(Boolean);
    expect(lines).toContain('1\tT010');
    expect(lines).toContain('1\tT011');
  });

  it('returns empty string when waves absent', () => {
    const out = formatWaves({}, { mode: 'quiet' });
    expect(out).toBe('');
  });
});

// ---------------------------------------------------------------------------
// formatWaves — rich mode
// ---------------------------------------------------------------------------

describe('formatWaves — rich mode (T1203)', () => {
  it('renders wave numbers', () => {
    const out = formatWaves({ waves: sampleWaves });
    expect(out).toContain('Wave 1');
    expect(out).toContain('Wave 2');
    expect(out).toContain('Wave 3');
  });

  it('renders status badges: completed, in_progress, pending', () => {
    const out = formatWaves({ waves: sampleWaves });
    expect(out).toContain('completed');
    expect(out).toContain('in_progress');
    expect(out).toContain('pending');
  });

  it('renders task IDs and titles', () => {
    const out = formatWaves({ waves: sampleWaves });
    expect(out).toContain('T001');
    expect(out).toContain('Implement auth');
    expect(out).toContain('T004');
    expect(out).toContain('Write tests');
  });

  it('shows blocker indicator ⊗(N) for blocked tasks', () => {
    const out = formatWaves({ waves: sampleWaves });
    // T004 has blockedBy: ['T003'] → ⊗(1)
    expect(out).toContain('⊗(1)');
  });

  it('shows ready indicator ● for ready tasks', () => {
    const readyWaves: EnrichedWave[] = [
      {
        waveNumber: 1,
        status: 'pending',
        tasks: [{ id: 'T010', title: 'Ready task', status: 'pending', blockedBy: [], ready: true }],
      },
    ];
    const out = formatWaves({ waves: readyWaves });
    expect(out).toContain('●');
    expect(out).not.toContain('⊗');
  });

  it('renders empty wave as "(no tasks)" placeholder', () => {
    const emptyWave: EnrichedWave[] = [{ waveNumber: 1, status: 'pending', tasks: [] }];
    const out = formatWaves({ waves: emptyWave });
    expect(out).toContain('(no tasks)');
  });

  it('handles string task entries (non-enriched format)', () => {
    const data = { waves: [{ waveNumber: 1, status: 'pending', tasks: ['T010', 'T011'] }] };
    const out = formatWaves(data);
    expect(out).toContain('T010');
    expect(out).toContain('T011');
  });

  it('defaults to rich mode when opts is omitted', () => {
    const out = formatWaves({ waves: sampleWaves });
    // Rich mode includes wave header — not a plain tab-separated line.
    expect(out).not.toMatch(/^\d+\t/m);
    expect(out).toContain('Wave 1');
  });

  it('returns "No wave data." when waves is absent', () => {
    const out = formatWaves({});
    expect(out).toBe('No wave data.');
  });
});

// ---------------------------------------------------------------------------
// formatWaves — colorize injection
// ---------------------------------------------------------------------------

describe('formatWaves — colorize injection (T1203)', () => {
  it('passes style tokens to colorize callback', () => {
    const stylesApplied: string[] = [];
    formatWaves(
      { waves: sampleWaves },
      {
        mode: 'rich',
        colorize: (text, style) => {
          stylesApplied.push(style);
          return text;
        },
      },
    );
    // bold applied to wave headers and task IDs
    expect(stylesApplied).toContain('bold');
    // completed → green
    expect(stylesApplied).toContain('green');
    // in_progress → yellow
    expect(stylesApplied).toContain('yellow');
    // pending → dim
    expect(stylesApplied).toContain('dim');
  });

  it('injects colorize for blocker indicators', () => {
    const captures: Array<{ text: string; style: string }> = [];
    formatWaves(
      { waves: sampleWaves },
      {
        mode: 'rich',
        colorize: (text, style) => {
          captures.push({ text, style });
          return text;
        },
      },
    );
    const blockerCapture = captures.find((c) => c.text.includes('⊗'));
    expect(blockerCapture).toBeDefined();
    expect(blockerCapture?.style).toBe('red');
  });
});

// ===========================================================================
// formatTree — withDeps overlay (T1205)
// ===========================================================================

/**
 * Nodes with `depends` populated — used for --with-deps tests.
 *
 * T100 has no deps (should not emit a dep line).
 * T101 depends on T100 and T102.
 * T102 depends on T100 only.
 */
const depsNodes: FlatTreeNode[] = [
  {
    id: 'T100',
    title: 'Foundation',
    status: 'done',
    blockedBy: [],
    ready: false,
    depends: [],
  },
  {
    id: 'T101',
    title: 'Build',
    status: 'pending',
    blockedBy: ['T100', 'T102'],
    ready: false,
    depends: ['T100', 'T102'],
    children: [
      {
        id: 'T103',
        title: 'Sub-build',
        status: 'pending',
        blockedBy: ['T101'],
        ready: false,
        depends: ['T101'],
      },
    ],
  },
  {
    id: 'T102',
    title: 'Fixtures',
    status: 'pending',
    blockedBy: ['T100'],
    ready: false,
    depends: ['T100'],
  },
];

// ---------------------------------------------------------------------------
// withDeps — rich mode
// ---------------------------------------------------------------------------

describe('formatTree — withDeps rich mode (T1205)', () => {
  it('does NOT emit dep lines when withDeps is false (default)', () => {
    const out = formatTree(depsNodes, { mode: 'rich' });
    expect(out).not.toContain('← depends on:');
  });

  it('emits dep lines for tasks that have deps when withDeps is true', () => {
    const out = formatTree(depsNodes, { mode: 'rich', withDeps: true });
    expect(out).toContain('← depends on: T100, T102');
    expect(out).toContain('← depends on: T100');
    expect(out).toContain('← depends on: T101');
  });

  it('does NOT emit a dep line for tasks with empty depends array', () => {
    const out = formatTree(depsNodes, { mode: 'rich', withDeps: true });
    // T100 has depends: [] — only one dep line should NOT be for T100 as a source
    const lines = out.split('\n');
    const foundationIdx = lines.findIndex((l) => l.includes('T100') && l.includes('Foundation'));
    // Next non-empty line after T100 should NOT be a dep line (T100 has no deps)
    const nextLine = lines.slice(foundationIdx + 1).find((l) => l.trim() !== '');
    expect(nextLine).not.toMatch(/← depends on:/);
  });

  it('emits dep lines with dim colorize style', () => {
    const stylesApplied: string[] = [];
    formatTree(depsNodes, {
      mode: 'rich',
      withDeps: true,
      colorize: (text, style) => {
        if (text.includes('← depends on:')) {
          stylesApplied.push(style);
        }
        return text;
      },
    });
    expect(stylesApplied.length).toBeGreaterThan(0);
    expect(stylesApplied.every((s) => s === 'dim')).toBe(true);
  });

  it('renders dep lines for children too', () => {
    const out = formatTree(depsNodes, { mode: 'rich', withDeps: true });
    // T103 is a child of T101 and depends on T101
    expect(out).toContain('← depends on: T101');
  });
});

// ---------------------------------------------------------------------------
// withDeps — markdown mode
// ---------------------------------------------------------------------------

describe('formatTree — withDeps markdown mode (T1205)', () => {
  it('does NOT emit dep lines when withDeps is false', () => {
    const out = formatTree(depsNodes, { mode: 'markdown' });
    expect(out).not.toContain('depends on:');
  });

  it('emits nested dep list items for tasks that have deps', () => {
    const out = formatTree(depsNodes, { mode: 'markdown', withDeps: true });
    expect(out).toContain('  - depends on: [T100](#T100), [T102](#T102)');
    expect(out).toContain('  - depends on: [T100](#T100)');
  });

  it('does NOT emit dep list item for tasks with empty depends array', () => {
    const out = formatTree(depsNodes, { mode: 'markdown', withDeps: true });
    const lines = out.split('\n');
    const foundationIdx = lines.findIndex((l) => l.includes('T100') && l.includes('Foundation'));
    const nextLine = lines[foundationIdx + 1];
    // Must be another task list item, not a dep line
    expect(nextLine).not.toMatch(/depends on:/);
  });

  it('uses anchor link format [ID](#ID) for each dep', () => {
    const out = formatTree(depsNodes, { mode: 'markdown', withDeps: true });
    expect(out).toMatch(/\[T100\]\(#T100\)/);
    expect(out).toMatch(/\[T102\]\(#T102\)/);
  });

  it('does NOT contain ANSI escape codes', () => {
    const out = formatTree(depsNodes, { mode: 'markdown', withDeps: true });
    expect(out).not.toMatch(/\x1b\[/);
  });
});

// ---------------------------------------------------------------------------
// withDeps — json mode (depends already present on node)
// ---------------------------------------------------------------------------

describe('formatTree — withDeps json mode (T1205)', () => {
  it('preserves the depends array on each node regardless of withDeps flag', () => {
    const outWithout = formatTree(depsNodes, { mode: 'json' });
    const outWith = formatTree(depsNodes, { mode: 'json', withDeps: true });
    // JSON output is identical — depends is already embedded in the nodes
    expect(outWithout).toBe(outWith);
  });

  it('includes depends array in parsed JSON nodes', () => {
    const out = formatTree(depsNodes, { mode: 'json', withDeps: true });
    const parsed = JSON.parse(out);
    const t101 = parsed.tree.find((n: FlatTreeNode) => n.id === 'T101');
    expect(t101).toBeDefined();
    expect(t101.depends).toEqual(['T100', 'T102']);
  });
});

// ---------------------------------------------------------------------------
// withDeps — quiet mode (dep lines are SKIPPED)
// ---------------------------------------------------------------------------

describe('formatTree — withDeps quiet mode (T1205)', () => {
  it('does NOT emit dep lines in quiet mode even when withDeps is true', () => {
    const out = formatTree(depsNodes, { mode: 'quiet', withDeps: true });
    expect(out).not.toContain('← depends on:');
    expect(out).not.toContain('depends on:');
  });

  it('emits only IDs in quiet mode regardless of withDeps', () => {
    const out = formatTree(depsNodes, { mode: 'quiet', withDeps: true });
    const lines = out.split('\n').filter(Boolean);
    // Each line ends with an ID
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const lastToken = parts[parts.length - 1];
      expect(['T100', 'T101', 'T102', 'T103']).toContain(lastToken);
    }
  });
});

// ---------------------------------------------------------------------------
// withDeps — flag false by default (no regression)
// ---------------------------------------------------------------------------

describe('formatTree — withDeps disabled by default (T1205)', () => {
  it('omits dep lines in rich mode when withDeps is omitted', () => {
    const out = formatTree(depsNodes);
    expect(out).not.toContain('← depends on:');
  });

  it('omits dep lines in markdown mode when withDeps is omitted', () => {
    const out = formatTree(depsNodes, { mode: 'markdown' });
    expect(out).not.toContain('depends on:');
  });

  it('omits dep lines in quiet mode when withDeps is omitted', () => {
    const out = formatTree(depsNodes, { mode: 'quiet' });
    expect(out).not.toContain('depends on:');
  });
});
