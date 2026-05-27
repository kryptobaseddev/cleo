/**
 * Unit tests for the CANT agent DSL v3 type surface and {@link isCantAgentV3}
 * structural type guard.
 *
 * @remarks
 * These tests exercise a real (non-mocked) `CantAgentV3` object literal to
 * validate the positive path, then invalid shapes (`null`, empty object,
 * partial object) to validate rejection. Vitest with describe/it per project
 * conventions.
 */

import { describe, expect, it } from 'vitest';
import {
  type CantAgentV3,
  type CantContextSourceDef,
  type CantContractBlock,
  type CantMentalModelRef,
  isCantAgentV3,
} from '../src/types';

describe('CANT agent DSL v3 types', () => {
  it('narrows a well-formed CantAgentV3 literal via isCantAgentV3()', () => {
    const contracts: CantContractBlock = {
      requires: [{ text: 'Task is in started state before work begins', enforcement: 'hard' }],
      ensures: [{ text: 'Output file written to OUTPUT_PATH before return' }],
    };
    const contextSources: CantContextSourceDef[] = [
      { source: 'brain', query: 'recent decisions', maxEntries: 10 },
    ];
    const mentalModelRef: CantMentalModelRef = {
      scope: 'project',
      maxTokens: 2048,
      validateOnLoad: true,
    };
    const agent: CantAgentV3 = {
      name: 'w1-1',
      sourcePath: '/tmp/agents/w1-1.cant',
      version: '3.0.0',
      role: 'worker',
      description: 'Worker that emits types',
      prompt: 'Do the thing',
      skills: ['ct-task-executor'],
      permissions: { read: 'all' },
      tier: 'mid',
      contextSources,
      onOverflow: 'escalate_tier',
      mentalModelRef,
      contracts,
    };

    expect(isCantAgentV3(agent)).toBe(true);
  });

  it('rejects null, empty object, and partial object shapes', () => {
    expect(isCantAgentV3(null)).toBe(false);
    expect(isCantAgentV3({})).toBe(false);
    expect(isCantAgentV3({ name: 'x' })).toBe(false);
  });
});
