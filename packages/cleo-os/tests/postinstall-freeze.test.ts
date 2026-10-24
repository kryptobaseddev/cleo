/**
 * The cleo-os postinstall stops seeding (T13996, ADR-098): a global install
 * no longer creates `cant/`, seeds `.cant` files or runs `cleo skills
 * install`, prints a deprecation naming ADR-098, and still deploys the
 * extensions the `cleoos` launcher loads.
 *
 * @task T13996
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cleo-t13996-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('cleo-os postinstall freeze (T13996)', () => {
  it('a global install seeds no .cant files, warns, and still deploys extensions', () => {
    const data = join(home, 'cleo-data');
    const result = spawnSync(process.execPath, [join(pkgRoot, 'bin', 'postinstall.js')], {
      encoding: 'utf-8',
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: home,
        XDG_CONFIG_HOME: join(home, 'config'),
        XDG_DATA_HOME: join(home, 'data'),
        CLEO_HOME: data,
        npm_config_global: 'true',
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('deprecated (ADR-098)');
    expect(result.stdout).not.toMatch(/model-routing\.cant|starter|skills install/);
    expect(existsSync(join(data, 'cant'))).toBe(false);
    // The launcher's extension directory is still prepared (its .js files are build output).
    expect(existsSync(join(data, 'extensions'))).toBe(true);
  });
});
