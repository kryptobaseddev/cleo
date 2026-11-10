/**
 * Gate 18 (T12087 · T14410): every tracked vitest config, named ones such as
 * `vitest.integration.config.ts` included, spreads MEMORY_SAFE_TEST_DEFAULTS.
 *
 * @task T14410
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const GATE = fileURLToPath(new URL('../lint-vitest-memory-safe.mjs', import.meta.url));
const SAFE =
  "import { MEMORY_SAFE_TEST_DEFAULTS } from './vitest.memory-safe.js';\nexport default { test: { ...MEMORY_SAFE_TEST_DEFAULTS } };\n";
const UNSAFE = 'export default { test: { globals: true } };\n';

let root;

/** A scratch git repo holding the SSoT and the given tracked files. */
function repo(files) {
  root = mkdtempSync(path.join(tmpdir(), 'memory-safe-gate-'));
  const all = {
    'vitest.memory-safe.ts': 'export const MEMORY_SAFE_TEST_DEFAULTS = {};\n',
    ...files,
  };
  for (const [rel, src] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), src);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  return spawnSync(process.execPath, [GATE], { cwd: root, encoding: 'utf8' });
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('lint-vitest-memory-safe (gate 18)', () => {
  it('fails a named vitest.<name>.config.ts that does not spread the defaults', () => {
    const r = repo({
      'vitest.config.ts': SAFE,
      'packages/x/vitest.integration.config.ts': UNSAFE,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('packages/x/vitest.integration.config.ts');
  });

  it('passes when every config, named ones included, spreads the defaults', () => {
    const r = repo({
      'vitest.config.ts': SAFE,
      'packages/x/vitest.integration.config.ts': SAFE,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('2 vitest config(s)');
  });
});
