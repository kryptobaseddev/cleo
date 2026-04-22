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
