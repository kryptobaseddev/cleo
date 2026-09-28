/**
 * T12604 guard: no runtime `which`/`test -x` shell-out in the in-scope packages.
 *
 * Windows has neither `which` nor `test`, so every such probe reports the tool
 * missing (every provider "cannot spawn"). Lookups go through `findOnPath`
 * from `@cleocode/paths`, which honours the PATH delimiter and PATHEXT.
 * `cleo-os` is out of scope (owner decision) and not scanned.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const IN_SCOPE = ['adapters', 'caamp', 'cleo', 'core', 'git-shim', 'paths', 'worktree'];

/** A `which`/`where`-less lookup or `test -x` executed through a shell or execFile. */
const SHELLOUT =
  /(?:exec(?:Sync|Async)?|execFile(?:Sync|Async)?|spawn(?:Sync)?|tryExec|runBin)\(\s*(?:['"`]which['"`]|['"`](?:which|test -x)\s)/;

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__')
      continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|mts|mjs)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) yield full;
  }
}

describe('no POSIX-only executable lookups (T12604)', () => {
  it('finds no which/test -x shell-out in runtime sources', () => {
    const offenders: string[] = [];
    for (const pkg of IN_SCOPE) {
      for (const file of sourceFiles(join(PACKAGES_DIR, pkg, 'src'))) {
        readFileSync(file, 'utf-8')
          .split('\n')
          .forEach((line, i) => {
            if (SHELLOUT.test(line)) offenders.push(`${relative(PACKAGES_DIR, file)}:${i + 1}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the pattern catches the forms it guards against', () => {
    for (const line of [
      "await execAsync('which claude');",
      'await execAsync(`test -x "/opt/pi" && echo ok`);',
      "execFileSync('which', ['cleo']);",
      "runBin('which', ['cleo'])",
    ])
      expect(SHELLOUT.test(line)).toBe(true);
    expect(SHELLOUT.test("findOnPath('claude')")).toBe(false);
  });
});
