import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeLogger,
  getLogDir,
  getLogger,
  initLogger,
  LOGGER_CONFIG_DEFAULTS,
  resolveLoggerConfig,
  rotateLogAtStartup,
  startFileLogger,
  startProjectFileLogger,
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

  /** Concatenated contents of every rotated `cleo.*` log file. */
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
    vi.stubEnv('CLEO_LOG_LEVEL', undefined);
    vi.stubEnv('CLEO_LOG_FILE', undefined);
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

  it('defaults equal the logger fields loadConfig() resolves', async () => {
    await setup();
    const { loadConfig } = await import('../config.js');
    const { level, filePath, maxFileSize, maxFiles } = (await loadConfig(tempDir)).logging;
    expect({ level, filePath, maxFileSize, maxFiles }).toEqual(LOGGER_CONFIG_DEFAULTS);
    expect(resolveLoggerConfig(cleoDir)).toEqual(LOGGER_CONFIG_DEFAULTS);
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

describe('rotateLogAtStartup (T14605)', () => {
  it('with maxFiles 0 never deletes the file another process may still write', async () => {
    const logPath = await setup();
    writeFileSync(join(logDir, 'cleo.2026-11-25.1.log'), 'x'.repeat(100));
    expect(rotateLogAtStartup(logPath, 100, 0, now)).toBe(join(logDir, 'cleo.2026-11-25.2.log'));
    expect(existsSync(join(logDir, 'cleo.2026-11-25.1.log'))).toBe(true);
  });

  let logDir: string;
  const now = new Date(2026, 10, 25, 12, 0, 0);

  async function setup(): Promise<string> {
    logDir = await mkdtemp(join(tmpdir(), 'cleo-log-rotate-'));
    return join(logDir, 'cleo.log');
  }

  afterEach(async () => {
    if (logDir) await rm(logDir, { recursive: true, force: true });
  });

  it('starts today at 1 with pino-roll naming', async () => {
    const logPath = await setup();
    expect(rotateLogAtStartup(logPath, 100, 2, now)).toBe(join(logDir, 'cleo.2026-11-25.1.log'));
  });

  it("reuses today's newest file until it reaches maxFileSize, then starts the next", async () => {
    const logPath = await setup();
    writeFileSync(join(logDir, 'cleo.2026-11-25.1.log'), 'x'.repeat(10));
    expect(rotateLogAtStartup(logPath, 100, 2, now)).toBe(join(logDir, 'cleo.2026-11-25.1.log'));
    writeFileSync(join(logDir, 'cleo.2026-11-25.1.log'), 'x'.repeat(100));
    expect(rotateLogAtStartup(logPath, 100, 2, now)).toBe(join(logDir, 'cleo.2026-11-25.2.log'));
  });

  it('keeps maxFiles older files besides the active one and deletes the rest', async () => {
    const logPath = await setup();
    for (const name of [
      'cleo.2026-11-20.1.log',
      'cleo.2026-11-21.1.log',
      'cleo.2026-11-22.1.log',
      'cleo.2026-11-22.2.log',
      'other.log',
    ]) {
      writeFileSync(join(logDir, name), 'x');
    }
    rotateLogAtStartup(logPath, 100, 2, now);
    expect(readdirSync(logDir).sort()).toEqual([
      'cleo.2026-11-22.1.log',
      'cleo.2026-11-22.2.log',
      'other.log',
    ]);
  });
});

describe('startProjectFileLogger: the CLI startup path (T14605)', () => {
  let tempDir: string;

  async function setup(): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-cli-logger-'));
    vi.stubEnv('CLEO_HOME', join(tempDir, 'home'));
    vi.stubEnv('CLEO_DIR', undefined);
    vi.stubEnv('CLEO_PROJECT_ROOT', undefined);
    vi.stubEnv('CLEO_LOG_LEVEL', undefined);
    vi.stubEnv('CLEO_LOG_FILE', undefined);
    vi.stubEnv('CLEO_ROOT', tempDir);
    return tempDir;
  }

  afterEach(async () => {
    await closeLogger();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('resolves the project and its config, then writes an INFO line to .cleo/logs', async () => {
    const root = await setup();
    await mkdir(join(root, '.cleo'), { recursive: true });
    await writeFile(
      join(root, '.cleo', 'config.json'),
      JSON.stringify({ logging: { filePath: 'logs/cli.log' } }),
    );

    const result = await startProjectFileLogger();
    expect(result).toEqual({ status: 'started', cleoDir: join(root, '.cleo') });
    expect(await startProjectFileLogger()).toEqual({ status: 'running' });

    getLogger('cli-start').info('t14605 cli path line');
    await closeLogger();
    const logDir = join(root, '.cleo', 'logs');
    const files = readdirSync(logDir).filter((name) => name.startsWith('cli.'));
    expect(files).toHaveLength(1);
    const text = readFileSync(join(logDir, files[0] ?? ''), 'utf-8');
    expect(text).toContain('t14605 cli path line');
    expect(text).toContain('"level":"INFO"');
  });

  it('starts nothing, silently, when the root has no .cleo directory', async () => {
    await setup();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await startProjectFileLogger()).toEqual({ status: 'no-project' });
    expect(stderr).not.toHaveBeenCalled();
  });

  it('reports a failure on stderr instead of silently dropping logs', async () => {
    const root = await setup();
    await mkdir(join(root, '.cleo'), { recursive: true });
    // `logs` is a file, so the log directory cannot be created.
    await writeFile(join(root, '.cleo', 'logs'), 'not a directory');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = await startProjectFileLogger();
    expect(result.status).toBe('failed');
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('[cleo] File logger not started:');
  });
});

describe('initLogger input checks (T14605)', () => {
  let tempDir: string;

  afterEach(async () => {
    await closeLogger();
    vi.restoreAllMocks();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('falls back to the default level, with a warning, on an unknown level', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-log-level-'));
    const cleoDir = join(tempDir, '.cleo');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const logger = initLogger(cleoDir, { ...LOGGER_CONFIG_DEFAULTS, level: 'verbose' }, 'h');
    expect(logger.level).toBe('info');
    expect(String(stderr.mock.calls[0]?.[0])).toContain('Unknown logging.level "verbose"');

    getLogger('level-test').info('t14605 level fallback line');
    await closeLogger();
    const logDir = join(cleoDir, 'logs');
    const text = readdirSync(logDir)
      .map((name) => readFileSync(join(logDir, name), 'utf-8'))
      .join('');
    expect(text).toContain('t14605 level fallback line');
  });
});

describe('log flush when the process ends (T14605)', () => {
  const LINES = 200;
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Bundle a child script that starts the logger, logs {@link LINES} lines
   * and then runs `ending` (an exit or a signal). Core modules the logger
   * imports lazily are left out; the child never calls them.
   */
  async function buildChild(ending: string): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-log-end-'));
    const here = dirname(fileURLToPath(import.meta.url));
    const childScript = join(tempDir, 'child.mjs');
    const { build } = await import('esbuild');
    await build({
      stdin: {
        contents: [
          `import { getLogger, initLogger } from ${JSON.stringify(resolve(here, '../logger.ts'))};`,
          'initLogger(process.argv[2], { level: "info", filePath: "logs/cleo.log", maxFileSize: 1048576, maxFiles: 2 }, "end-hash");',
          'const log = getLogger("end-test");',
          `for (let i = 0; i < ${LINES}; i++) log.info({ i }, "t14605 line");`,
          ending,
        ].join('\n'),
        resolveDir: here,
        loader: 'ts',
      },
      alias: { '@cleocode/paths': resolve(here, '../../../paths/src/index.ts') },
      plugins: [
        {
          name: 'lazy-core-external',
          setup(pluginBuild) {
            pluginBuild.onResolve(
              { filter: /^\.\/(project-scope|paths|project-info)\.js$/ },
              (args) => ({
                path: args.path,
                external: true,
              }),
            );
          },
        },
      ],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: childScript,
      banner: {
        js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
      },
      logLevel: 'silent',
    });
    return childScript;
  }

  /** Lines of every rotated log file the child wrote. */
  function loggedLines(cleoDir: string): string[] {
    const logDir = join(cleoDir, 'logs');
    return readdirSync(logDir)
      .filter((name) => name.startsWith('cleo.'))
      .flatMap((name) => readFileSync(join(logDir, name), 'utf-8').split('\n'))
      .filter((line) => line.includes('t14605 line'));
  }

  it('writes every line logged just before process.exit', async () => {
    const childScript = await buildChild('process.exit(0);');
    const cleoDir = join(tempDir, '.cleo');
    const child = spawnSync(process.execPath, [childScript, cleoDir], { encoding: 'utf-8' });
    expect(child.status, child.stderr).toBe(0);
    expect(loggedLines(cleoDir)).toHaveLength(LINES);
  });

  it.each([
    'SIGTERM',
    'SIGINT',
  ] as const)('writes every buffered line on %s and still dies by that signal', async (signal) => {
    const childScript = await buildChild(
      `process.kill(process.pid, ${JSON.stringify(signal)}); setTimeout(() => {}, 5000);`,
    );
    const cleoDir = join(tempDir, '.cleo');
    const child = spawnSync(process.execPath, [childScript, cleoDir], { encoding: 'utf-8' });
    expect(child.signal, child.stderr).toBe(signal);
    expect(loggedLines(cleoDir)).toHaveLength(LINES);
  });
});
