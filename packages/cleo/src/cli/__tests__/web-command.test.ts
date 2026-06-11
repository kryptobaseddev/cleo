/**
 * Tests for the batteries-included `cleo web` command helpers (T11980).
 *
 * Exercises:
 *  - {@link buildStudioUrl} — pure URL construction
 *  - {@link openBrowser} — platform-dispatch (never throws)
 *  - Manifest registration for the `web` command
 *
 * @task T11980
 */

import { describe, expect, it } from 'vitest';
import { buildStudioUrl, openBrowser } from '../commands/web.js';
import { COMMAND_MANIFEST } from '../generated/command-manifest.js';

// ---------------------------------------------------------------------------
// buildStudioUrl — pure unit tests
// ---------------------------------------------------------------------------

describe('buildStudioUrl', () => {
  it('builds a valid http URL for default port and host', () => {
    expect(buildStudioUrl(7777, '127.0.0.1')).toBe('http://127.0.0.1:7777');
  });

  it('builds URL for custom port and host', () => {
    expect(buildStudioUrl(9000, 'localhost')).toBe('http://localhost:9000');
  });

  it('produces a parseable URL', () => {
    const url = buildStudioUrl(7777, '127.0.0.1');
    const parsed = new URL(url);
    expect(parsed.port).toBe('7777');
    expect(parsed.hostname).toBe('127.0.0.1');
    expect(parsed.protocol).toBe('http:');
  });
});

// ---------------------------------------------------------------------------
// openBrowser — should never throw
// ---------------------------------------------------------------------------

describe('openBrowser', () => {
  it('does not throw for a valid URL', () => {
    // We cannot assert the browser opens in CI, but the function MUST NOT throw
    // regardless of whether the platform opener is available.
    expect(() => openBrowser('http://127.0.0.1:7777')).not.toThrow();
  });

  it('does not throw for an empty string', () => {
    expect(() => openBrowser('')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Manifest registration
// ---------------------------------------------------------------------------

describe('cleo web command manifest registration', () => {
  it('is present in the generated command manifest', () => {
    const entry = COMMAND_MANIFEST.find((e) => e.name === 'web');
    expect(entry).toBeDefined();
    expect(entry?.exportName).toBe('webCommand');
  });

  it('loads a valid CommandDef', async () => {
    const entry = COMMAND_MANIFEST.find((e) => e.name === 'web');
    const cmd = await entry?.load();
    expect(cmd).toBeDefined();
    const meta = cmd?.meta as { name?: string } | undefined;
    expect(meta?.name).toBe('web');
  });
});
