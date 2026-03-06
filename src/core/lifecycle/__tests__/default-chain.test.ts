/**
 * Tests for the default RCASD-IVTR+C WarpChain builder.
 *
 * @task T5400
 */

import { describe, it, expect } from 'vitest';
import {
  buildDefaultChain,
  DEFAULT_CHAIN_ID,
  DEFAULT_PROTOCOL_STAGE_MAP,
} from '../default-chain.js';
import { PIPELINE_STAGES, STAGE_PREREQUISITES } from '../stages.js';
import { VERIFICATION_GATE_ORDER } from '../../validation/verification.js';
import { PROTOCOL_TYPES } from '../../orchestration/protocol-validators.js';
import { validateChain } from '../../validation/chain-validation.js';

describe('buildDefaultChain', () => {
  const chain = buildDefaultChain();

  it('has correct number of stages matching PIPELINE_STAGES count', () => {
    expect(chain.shape.stages).toHaveLength(PIPELINE_STAGES.length);
  });

  it('has correct number of linear links (stages - 1)', () => {
    expect(chain.shape.links).toHaveLength(PIPELINE_STAGES.length - 1);
    for (const link of chain.shape.links) {
      expect(link.type).toBe('linear');
    }
  });

  it('entry point is the first PIPELINE_STAGE', () => {
    expect(chain.shape.entryPoint).toBe(PIPELINE_STAGES[0]);
  });

  it('exit point is the last PIPELINE_STAGE', () => {
    expect(chain.shape.exitPoints).toHaveLength(1);
    expect(chain.shape.exitPoints[0]).toBe(PIPELINE_STAGES[PIPELINE_STAGES.length - 1]);
  });

  it('every STAGE_PREREQUISITE is represented as an entry gate', () => {
    const entryGates = chain.gates.filter((g) => g.type === 'entry');

    for (const stage of PIPELINE_STAGES) {
      const prereqs = STAGE_PREREQUISITES[stage];
      for (const prereq of prereqs) {
        const match = entryGates.find(
          (g) =>
            g.stageId === stage &&
            g.check.type === 'stage_complete' &&
            g.check.stageId === prereq,
        );
        expect(match, `Missing entry gate for prereq "${prereq}" on stage "${stage}"`).toBeDefined();
      }
    }
  });

  it('every VERIFICATION_GATE_ORDER gate is represented as an exit gate', () => {
    const exitGates = chain.gates.filter((g) => g.type === 'exit');

    for (const gateName of VERIFICATION_GATE_ORDER) {
      const match = exitGates.find(
        (g) =>
          g.check.type === 'verification_gate' &&
          g.check.gateName === gateName,
      );
      expect(match, `Missing exit gate for verification gate "${gateName}"`).toBeDefined();
    }
  });

  it('every protocol type is represented as a protocol_valid gate', () => {
    const protocolGates = chain.gates.filter((g) => g.check.type === 'protocol_valid');

    for (const protocolType of PROTOCOL_TYPES) {
      const match = protocolGates.find(
        (g) => g.check.type === 'protocol_valid' && g.check.protocolType === protocolType,
      );
      expect(match, `Missing protocol gate for protocol "${protocolType}"`).toBeDefined();
      expect(match?.stageId).toBe(DEFAULT_PROTOCOL_STAGE_MAP[protocolType]);
    }
  });

  it('orders protocol_valid gates by pipeline stage sequence', () => {
    const protocolGates = chain.gates.filter((g) => g.check.type === 'protocol_valid');
    const stageOrder = new Map<string, number>(PIPELINE_STAGES.map((stage, index) => [stage, index]));
    const protocolStageIndexes = protocolGates.map((gate) => stageOrder.get(gate.stageId) ?? -1);

    for (let i = 1; i < protocolStageIndexes.length; i++) {
      expect(protocolStageIndexes[i]).toBeGreaterThanOrEqual(protocolStageIndexes[i - 1]);
    }
  });

  it('buildDefaultChain returns well-formed chain (validateChain passes)', () => {
    const validation = validateChain(chain);
    expect(validation.wellFormed).toBe(true);
    expect(validation.gateSatisfiable).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  it('has the correct chain ID', () => {
    expect(chain.id).toBe(DEFAULT_CHAIN_ID);
    expect(chain.id).toBe('rcasd-ivtrc');
  });
});
