/**
 * `cleo goal` exposes only the goal protocol verbs (T13797): CLEO's own goal
 * loop (`set`/`status`/`advance`/`subgoal`/`append`) is retired, and the
 * protocol verbs `draft` and `close` remain. Their behaviour is covered by
 * `packages/core/src/goal/__tests__/{draft,close}.test.ts`.
 *
 * @task T13797
 */

import { describe, expect, it } from 'vitest';
import { goalCommand } from '../commands/goal.js';

describe('cleo goal — protocol verbs only (T13797)', () => {
  it('exposes draft, close and status, and none of the retired goal-loop verbs', () => {
    expect(Object.keys(goalCommand.subCommands ?? {}).sort()).toEqual(['close', 'draft', 'status']);
  });
});
