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

/**
 * Any call — whatever the callee is named (`exec`, `execP`, `run`, …) — whose
 * first argument is a string or template literal that is a `which`,
 * `test -x` or `command -v` shell line, or the bare `'which'` executable.
 * Callee-agnostic on purpose: a name list missed `execP('which claude')`.
 */
const SHELLOUT = /[\w$\])]\s*\(\s*(?:(['"`])(?:which|test\s+-x|command\s+-v)\s|(['"`])which\2\s*,)/;

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
            // Comment/TSDoc prose is not a call.
            if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
            if (SHELLOUT.test(line)) offenders.push(`${relative(PACKAGES_DIR, file)}:${i + 1}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the pattern catches the forms it guards against, whatever the callee', () => {
    for (const line of [
      "await execAsync('which claude');",
      "await withTimeout(execP('which claude'), 3_000);",
      // A template literal with a placeholder (built so it is not itself one).
      `await run(\`which $${'{'}bin}\`);`,
      'await execAsync(`test -x "/opt/pi" && echo ok`);',
      "sh('command -v git')",
      "execFileSync('which', ['cleo']);",
      "runBin('which', ['cleo'])",
      "const probe = promisify(exec) ( 'which gh' );",
    ])
      expect(SHELLOUT.test(line), line).toBe(true);
    for (const line of [
      "findOnPath('claude')",
      ' * `which claude` used to be spawned here',
      "const label = 'which one';",
      "log('whichever')",
    ])
      expect(SHELLOUT.test(line), line).toBe(false);
  });
});
