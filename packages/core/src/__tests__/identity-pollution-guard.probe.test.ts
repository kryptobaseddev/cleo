/**
 * Verifies that vitest.setup.ts's identity-pollution guard rejects any
 * `git config <field> <value>` write whose target is outside os.tmpdir().
 *
 * This probe is a smoke test for the guard itself. It must:
 *   1. Reject a write whose cwd is the host project root.
 *   2. Reject a write whose `-C <dir>` points at the host project root.
 *   3. Allow a write whose cwd lives under os.tmpdir().
 *   4. Allow reads (`--get`) anywhere.
 *   5. Allow explicitly --global writes anywhere.
 *
 * Delete this file once the guard is reviewed and the tests in the broader
 * suite confirm its behaviour.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = process.cwd();

describe('vitest identity-pollution guard', () => {
  it('rejects git config write whose cwd is the host project root', () => {
    expect(() =>
      execFileSync('git', ['config', 'user.email', 'evil@example.com'], { cwd: PROJECT_ROOT }),
    ).toThrow(/identity-pollution guard/);
  });

  it('rejects git config write whose -C points at host project root', () => {
    expect(() =>
      execFileSync('git', ['-C', PROJECT_ROOT, 'config', 'user.email', 'evil@example.com']),
    ).toThrow(/identity-pollution guard/);
  });

  it('allows git config write whose cwd is under os.tmpdir()', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-probe-allowed-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    // Must NOT throw.
    expect(() =>
      execFileSync('git', ['config', 'user.email', 'ok@example.com'], { cwd: dir }),
    ).not.toThrow();
  });

  it('allows git config --get from anywhere (reads are safe)', () => {
    expect(() =>
      execFileSync('git', ['config', '--get', 'user.email'], { cwd: PROJECT_ROOT, stdio: 'pipe' }),
    ).not.toThrow();
  });
});
