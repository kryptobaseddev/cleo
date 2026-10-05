/**
 * Every explicit-op name the typed merge rules accept is emitted by core's
 * own entry point (T13229 review LOW-2), and core's leave entry points name
 * their command on every transport (LOW-1).
 *
 * @task T13229
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TASK_STAGE_RESTORE_OPS, TASK_STATUS_LEAVE_OPS } from '../merge/rules.js';
import { currentWriteActorJson, runWithWriteActor, runWithWriteActorOp } from '../write-actor.js';

const ENGINE_WRAP = resolve(import.meta.dirname, '../../../tasks/engine-wrap.ts');

describe('explicit merge ops are real commands (T13229)', () => {
  it('every leave and restore op in the rules is emitted by core', () => {
    const src = readFileSync(ENGINE_WRAP, 'utf8');
    const emitted = new Set(
      [...src.matchAll(/runWithWriteActorOp\('([a-z.-]+)'/g)].map((m) => m[1]),
    );
    for (const op of new Set([...TASK_STATUS_LEAVE_OPS, ...TASK_STAGE_RESTORE_OPS])) {
      expect(emitted, `${op} is in the merge rules but no core entry point emits it`).toContain(op);
    }
  });

  it('runWithWriteActorOp names the command and keeps the enclosing session', async () => {
    expect(runWithWriteActorOp('tasks.reopen', () => currentWriteActorJson())).toBe(
      '{"op":"tasks.reopen"}',
    );
    const seen = await runWithWriteActor({ op: 'tasks.restore', session: 's1' }, () =>
      runWithWriteActorOp('tasks.reopen', async () => {
        await Promise.resolve();
        return currentWriteActorJson();
      }),
    );
    expect(seen).toBe('{"op":"tasks.reopen","session":"s1"}');
  });
});
