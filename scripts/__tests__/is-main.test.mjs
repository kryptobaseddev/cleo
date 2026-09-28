/**
 * Entry-point detection for `scripts/*.mjs` (T12488).
 *
 * The old idiom compared `import.meta.url` against a hand-built
 * `file://${process.argv[1]}` string. `import.meta.url` percent-encodes a
 * space, so every gate using it skipped `main()` and exited 0 when the
 * checkout lived under `~/Library/Application Support/` — which is where
 * every macOS CLEO worktree lives. These tests run a gate from a path with a
 * space and prove it actually executes, and forbid the idiom from returning.
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmpRoots = [];

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** Copy `scripts/lib/is-main.mjs` plus a probe script into `<tmp>/<dirName>/`. */
function stageProbe(dirName) {
  const root = mkdtempSync(join(tmpdir(), 'is-main-'));
  tmpRoots.push(root);
  const dir = join(root, dirName);
  mkdirSync(join(dir, 'lib'), { recursive: true });
  cpSync(join(SCRIPTS_DIR, 'lib', 'is-main.mjs'), join(dir, 'lib', 'is-main.mjs'));
  writeFileSync(
    join(dir, 'probe.mjs'),
    "import { isMain } from './lib/is-main.mjs';\nif (isMain(import.meta.url)) { console.log('RAN'); process.exit(3); }\n",
  );
  writeFileSync(join(dir, 'importer.mjs'), "import './probe.mjs';\nconsole.log('IMPORTED');\n");
  return dir;
}

describe('isMain (T12488)', () => {
  it('runs main() when the script path contains a space', () => {
    const dir = stageProbe('Application Support');
    const r = spawnSync(process.execPath, [join(dir, 'probe.mjs')], { encoding: 'utf8' });
    expect(r.stdout).toContain('RAN');
    expect(r.status).toBe(3);
  });

  it('runs main() for a plain path', () => {
    const dir = stageProbe('plain');
    const r = spawnSync(process.execPath, [join(dir, 'probe.mjs')], { encoding: 'utf8' });
    expect(r.status).toBe(3);
  });

  it('does not run main() when the module is imported', () => {
    const dir = stageProbe('with space');
    const r = spawnSync(process.execPath, [join(dir, 'importer.mjs')], { encoding: 'utf8' });
    expect(r.stdout).toContain('IMPORTED');
    expect(r.stdout).not.toContain('RAN');
    expect(r.status).toBe(0);
  });

  it('no script uses a string-built file:// or URL.pathname entry-point check', () => {
    const offenders = [];
    for (const name of readdirSync(SCRIPTS_DIR)) {
      if (!name.endsWith('.mjs')) continue;
      const src = readFileSync(join(SCRIPTS_DIR, name), 'utf8');
      if (
        /import\.meta\.url\s*===\s*`file:\/\/\$\{/.test(src) ||
        /new URL\(import\.meta\.url\)\.pathname/.test(src) ||
        // The split form: `const url = new URL(import.meta.url); … url.pathname`.
        /new URL\(import\.meta\.url\);[\s\S]{0,80}?\.pathname/.test(src)
      ) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});
