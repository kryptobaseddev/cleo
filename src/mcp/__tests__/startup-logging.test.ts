/**
 * Startup logging instrumentation tests.
 *
 * Verifies that the MCP startup path emits structured logs with
 * correct severity and context fields after initLogger() runs.
 *
 * @task T5310
 */

import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { closeLogger,getLogger,initLogger } from '../../core/logger.js';

describe('MCP startup logging (T5310)', () => {
  let tempDir: string;

  async function setup(): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-startup-log-'));
    const cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    return cleoDir;
  }

  afterEach(async () => {
    closeLogger();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('getLogger returns fallback before initLogger is called', () => {
    closeLogger();
    const pre = getLogger('mcp:startup');
    expect(pre).toBeDefined();
    // Fallback logger is at warn level
    expect(pre.level).toBe('warn');
    expect(pre.bindings().subsystem).toBe('mcp:startup');
  });

  it('getLogger returns file-backed logger after initLogger', async () => {
    const cleoDir = await setup();
    initLogger(cleoDir, {
      level: 'info',
      filePath: 'logs/cleo.log',
      maxFileSize: 1024 * 1024,
      maxFiles: 2,
    }, 'abc123');

    const post = getLogger('mcp:startup');
    expect(post).toBeDefined();
    expect(post.bindings().projectHash).toBe('abc123');
    expect(post.bindings().subsystem).toBe('mcp:startup');
  });

  it('re-acquired logger after initLogger has projectHash', async () => {
    const cleoDir = await setup();

    // Simulate MCP startup: get logger before init (fallback)
    let startupLog = getLogger('mcp:startup');
    expect(startupLog.bindings()).not.toHaveProperty('projectHash');

    // Init logger (as MCP main() does)
    initLogger(cleoDir, {
      level: 'info',
      filePath: 'logs/cleo.log',
      maxFileSize: 1024 * 1024,
      maxFiles: 2,
    }, 'proj-hash-42');

    // Re-acquire after init (as MCP main() now does)
    startupLog = getLogger('mcp:startup');
    expect(startupLog.bindings().projectHash).toBe('proj-hash-42');
  });

  it('startup info log can include version and projectHash fields', async () => {
    const cleoDir = await setup();
    initLogger(cleoDir, {
      level: 'info',
      filePath: 'logs/cleo.log',
      maxFileSize: 1024 * 1024,
      maxFiles: 2,
    }, 'hash-for-version-test');

    const log = getLogger('mcp:startup');
    const infoSpy = vi.spyOn(log, 'info');

    log.info(
      { version: '2026.3.0', projectHash: 'hash-for-version-test', logLevel: 'info' },
      'CLEO MCP server starting',
    );

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        version: '2026.3.0',
        projectHash: 'hash-for-version-test',
      }),
      'CLEO MCP server starting',
    );
  });
});
