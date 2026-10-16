/**
 * goal/v1 contract shapes (T13792): a contract and outcome in OCG's spelling
 * type-check, `proves` takes only the `T<n>#AC<n>` alias form, and the barrel
 * exports the protocol.
 *
 * @task T13792
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { GoalAcRef, GoalContract, GoalCriterion, GoalOutcome } from '../index.js';
import { GOAL_CONTRACT_SCHEMA, GOAL_HOST_CHECK_KINDS } from '../index.js';

const contract: GoalContract = {
  schema: GOAL_CONTRACT_SCHEMA,
  id: 'ship-t123',
  title: 'Ship T123',
  intent: { verbatim: 'ship T123' },
  outcome: 'T123 acceptance criteria hold on main',
  scope: { in: ['packages/core/'], out: [] },
  non_goals: ['unrelated refactors'],
  constraints: [],
  criteria: [
    {
      id: 'C1',
      statement: 'unit tests pass',
      essential: true,
      check: { kind: 'command', run: 'pnpm exec vitest run a.test.ts', expect: { exit: 0 } },
      proves: ['T123#AC1'],
    },
    {
      id: 'C2',
      statement: 'the error message is clear',
      essential: true,
      check: { kind: 'verifier', ask: 'Is the error message clear?' },
      proves: ['T123#AC2'],
    },
  ],
  invariants: [
    {
      id: 'I1',
      statement: 'typecheck passes',
      essential: true,
      check: { kind: 'command', run: 'pnpm run typecheck' },
    },
  ],
  cleo: { tasks: [{ id: 'T123' }, { id: 'T124', acs: { implemented: ['AC1'] } }] },
  protect: ['.cleo/'],
  assumptions: [],
  plan: [],
  budget: { turns: 40, wallMs: 5_400_000 },
  stop: { escalate_when: [] },
  autonomy: {
    questions: 'defer',
    on_user_message: 'steer',
    on_interrupt: 'pause',
    amend: [],
    on_stall: 'pause',
  },
  verification: { mode: 'host+verifier', max_rejections: 3, read: [] },
  execution: {},
  meta: {},
};

describe('goal/v1 contract (T13792)', () => {
  it('exports the schema tag and host check kinds OCG uses', () => {
    expect(GOAL_CONTRACT_SCHEMA).toBe('goal/v1');
    expect([...GOAL_HOST_CHECK_KINDS]).toEqual(['command', 'file', 'contains', 'absent', 'diff']);
    expect(contract.criteria.flatMap((c) => c.proves ?? [])).toEqual(['T123#AC1', 'T123#AC2']);
  });

  it('proves takes only the T<n>#AC<n> alias form', () => {
    expectTypeOf<'T123#AC2'>().toMatchTypeOf<GoalAcRef>();
    expectTypeOf<'AC2'>().not.toMatchTypeOf<GoalAcRef>();
    expectTypeOf<'T123'>().not.toMatchTypeOf<GoalAcRef>();
    expectTypeOf<GoalCriterion['proves']>().toEqualTypeOf<GoalAcRef[] | undefined>();
  });

  it('an outcome carries the lock, commits and per-criterion evidence', () => {
    const outcome: GoalOutcome = {
      schema: 'goal-outcome/v1',
      goal: contract.id,
      lock: 'a'.repeat(64),
      baseCommit: null,
      headCommit: 'b'.repeat(40),
      results: [
        {
          id: 'C1',
          pass: true,
          by: 'host',
          evidence: {
            kind: 'command',
            command: 'pnpm exec vitest run a.test.ts',
            exitCode: 0,
            reportPath: 'r.json',
          },
        },
        {
          id: 'C2',
          pass: true,
          by: 'verifier',
          evidence: { kind: 'verifier', verdict: 'proven', quotes: [{ path: 'a.ts', quote: 'x' }] },
        },
      ],
    };
    expect(outcome.results.map((r) => r.evidence.kind)).toEqual(['command', 'verifier']);
  });
});
