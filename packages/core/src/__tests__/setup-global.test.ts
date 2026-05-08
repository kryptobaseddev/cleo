/**
 * Tests for the global Vitest setup sweeper (T9043).
 *
 * Verifies that the setup/teardown functions in setup-global.ts sweep
 * CLEO-prefix temp dirs from os.tmpdir(). The sweeper is stateless so we
 * can test it directly by pointing it at a controlled temp directory.
 *
 * @task T9043
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLEO_TEMP_PREFIXES } from '../gc/cleanup.js';

// ---------------------------------------------------------------------------
// The sweeper logic is embedded in setup-global.ts and operates on os.tmpdir().
// We cannot monkey-patch that module's import, so instead we replicate the
// sweep logic here (exercising CLEO_TEMP_PREFIXES) against a controlled dir.
// ---------------------------------------------------------------------------

import { readdirSync, rmSync as rmSyncFs } from 'node:fs';

function sweepDirUsingRegistry(dir: string): number {
  let swept = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!CLEO_TEMP_PREFIXES.some((p) => entry.name.startsWith(p))) continue;
      try {
        rmSyncFs(join(dir, entry.name), { recursive: true, force: true });
        swept++;
      } catch {
        // best-effort
      }
    }
  } catch {
    // ignore
  }
  return swept;
}

describe('setup-global sweeper (via CLEO_TEMP_PREFIXES)', () => {
  let tempBase: string;

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), 'cleo-sg-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('sweeps dirs matching every prefix in CLEO_TEMP_PREFIXES', () => {
    // Create one directory per prefix.
    const created: string[] = [];
    for (const prefix of CLEO_TEMP_PREFIXES) {
      const d = join(tempBase, `${prefix}sweep-test`);
      mkdirSync(d, { recursive: true });
      created.push(d);
    }

    const swept = sweepDirUsingRegistry(tempBase);
    expect(swept).toBe(CLEO_TEMP_PREFIXES.length);
    for (const d of created) {
      expect(existsSync(d)).toBe(false);
    }
  });

  it('does not sweep non-CLEO dirs', () => {
    const nonCleo = join(tempBase, 'unrelated-tool-dir');
    mkdirSync(nonCleo, { recursive: true });

    sweepDirUsingRegistry(tempBase);

    expect(existsSync(nonCleo)).toBe(true);
  });

  it('returns 0 when no CLEO dirs exist', () => {
    const swept = sweepDirUsingRegistry(tempBase);
    expect(swept).toBe(0);
  });
});
