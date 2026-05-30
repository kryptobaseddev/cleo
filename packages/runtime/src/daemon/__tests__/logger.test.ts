/**
 * Log-routing primitive tests for the daemon submodule (T11368).
 *
 * Asserts:
 * 1. createSubsystemLogger routes through the canonical pino factory
 *    `getLogger` (spied) — never a raw stream or console.
 * 2. Lines are namespaced per subsystem (a `daemonSubsystem` child binding).
 * 3. ZERO `console.*` and ZERO `createWriteStream` in the daemon submodule
 *    production paths (static grep over the non-test sources).
 *
 * @task T11368
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const daemonSrcDir = join(here, '..');

// Mock the canonical core logger factory so we can prove routing without
// initializing the real pino transport.
const childLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
const baseLogger = {
  child: vi.fn(() => childLogger),
};
const getLoggerMock = vi.fn(() => baseLogger);

vi.mock('@cleocode/core', () => ({
  getLogger: (subsystem: string) => getLoggerMock(subsystem),
}));

describe('createSubsystemLogger routing (T11368)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('routes through the canonical getLogger factory under the daemon root', async () => {
    const { createSubsystemLogger } = await import('../logger.js');
    createSubsystemLogger('studio');
    expect(getLoggerMock).toHaveBeenCalledWith('daemon');
  });

  it('namespaces lines per subsystem via a daemonSubsystem child binding', async () => {
    const { createSubsystemLogger } = await import('../logger.js');
    createSubsystemLogger('gc');
    expect(baseLogger.child).toHaveBeenCalledWith({ daemonSubsystem: 'gc' });
  });

  it('forwards each level to the underlying pino child logger', async () => {
    const { createSubsystemLogger } = await import('../logger.js');
    const log = createSubsystemLogger('web');
    log.info({ pid: 1 }, 'started');
    log.warn({ code: 'X' }, 'warned');
    log.error({ err: 'e' }, 'failed');
    log.debug({ d: 1 }, 'debugged');
    expect(childLogger.info).toHaveBeenCalledWith({ pid: 1 }, 'started');
    expect(childLogger.warn).toHaveBeenCalledWith({ code: 'X' }, 'warned');
    expect(childLogger.error).toHaveBeenCalledWith({ err: 'e' }, 'failed');
    expect(childLogger.debug).toHaveBeenCalledWith({ d: 1 }, 'debugged');
  });
});

describe('daemon submodule logging discipline (T11368 AC3)', () => {
  /** Recursively collect production .ts source files (excludes __tests__). */
  function collectProductionSources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...collectProductionSources(full));
      } else if (entry.name.endsWith('.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  it('has zero console.* and zero createWriteStream in production paths', () => {
    const sources = collectProductionSources(daemonSrcDir);
    expect(sources.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      // Match actual console method calls and raw file-stream opens, not the
      // words appearing inside TSDoc prose (which describe what we DON'T do).
      // Strip block comments first so doc-comment mentions don't false-positive.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '');
      if (/\bconsole\.(log|info|warn|error|debug)\s*\(/.test(code)) {
        offenders.push(`${file}: console.*`);
      }
      if (/\bcreateWriteStream\s*\(/.test(code)) {
        offenders.push(`${file}: createWriteStream`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
