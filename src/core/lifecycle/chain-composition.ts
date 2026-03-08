/**
 * Chain Composition Operators
 *
 * Provides operators to combine WarpChains via sequencing (A then B)
 * and parallel execution (fork-join).
 *
 * @task T5406
 */

import type {
  ChainShape,
  GateContract,
  WarpChain,
  WarpLink,
  WarpStage,
} from '../../types/warp-chain.js';
import { validateChain } from '../validation/chain-validation.js';

/**
 * Prefix all stage IDs, link references, gate stageIds, and gate check stageIds
 * in a chain to avoid ID collisions during composition.
 *
 * @task T5406
 */
function prefixChain(chain: WarpChain, prefix: string): WarpChain {
  const pfx = (id: string): string => `${prefix}_${id}`;

  const stages: WarpStage[] = chain.shape.stages.map((s) => ({
    ...s,
    id: pfx(s.id),
  }));

  const links: WarpLink[] = chain.shape.links.map((l) => ({
    ...l,
    from: pfx(l.from),
    to: pfx(l.to),
  }));

  const gates: GateContract[] = chain.gates.map((g) => {
    const prefixed: GateContract = {
      ...g,
      id: pfx(g.id),
      stageId: pfx(g.stageId),
      check: { ...g.check },
    };
    if (prefixed.check.type === 'stage_complete') {
      prefixed.check = {
        type: 'stage_complete',
        stageId: pfx(g.check.type === 'stage_complete' ? g.check.stageId : ''),
      };
    }
    return prefixed;
  });

  const shape: ChainShape = {
    stages,
    links,
    entryPoint: pfx(chain.shape.entryPoint),
    exitPoints: chain.shape.exitPoints.map(pfx),
  };

  return {
    ...chain,
    shape,
    gates,
  };
}

/**
 * Sequence two chains: connect A's exit points to B's entry point.
 *
 * B's stage IDs are prefixed with "b" to avoid collision with A.
 * The result is validated and throws if invalid.
 *
 * @task T5406
 */
export function sequenceChains(a: WarpChain, b: WarpChain): WarpChain {
  const prefixedB = prefixChain(b, 'b');

  const bridgeLinks: WarpLink[] = a.shape.exitPoints.map((exit) => ({
    from: exit,
    to: prefixedB.shape.entryPoint,
    type: 'linear' as const,
  }));

  const shape: ChainShape = {
    stages: [...a.shape.stages, ...prefixedB.shape.stages],
    links: [...a.shape.links, ...bridgeLinks, ...prefixedB.shape.links],
    entryPoint: a.shape.entryPoint,
    exitPoints: prefixedB.shape.exitPoints,
  };

  const result: WarpChain = {
    id: `${a.id}+${b.id}`,
    name: `${a.name} -> ${b.name}`,
    version: '1.0.0',
    description: `Sequential composition of ${a.id} and ${b.id}`,
    shape,
    gates: [...a.gates, ...prefixedB.gates],
  };

  const validation = validateChain(result);
  if (validation.errors.length > 0) {
    throw new Error(`sequenceChains produced invalid chain: ${validation.errors.join('; ')}`);
  }

  return result;
}

/**
 * Compose chains in parallel with a common fork entry and join stage.
 *
 * Creates a fork entry stage that links to each chain's entry, and
 * all chain exits link to the provided joinStage.
 *
 * Each chain's IDs are prefixed with "p{index}" to avoid collisions.
 *
 * @task T5406
 */
export function parallelChains(chains: WarpChain[], joinStage: WarpStage): WarpChain {
  if (chains.length === 0) {
    throw new Error('parallelChains requires at least one chain');
  }

  const forkStage: WarpStage = {
    id: 'parallel-fork',
    name: 'Parallel Fork',
    category: 'custom',
    skippable: false,
    description: 'Fork point for parallel chain execution',
  };

  const prefixedChains = chains.map((c, i) => prefixChain(c, `p${i}`));

  const forkLinks: WarpLink[] = prefixedChains.map((pc) => ({
    from: forkStage.id,
    to: pc.shape.entryPoint,
    type: 'fork' as const,
  }));

  const joinLinks: WarpLink[] = prefixedChains.flatMap((pc) =>
    pc.shape.exitPoints.map((exit) => ({
      from: exit,
      to: joinStage.id,
      type: 'branch' as const,
    })),
  );

  const allStages: WarpStage[] = [
    forkStage,
    ...prefixedChains.flatMap((pc) => pc.shape.stages),
    joinStage,
  ];

  const allLinks: WarpLink[] = [
    ...forkLinks,
    ...prefixedChains.flatMap((pc) => pc.shape.links),
    ...joinLinks,
  ];

  const allGates: GateContract[] = prefixedChains.flatMap((pc) => pc.gates);

  const shape: ChainShape = {
    stages: allStages,
    links: allLinks,
    entryPoint: forkStage.id,
    exitPoints: [joinStage.id],
  };

  const result: WarpChain = {
    id: `parallel(${chains.map((c) => c.id).join(',')})`,
    name: `Parallel: ${chains.map((c) => c.name).join(' | ')}`,
    version: '1.0.0',
    description: `Parallel composition of ${chains.length} chains`,
    shape,
    gates: allGates,
  };

  const validation = validateChain(result);
  if (validation.errors.length > 0) {
    throw new Error(`parallelChains produced invalid chain: ${validation.errors.join('; ')}`);
  }

  return result;
}
