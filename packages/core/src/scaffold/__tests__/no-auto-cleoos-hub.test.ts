/**
 * The CleoOS hub is no longer seeded automatically (T13994, ADR-098).
 *
 * `cleo init`, `cleo upgrade` and the global scaffold (`install.global`) used
 * to seed the hub's Pi extensions, CANT workflows and justfile into the global
 * CLEO home. The Pi/CleoOS harness is retiring, so only the explicit
 * `cleo admin scaffold-hub` still does.
 *
 * @task T13994
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureGlobalScaffold } from '../global-scaffold.js';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cleo-t13994-'));
  vi.stubEnv('CLEO_HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('no automatic CleoOS hub seeding (T13994)', () => {
  it('ensureGlobalScaffold reports the hub skipped and seeds no Pi extension', async () => {
    const result = await ensureGlobalScaffold();
    expect(result.cleoosHub.action).toBe('skipped');
    expect(result.cleoosHub.details).toContain('ADR-098');
    const piExt = join(home, 'pi-extensions');
    const seeded = existsSync(piExt) ? readdirSync(piExt) : [];
    expect(seeded).toEqual([]);
  });

  it.each(['init.ts', 'upgrade.ts'])('%s no longer calls ensureCleoOsHub', (file) => {
    expect(readFileSync(join(srcDir, file), 'utf-8')).not.toMatch(/ensureCleoOsHub\(/);
  });
});
