import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeLogger, getLogDir, getLogger, initLogger } from '../logger.js';

describe('initLogger', () => {
  let tempDir: string;
  let cleoDir: string;

  async function setup(): Promise<void> {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-logger-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
  }

  afterEach(async () => {
    closeLogger();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('creates logger without projectHash (backward compat)', async () => {
    await setup();
    const logger = initLogger(cleoDir, {
      level: 'info',
      filePath: 'logs/test.log',
      maxFileSize: 1024 * 1024,
      maxFiles: 2,
    });

    expect(logger).toBeDefined();
    expect(getLogDir()).toBe(join(cleoDir, 'logs'));
  });

  it('creates logger with projectHash bound to base context', async () => {
    await setup();
    const logger = initLogger(
      cleoDir,
      {
        level: 'info',
        filePath: 'logs/test.log',
        maxFileSize: 1024 * 1024,
        maxFiles: 2,
      },
      'test-project-hash-123',
    );

    expect(logger).toBeDefined();

    // Verify projectHash is in the bindings
    const bindings = logger.bindings();
    expect(bindings.projectHash).toBe('test-project-hash-123');
  });

  it('child loggers inherit projectHash from root', async () => {
    await setup();
    initLogger(
      cleoDir,
      {
        level: 'info',
        filePath: 'logs/test.log',
        maxFileSize: 1024 * 1024,
        maxFiles: 2,
      },
      'inherited-hash',
    );

    const child = getLogger('test-subsystem');
    const bindings = child.bindings();

    expect(bindings.projectHash).toBe('inherited-hash');
    expect(bindings.subsystem).toBe('test-subsystem');
  });

  it('omits projectHash from base when not provided', async () => {
    await setup();
    const logger = initLogger(cleoDir, {
      level: 'fatal',
      filePath: 'logs/test.log',
      maxFileSize: 1024 * 1024,
      maxFiles: 2,
    });

    const bindings = logger.bindings();
    expect(bindings).not.toHaveProperty('projectHash');
  });

  it('getLogger returns fallback stderr logger before init', () => {
    closeLogger();
    const fallback = getLogger('pre-init');

    expect(fallback).toBeDefined();
    expect(fallback.bindings().subsystem).toBe('pre-init');
  });
});
