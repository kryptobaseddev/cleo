/**
 * A session records the CLEO-INJECTION version its briefing delivered, and
 * `session status` shows it (T14327).
 *
 * @task T14327
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bindTestSession,
  createTestDb,
  type TestDbEnv,
} from '../../store/__tests__/test-db-helper.js';
import { parseInjectionVersion } from '../../templates/registry.js';
import { sessionBriefing } from '../engine-ops.js';
import { sessionStatus } from '../status-op.js';

describe('session injection version (T14327)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    // createTestDb points CLEO_HOME at <tempDir>/.cleo-home; install the template there.
    const templates = join(env.tempDir, '.cleo-home', 'templates');
    mkdirSync(templates, { recursive: true });
    writeFileSync(
      join(templates, 'CLEO-INJECTION.md'),
      '# CLEO Protocol\n\nVersion: 9.8.7 | CLI-only dispatch | `cleo <command> [args]`\n',
    );
  });

  afterEach(async () => {
    await env.cleanup();
  });

  const statusVersion = async (): Promise<string | null | undefined> => {
    const status = await sessionStatus(env.tempDir);
    if (!status.success) throw new Error(status.error?.message);
    return status.data?.session?.injectionVersion;
  };

  it('a session that ran briefing shows the template version; one that did not shows none', async () => {
    await bindTestSession(env, 'ses_20261106000000_a1a1a1');
    expect(await statusVersion()).toBeNull();

    const briefing = await sessionBriefing(env.tempDir);
    expect(briefing.success).toBe(true);
    expect(await statusVersion()).toBe('9.8.7');

    await bindTestSession(env, 'ses_20261106000001_b2b2b2');
    expect(await statusVersion()).toBeNull();
  });

  it('reads the first token of the Version line', () => {
    expect(parseInjectionVersion('# CLEO Protocol\n\nVersion: 2.25.5 | CLI-only dispatch\n')).toBe(
      '2.25.5',
    );
    expect(parseInjectionVersion('# no version here\n')).toBeNull();
  });
});
