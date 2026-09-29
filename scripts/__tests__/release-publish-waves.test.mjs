/**
 * Tests for scripts/release-publish-waves.sh — the wave runner the npm publish
 * step of .github/workflows/release.yml sources.
 *
 * The real `_publish_one` is replaced by a fake that succeeds, skips (the
 * idempotent re-run outcomes), fails with a classified outcome, or CRASHES
 * (exits nonzero without classifying), chosen per package. The driver runs
 * under `set -eo pipefail`, which is how GitHub Actions runs a `shell: bash`
 * step, so a crash that escaped `run_wave` would abort the driver.
 *
 * Every "halts" case is paired with a "continues" case: a runner that never
 * published a second wave would pass the halt cases on its own.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'release-publish-waves.sh');

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'publish-waves-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Run three waves (a b | c d | e) with a fake publisher.
 *
 * @param {Record<string, 'ok'|'skip'|'fail'|'crash'>} behaviour - per package; default `ok`.
 * @returns {{ status: number, stdout: string, failed: string[], timeline: string[][], attempted: (pkg: string) => boolean }}
 */
function runWaves(behaviour) {
  const modes = Object.entries(behaviour)
    .map(([pkg, mode]) => `MODE_${pkg}=${mode}`)
    .join('\n');
  const driver = `
set -eo pipefail
${modes}
FAILED_LOG="${dir}/failed.txt"; : > "$FAILED_LOG"
PUBLISH_LOG="${dir}/timeline.tsv"; printf 'pkg\\toutcome\\tcall_ts\\tdone_ts\\n' > "$PUBLISH_LOG"
WAVE_LOG_DIR="${dir}"
_publish_one() {
  local name="\${2:-\${1##*/}}"
  local var="MODE_\${name}"
  local mode="\${!var:-ok}"
  touch "${dir}/attempted-\${name}"
  case "$mode" in
    ok)    printf '%s\\tPUBLISHED\\tt\\tt\\n' "$name" >> "$PUBLISH_LOG" ;;
    skip)  printf '%s\\tSKIP-EXISTS\\tt\\tt\\n' "$name" >> "$PUBLISH_LOG" ;;
    fail)  echo "$name" >> "$FAILED_LOG"; printf '%s\\tFAIL\\tt\\tt\\n' "$name" >> "$PUBLISH_LOG" ;;
    crash) exit 7 ;;
  esac
  return 0
}
source "${SCRIPT}"
publish_pkg a
publish_pkg b
run_wave 1
publish_pkg c
publish_pkg packages/d-dir d
run_wave 2
publish_pkg e
run_wave 3
echo "DRIVER-FINISHED"
`;
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync('bash', ['-c', driver], { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    status = err.status ?? 1;
    stdout = String(err.stdout ?? '');
  }
  const failed = readFileSync(join(dir, 'failed.txt'), 'utf8').split('\n').filter(Boolean);
  const timeline = readFileSync(join(dir, 'timeline.tsv'), 'utf8')
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map((l) => l.split('\t'));
  return {
    status,
    stdout,
    failed,
    timeline,
    attempted: (pkg) => existsSync(join(dir, `attempted-${pkg}`)),
  };
}

const outcome = (r, pkg) => r.timeline.find((row) => row[0] === pkg)?.[1];

describe('release-publish-waves run_wave', () => {
  it('publishes every wave when every package succeeds', () => {
    const r = runWaves({});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DRIVER-FINISHED');
    expect(r.failed).toEqual([]);
    for (const pkg of ['a', 'b', 'c', 'd', 'e']) expect(r.attempted(pkg), pkg).toBe(true);
  });

  it('treats the idempotent SKIP outcomes of a re-run as success', () => {
    const r = runWaves({ a: 'skip', b: 'skip', c: 'skip', d: 'skip', e: 'skip' });
    expect(r.failed).toEqual([]);
    expect(r.attempted('e')).toBe(true);
    expect(outcome(r, 'e')).toBe('SKIP-EXISTS');
  });

  it('records a crashed publish as a failure and publishes no later wave', () => {
    const r = runWaves({ b: 'crash' });
    // The driver survived under set -e: the crash was handled, not escaped.
    expect(r.stdout).toContain('DRIVER-FINISHED');
    expect(r.failed).toEqual(['b']);
    expect(outcome(r, 'b')).toBe('CRASH(exit 7)');
    // The rest of wave 1 still ran (it was already in flight)…
    expect(r.attempted('a')).toBe(true);
    // …but waves 2 and 3 were never attempted.
    for (const pkg of ['c', 'd', 'e']) {
      expect(r.attempted(pkg), pkg).toBe(false);
      expect(outcome(r, pkg), pkg).toBe('NOT-ATTEMPTED');
    }
    expect(r.stdout).toContain('later waves will NOT be published');
  });

  it('stops after a wave with a classified failure', () => {
    const r = runWaves({ d: 'fail' });
    expect(r.failed).toEqual(['d']);
    expect(r.attempted('c')).toBe(true);
    expect(r.attempted('e')).toBe(false);
    expect(outcome(r, 'e')).toBe('NOT-ATTEMPTED');
  });

  it('names a crashed package by its npm name, not its directory', () => {
    const r = runWaves({ d: 'crash' });
    expect(r.failed).toEqual(['d']);
    expect(outcome(r, 'd')).toBe('CRASH(exit 7)');
  });
});
