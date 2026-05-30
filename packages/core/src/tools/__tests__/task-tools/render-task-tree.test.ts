import type { CriticalPathEdge, CriticalPathNode, RenderTaskTreeInput } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { renderTaskTreeMermaid, renderTaskTreeText } from '../../../task-tools/render-task-tree.js';

const NODES: CriticalPathNode[] = [
  { id: 'T1', title: 'Setup', status: 'done', depends: [] },
  { id: 'T2', title: 'Build', status: 'pending', depends: ['T1'] },
  { id: 'T3', title: 'Test "suite"', status: 'active', depends: ['T2'] },
];
const EDGES: CriticalPathEdge[] = [
  { from: 'T1', to: 'T2' },
  { from: 'T2', to: 'T3' },
];
const CRITICAL_PATH = ['T1', 'T2', 'T3'];

const INPUT: RenderTaskTreeInput = { nodes: NODES, edges: EDGES, criticalPath: CRITICAL_PATH };

describe('renderTaskTreeText', () => {
  it('produces output starting with "Dep tree:" and includes all task IDs', () => {
    const output = renderTaskTreeText(INPUT);

    expect(output).toMatch(/^Dep tree:/);
    expect(output).toContain('T1');
    expect(output).toContain('T2');
    expect(output).toContain('T3');
  });

  it('marks critical path nodes with **', () => {
    const output = renderTaskTreeText(INPUT);

    // All three nodes are on the critical path
    expect(output).toContain('T1: Setup **');
    expect(output).toContain('Critical path (** marked): T1 -> T2 -> T3');
  });

  it('uses correct status symbols', () => {
    const output = renderTaskTreeText(INPUT);

    expect(output).toContain('[x]'); // done
    expect(output).toContain('[ ]'); // pending
    expect(output).toContain('[>]'); // active
  });

  it('omits critical path summary line when path is empty', () => {
    const output = renderTaskTreeText({ nodes: NODES, edges: EDGES, criticalPath: [] });
    expect(output).not.toContain('Critical path');
  });
});

describe('renderTaskTreeMermaid', () => {
  it('produces a valid graph TD block with node definitions', () => {
    const output = renderTaskTreeMermaid(INPUT);

    expect(output).toMatch(/^graph TD/);
    expect(output).toContain('T1[');
    expect(output).toContain('T2[');
    expect(output).toContain('T3[');
  });

  it('includes directed edges between nodes', () => {
    const output = renderTaskTreeMermaid(INPUT);

    expect(output).toContain('T1 --> T2');
    expect(output).toContain('T2 --> T3');
  });

  it('applies critical path classDef styling', () => {
    const output = renderTaskTreeMermaid(INPUT);

    expect(output).toContain('classDef critical fill:#f96,stroke:#c00;');
    expect(output).toContain('class T1 critical;');
  });

  it('escapes double-quotes in task titles', () => {
    const output = renderTaskTreeMermaid(INPUT);
    // T3 title has double-quotes — must be escaped to single quotes
    expect(output).toContain("Test 'suite'");
    expect(output).not.toContain('Test "suite"');
  });

  it('omits classDef when critical path is empty', () => {
    const output = renderTaskTreeMermaid({ nodes: NODES, edges: EDGES, criticalPath: [] });
    expect(output).not.toContain('classDef');
  });
});
