/**
 * Tests for WarpChain validation engine.
 *
 * @task T5402
 */

import { describe, it, expect } from 'vitest';
import {
  validateChain,
  validateChainShape,
  validateGateSatisfiability,
} from '../chain-validation.js';
import { buildDefaultChain } from '../../lifecycle/default-chain.js';
import type { WarpChain, WarpStage, WarpLink, GateContract } from '../../../types/warp-chain.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStage(id: string, overrides?: Partial<WarpStage>): WarpStage {
  return {
    id,
    name: id,
    category: 'custom',
    skippable: false,
    ...overrides,
  };
}

function makeLinearChain(ids: string[]): WarpChain {
  const stages = ids.map((id) => makeStage(id));
  const links: WarpLink[] = [];
  for (let i = 0; i < ids.length - 1; i++) {
    links.push({ from: ids[i], to: ids[i + 1], type: 'linear' });
  }
  return {
    id: 'test-chain',
    name: 'Test Chain',
    version: '1.0.0',
    description: 'A test chain',
    shape: {
      stages,
      links,
      entryPoint: ids[0],
      exitPoints: [ids[ids.length - 1]],
    },
    gates: [],
  };
}

function makeForkJoinChain(): WarpChain {
  const stageIds = ['start', 'fork-left', 'fork-right', 'join', 'finish'];
  const stages = stageIds.map((id) => makeStage(id));

  return {
    id: 'fork-join-chain',
    name: 'Fork Join Chain',
    version: '1.0.0',
    description: 'A fork-join test chain',
    shape: {
      stages,
      links: [
        { from: 'start', to: 'fork-left', type: 'fork' },
        { from: 'start', to: 'fork-right', type: 'fork' },
        { from: 'fork-left', to: 'join', type: 'linear' },
        { from: 'fork-right', to: 'join', type: 'linear' },
        { from: 'join', to: 'finish', type: 'linear' },
      ],
      entryPoint: 'start',
      exitPoints: ['finish'],
    },
    gates: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateChainShape', () => {
  it('valid linear chain passes all checks', () => {
    const chain = makeLinearChain(['A', 'B', 'C']);
    const errors = validateChainShape(chain.shape);
    expect(errors).toHaveLength(0);
  });

  it('chain with cycle detected (A->B->C->A)', () => {
    const chain = makeLinearChain(['A', 'B', 'C']);
    chain.shape.links.push({ from: 'C', to: 'A', type: 'linear' });

    const errors = validateChainShape(chain.shape);
    expect(errors.some((e) => e.includes('cycle'))).toBe(true);
  });

  it('chain with unreachable stage detected', () => {
    const chain = makeLinearChain(['A', 'B']);
    chain.shape.stages.push(makeStage('orphan'));

    const errors = validateChainShape(chain.shape);
    expect(errors.some((e) => e.includes('orphan') && e.includes('not reachable'))).toBe(true);
  });

  it('chain with nonexistent link target detected', () => {
    const chain = makeLinearChain(['A', 'B']);
    chain.shape.links.push({ from: 'A', to: 'nonexistent', type: 'linear' });

    const errors = validateChainShape(chain.shape);
    expect(errors.some((e) => e.includes('nonexistent') && e.includes('does not reference'))).toBe(true);
  });

  it('empty chain fails validation', () => {
    const chain: WarpChain = {
      id: 'empty',
      name: 'Empty',
      version: '1.0.0',
      description: 'An empty chain',
      shape: {
        stages: [],
        links: [],
        entryPoint: 'missing',
        exitPoints: ['also-missing'],
      },
      gates: [],
    };

    const errors = validateChainShape(chain.shape);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('entryPoint'))).toBe(true);
  });

  it('chain missing entry point fails', () => {
    const chain = makeLinearChain(['A', 'B']);
    chain.shape.entryPoint = 'nonexistent';

    const errors = validateChainShape(chain.shape);
    expect(errors.some((e) => e.includes('entryPoint') && e.includes('nonexistent'))).toBe(true);
  });

  it('valid fork-join chain passes shape validation', () => {
    const chain = makeForkJoinChain();

    const errors = validateChainShape(chain.shape);
    expect(errors).toHaveLength(0);
  });

  it('malformed fork-join chain reports join-link errors', () => {
    const chain = makeForkJoinChain();
    chain.shape.links.push({ from: 'missing-branch', to: 'join', type: 'linear' });

    const errors = validateChainShape(chain.shape);
    expect(errors.some((e) => e.includes('missing-branch') && e.includes('does not reference'))).toBe(true);
  });
});

describe('validateGateSatisfiability', () => {
  it('gate referencing nonexistent stage detected', () => {
    const chain = makeLinearChain(['A', 'B']);
    const gate: GateContract = {
      id: 'gate-1',
      name: 'bad gate',
      type: 'entry',
      stageId: 'nonexistent',
      position: 'before',
      check: { type: 'stage_complete', stageId: 'A' },
      severity: 'blocking',
      canForce: false,
    };
    chain.gates.push(gate);

    const errors = validateGateSatisfiability(chain);
    expect(errors.some((e) => e.includes('nonexistent') && e.includes('non-existent stage'))).toBe(true);
  });

  it('gate with stage_complete check referencing nonexistent stage detected', () => {
    const chain = makeLinearChain(['A', 'B']);
    const gate: GateContract = {
      id: 'gate-2',
      name: 'bad stage_complete gate',
      type: 'entry',
      stageId: 'B',
      position: 'before',
      check: { type: 'stage_complete', stageId: 'nonexistent' },
      severity: 'blocking',
      canForce: false,
    };
    chain.gates.push(gate);

    const errors = validateGateSatisfiability(chain);
    expect(errors.some((e) => e.includes('nonexistent'))).toBe(true);
  });
});

describe('validateChain', () => {
  it('default RCASD chain passes validation', () => {
    const chain = buildDefaultChain();
    const result = validateChain(chain);

    expect(result.wellFormed).toBe(true);
    expect(result.gateSatisfiable).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('valid chain returns clean validation', () => {
    const chain = makeLinearChain(['X', 'Y', 'Z']);
    const result = validateChain(chain);

    expect(result.wellFormed).toBe(true);
    expect(result.gateSatisfiable).toBe(true);
    expect(result.artifactComplete).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('invalid chain collects both shape and gate errors', () => {
    const chain = makeLinearChain(['A', 'B']);
    chain.shape.stages.push(makeStage('orphan'));
    chain.gates.push({
      id: 'bad-gate',
      name: 'bad',
      type: 'exit',
      stageId: 'nonexistent',
      position: 'after',
      check: { type: 'stage_complete', stageId: 'A' },
      severity: 'warning',
      canForce: true,
    });

    const result = validateChain(chain);
    expect(result.wellFormed).toBe(false);
    expect(result.gateSatisfiable).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('valid fork-join chain returns clean validation', () => {
    const chain = makeForkJoinChain();
    const result = validateChain(chain);

    expect(result.wellFormed).toBe(true);
    expect(result.gateSatisfiable).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
