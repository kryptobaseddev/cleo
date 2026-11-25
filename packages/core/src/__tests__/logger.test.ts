import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeLogger,
  getLogDir,
  getLogger,
  initLogger,
  resolveLoggerConfig,
  startFileLogger,
} from '../logger.js';

describe('initLogger', () => {
  let tempDir: string;
  let cleoDir: string;

  async function setup(): Promise<void> {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-logger-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
  }

  afterEach(async () => {
    await closeLogger();
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

  it('getLogger returns fallback stderr logger before init', async () => {
    await closeLogger();
    const fallback = getLogger('pre-init');

    expect(fallback).toBeDefined();
    expect(fallback.bindings().subsystem).toBe('pre-init');
  });
});

describe('startFileLogger (T14605)', () => {
  let tempDir: string;
  let cleoDir: string;

  /** Concatenated contents of every `cleo.*` log file pino-roll wrote. */
  function readCleoLogs(): string {
    const logDir = join(cleoDir, 'logs');
    if (!existsSync(logDir)) return '';
    return readdirSync(logDir)
      .filter((name) => name.startsWith('cleo.') && name.endsWith('.log'))
      .map((name) => readFileSync(join(logDir, name), 'utf-8'))
      .join('');
  }

  async function setup(): Promise<void> {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-file-logger-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(join(cleoDir, 'logs'), { recursive: true });
    // Isolate from the machine's global config and any CLEO_LOG_* override.
    vi.stubEnv('CLEO_HOME', join(tempDir, 'home'));
    vi.stubEnv('CLEO_LOG_LEVEL', '');
    vi.stubEnv('CLEO_LOG_FILE', '');
  }

  afterEach(async () => {
    await closeLogger();
    vi.unstubAllEnvs();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('writes an info line to .cleo/logs/cleo.log, once per process', async () => {
    await setup();
    expect(startFileLogger(cleoDir, 'hash-t14605')).toBe(true);
    expect(startFileLogger(cleoDir)).toBe(false);

    getLogger('cli-test').info('t14605 file logger line');
    await closeLogger();

    await vi.waitFor(() => expect(readCleoLogs()).toContain('t14605 file logger line'), {
      timeout: 5_000,
    });
    expect(readCleoLogs()).toContain('"level":"INFO"');
    expect(readCleoLogs()).toContain('"projectHash":"hash-t14605"');
  });

  it('resolves defaults, project config and env overrides', async () => {
    await setup();
    expect(resolveLoggerConfig(cleoDir)).toEqual({
      level: 'info',
      filePath: 'logs/cleo.log',
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 5,
    });

    await writeFile(
      join(cleoDir, 'config.json'),
      JSON.stringify({ pinoLogging: { maxFiles: 2 }, logging: { level: 'debug' } }),
    );
    vi.stubEnv('CLEO_LOG_FILE', 'logs/other.log');
    expect(resolveLoggerConfig(cleoDir)).toEqual({
      level: 'debug',
      filePath: 'logs/other.log',
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 2,
    });
  });
});
