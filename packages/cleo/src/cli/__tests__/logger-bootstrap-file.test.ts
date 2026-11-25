/**
 * The CLI startup file logger writes `.cleo/logs/cleo.log` (T14605).
 *
 * Unlike `logger-bootstrap.test.ts`, nothing here is mocked: the real pino-roll
 * transport must put an info line on disk.
 *
 * @task T14605
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeLogger, getLogger } from '@cleocode/core/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startCliFileLogger } from '../logger-bootstrap.js';

/** Concatenated contents of every `cleo.*` log file pino-roll wrote. */
function readCleoLogs(logDir: string): string {
  if (!existsSync(logDir)) return '';
  return readdirSync(logDir)
    .filter((name) => name.startsWith('cleo.') && name.endsWith('.log'))
    .map((name) => readFileSync(join(logDir, name), 'utf-8'))
    .join('');
}

describe('startCliFileLogger (T14605)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cleo-t14605-'));
    mkdirSync(join(root, '.cleo', 'logs'), { recursive: true });
    vi.stubEnv('CLEO_ROOT', root);
    vi.stubEnv('CLEO_LOG_LEVEL', 'info');
    vi.stubEnv('CLEO_LOG_FILE', 'logs/cleo.log');
  });

  afterEach(async () => {
    await closeLogger();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('writes an info line to .cleo/logs/cleo.log, once per process', async () => {
    expect(await startCliFileLogger()).toBe(true);

    getLogger('cli-test').info('t14605 file logger line');
    await closeLogger();

    const logDir = join(root, '.cleo', 'logs');
    await vi.waitFor(() => expect(readCleoLogs(logDir)).toContain('t14605 file logger line'), {
      timeout: 5_000,
    });
    expect(readCleoLogs(logDir)).toContain('"level":"INFO"');

    // A second call in the same process starts nothing.
    expect(await startCliFileLogger()).toBe(false);
  });
});
