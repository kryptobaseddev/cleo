/**
 * The first `cleo add` on a project with no tasks (T14186): the refusal's
 * message itself names the root-saga command, not only its fix field.
 *
 * @task T14186
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CleoError } from '../../errors.js';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { addTask, ROOT_SAGA_COMMAND } from '../add.js';

describe('first cleo add on an empty project (T14186)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    process.env['CLEO_DIR'] = env.cleoDir;
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  it('refuses a root task with a message naming cleo saga create', async () => {
    const attempt = addTask(
      {
        title: 'Rate-limit the login endpoint',
        description: 'Throttle repeated login attempts per account',
        acceptance: ['repeated logins are throttled'],
      },
      env.tempDir,
      env.accessor,
    );
    await expect(attempt).rejects.toBeInstanceOf(CleoError);
    const error = await attempt.catch((err: CleoError) => err);
    expect(error.message).toContain(ROOT_SAGA_COMMAND);
    expect(error.fix).toContain(ROOT_SAGA_COMMAND);
  });
});
