/**
 * Chain Validation Engine
 *
 * Validates WarpChain definitions for structural correctness (shape)
 * and gate satisfiability (gates reference valid stages/gate names).
 *
 * @task T5401
 */

import type { ChainShape, WarpChain, ChainValidation } from '../../types/warp-chain.js';
import { VERIFICATION_GATE_ORDER } from './verification.js';

/**
 * Validate the topology/DAG of a chain shape.
 *
 * Checks:
 * - All link source/target IDs reference existing stages
 * - entryPoint references an existing stage
 * - All exitPoints reference existing stages
 * - No cycles (topological sort)
 * - All stages are reachable from the entry point
 *
 * @task T5401
 */
export function validateChainShape(shape: ChainShape): string[] {
  const errors: string[] = [];
  const stageIds = new Set(shape.stages.map((s) => s.id));

  if (!stageIds.has(shape.entryPoint)) {
    errors.push(`entryPoint "${shape.entryPoint}" does not reference an existing stage`);
  }

  for (const exit of shape.exitPoints) {
    if (!stageIds.has(exit)) {
      errors.push(`exitPoint "${exit}" does not reference an existing stage`);
    }
  }

  for (const link of shape.links) {
    if (!stageIds.has(link.from)) {
      errors.push(`Link source "${link.from}" does not reference an existing stage`);
    }
    if (!stageIds.has(link.to)) {
      errors.push(`Link target "${link.to}" does not reference an existing stage`);
    }
  }

  // Cycle detection via topological sort (Kahn's algorithm)
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const id of stageIds) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }

  for (const link of shape.links) {
    if (stageIds.has(link.from) && stageIds.has(link.to)) {
      adjacency.get(link.from)!.push(link.to);
      inDegree.set(link.to, (inDegree.get(link.to) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let sorted = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted++;
    for (const neighbor of adjacency.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (sorted < stageIds.size) {
    errors.push('Chain contains a cycle — topological sort could not complete');
  }

  // Reachability from entry point (BFS)
  if (stageIds.has(shape.entryPoint)) {
    const visited = new Set<string>();
    const bfsQueue: string[] = [shape.entryPoint];
    visited.add(shape.entryPoint);

    while (bfsQueue.length > 0) {
      const current = bfsQueue.shift()!;
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          bfsQueue.push(neighbor);
        }
      }
    }

    for (const id of stageIds) {
      if (!visited.has(id)) {
        errors.push(`Stage "${id}" is not reachable from entry point "${shape.entryPoint}"`);
      }
    }
  }

  return errors;
}

/**
 * Validate that all gates in a chain reference valid stages and gate names.
 *
 * Checks:
 * - Every gate's stageId references an existing stage
 * - Every stage_complete check references an existing stage
 * - Every verification_gate check references a valid GateName
 *
 * @task T5401
 */
export function validateGateSatisfiability(chain: WarpChain): string[] {
  const errors: string[] = [];
  const stageIds = new Set(chain.shape.stages.map((s) => s.id));
  const validGateNames = new Set<string>(VERIFICATION_GATE_ORDER as readonly string[]);

  for (const gate of chain.gates) {
    if (!stageIds.has(gate.stageId)) {
      errors.push(`Gate "${gate.id}" references non-existent stage "${gate.stageId}"`);
    }

    if (gate.check.type === 'stage_complete') {
      if (!stageIds.has(gate.check.stageId)) {
        errors.push(`Gate "${gate.id}" stage_complete check references non-existent stage "${gate.check.stageId}"`);
      }
    }

    if (gate.check.type === 'verification_gate') {
      if (!validGateNames.has(gate.check.gateName)) {
        errors.push(`Gate "${gate.id}" references invalid verification gate name "${gate.check.gateName as string}"`);
      }
    }
  }

  return errors;
}

/**
 * Validate a complete WarpChain definition.
 *
 * Orchestrates shape validation and gate satisfiability checks,
 * returning a unified ChainValidation result.
 *
 * @task T5401
 */
export function validateChain(chain: WarpChain): ChainValidation {
  const shapeErrors = validateChainShape(chain.shape);
  const gateErrors = validateGateSatisfiability(chain);

  const allErrors = [...shapeErrors, ...gateErrors];

  return {
    wellFormed: shapeErrors.length === 0,
    gateSatisfiable: gateErrors.length === 0,
    artifactComplete: true,
    errors: allErrors,
    warnings: [],
  };
}
