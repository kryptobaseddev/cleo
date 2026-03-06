/**
 * Default RCASD-IVTR+C WarpChain Builder
 *
 * Constructs the canonical 9-stage pipeline chain from existing
 * stage definitions, prerequisites, and verification gates.
 *
 * @task T5399
 */

import type { WarpChain, WarpStage, WarpLink, GateContract } from '../../types/warp-chain.js';
import { PIPELINE_STAGES, STAGE_DEFINITIONS, STAGE_PREREQUISITES } from './stages.js';
import { VERIFICATION_GATE_ORDER } from '../validation/verification.js';
import type { GateName } from '../validation/verification.js';
import { PROTOCOL_TYPES } from '../orchestration/protocol-validators.js';
import type { ProtocolType } from '../orchestration/protocol-validators.js';
import type { Stage } from './stages.js';

export const DEFAULT_CHAIN_ID = 'rcasd-ivtrc';

/**
 * Stage mapping for protocol validation gates in the default chain.
 *
 * `contribution` is cross-cutting and is validated at implementation.
 * `artifact-publish` and `provenance` are validated at release.
 *
 * @task T5419
 */
export const DEFAULT_PROTOCOL_STAGE_MAP: Record<ProtocolType, Stage> = {
  research: 'research',
  consensus: 'consensus',
  specification: 'specification',
  decomposition: 'decomposition',
  implementation: 'implementation',
  contribution: 'implementation',
  release: 'release',
  'artifact-publish': 'release',
  provenance: 'release',
};

/**
 * Map a pipeline stage name to the WarpStage category union.
 *
 * @task T5399
 */
function stageToCategory(stage: Stage): WarpStage['category'] {
  const map: Record<Stage, WarpStage['category']> = {
    research: 'research',
    consensus: 'consensus',
    architecture_decision: 'architecture',
    specification: 'specification',
    decomposition: 'decomposition',
    implementation: 'implementation',
    validation: 'validation',
    testing: 'testing',
    release: 'release',
  };
  return map[stage];
}

/**
 * Map verification gate names to the stages they guard (exit gates).
 *
 * Each gate is positioned as an exit gate on the stage it validates:
 * - implemented -> implementation
 * - testsPassed -> testing
 * - qaPassed -> validation
 * - cleanupDone -> decomposition
 * - securityPassed -> validation
 * - documented -> specification
 *
 * @task T5399
 */
function gateToStageId(gate: GateName): string {
  const map: Record<GateName, string> = {
    implemented: 'implementation',
    testsPassed: 'testing',
    qaPassed: 'validation',
    cleanupDone: 'decomposition',
    securityPassed: 'validation',
    documented: 'specification',
  };
  return map[gate];
}

/**
 * Build the canonical 9-stage RCASD-IVTR+C WarpChain.
 *
 * - Each PIPELINE_STAGE becomes a WarpStage
 * - Each prerequisite from STAGE_PREREQUISITES becomes an entry GateContract
 * - Each verification gate from VERIFICATION_GATE_ORDER becomes an exit GateContract
 * - All 8 links are linear (stage[i] -> stage[i+1])
 *
 * @task T5399
 */
export function buildDefaultChain(): WarpChain {
  const stages: WarpStage[] = PIPELINE_STAGES.map((stage) => {
    const def = STAGE_DEFINITIONS[stage];
    return {
      id: stage,
      name: def.name,
      category: stageToCategory(stage),
      skippable: def.skippable,
      description: def.description,
    };
  });

  const links: WarpLink[] = [];
  for (let i = 0; i < PIPELINE_STAGES.length - 1; i++) {
    links.push({
      from: PIPELINE_STAGES[i],
      to: PIPELINE_STAGES[i + 1],
      type: 'linear',
    });
  }

  const gates: GateContract[] = [];
  let gateCounter = 0;

  for (const stage of PIPELINE_STAGES) {
    const prereqs = STAGE_PREREQUISITES[stage];
    for (const prereq of prereqs) {
      gateCounter++;
      gates.push({
        id: `gate-entry-${gateCounter}`,
        name: `${prereq} complete (prereq for ${stage})`,
        type: 'entry',
        stageId: stage,
        position: 'before',
        check: { type: 'stage_complete', stageId: prereq },
        severity: 'blocking',
        canForce: false,
      });
    }
  }

  for (const stage of PIPELINE_STAGES) {
    for (const protocolType of PROTOCOL_TYPES) {
      if (DEFAULT_PROTOCOL_STAGE_MAP[protocolType] !== stage) {
        continue;
      }

      gateCounter++;
      gates.push({
        id: `gate-protocol-${gateCounter}`,
        name: `${protocolType} protocol validation`,
        type: 'exit',
        stageId: stage,
        position: 'after',
        check: { type: 'protocol_valid', protocolType },
        severity: 'blocking',
        canForce: false,
      });
    }
  }

  for (const gate of VERIFICATION_GATE_ORDER) {
    gateCounter++;
    gates.push({
      id: `gate-exit-${gateCounter}`,
      name: `${gate} verification gate`,
      type: 'exit',
      stageId: gateToStageId(gate),
      position: 'after',
      check: { type: 'verification_gate', gateName: gate },
      severity: 'blocking',
      canForce: true,
    });
  }

  return {
    id: DEFAULT_CHAIN_ID,
    name: 'RCASD-IVTR+C Default Pipeline',
    version: '1.0.0',
    description: 'Canonical 9-stage CLEO lifecycle pipeline: Research, Consensus, Architecture, Specification, Decomposition, Implementation, Validation, Testing, Release (+Contribution)',
    shape: {
      stages,
      links,
      entryPoint: PIPELINE_STAGES[0],
      exitPoints: [PIPELINE_STAGES[PIPELINE_STAGES.length - 1]],
    },
    gates,
  };
}
