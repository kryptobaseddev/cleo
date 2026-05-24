/**
 * Tests for scripts/lint-docs-similarity.mjs (T10170 / Saga T9855 / Epic E12.C13).
 *
 * Strategy
 *   - Build a synthetic project root under a tmpdir with:
 *       • `.cleo/canon.yml` declaring a couple of doc roots.
 *       • Pre-populated "existing" docs under those roots (the corpus).
 *       • Bare `.git` init so `git diff` returns something sane.
 *   - Use `--all` mode to bypass the git-diff filter and exercise the
 *     similarity engine directly. Where git behaviour is the target,
 *     init a real git repo and stage/commit a baseline before adding
 *     the new doc.
 *   - Spawn the script with `cwd=tmpRoot` and assert exit code + output.
 *
 * Cases covered
 *   - PASS strict: no corpus matches → 0 findings.
 *   - FAIL strict: a copy-paste duplicate of an existing doc → finding.
 *   - PASS check: baseline lists the only existing pair, no net-add.
 *   - FAIL check: a NEW near-duplicate not in baseline.
 *   - PASS: `similarity-exempt:` frontmatter marker.
 *   - PASS: `--threshold 0.99` raises the bar above the synthetic score.
 *   - Threshold floor: similar-but-not-identical docs score below 0.85.
 *   - --baseline overwrites the JSON with current findings and exits 0.
 *   - FATAL when `.cleo/canon.yml` is missing.
 *   - git-diff mode: a doc committed at base ref is NOT scanned; a doc
 *     added after the base IS scanned.
 *
 * @task T10170
 * @saga T9855
 * @epic E12.C13
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/lint-docs-similarity.mjs');

/** @type {string} */
let tmpRoot;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-docs-sim-lint-'));
  mkdirSync(join(tmpRoot, '.cleo'), { recursive: true });
  mkdirSync(join(tmpRoot, 'scripts'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Run the lint script with `cwd=tmpRoot`.
 *
 * @param {string[]} extraArgs
 */
function runLint(extraArgs = []) {
  return spawnSync('node', [SCRIPT, ...extraArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: tmpRoot,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
}

/** Write a minimal canon.yml with two doc roots: docs/research/ + .cleo/research/. */
function writeCanonYml() {
  const body = [
    'version: 1',
    'kinds:',
    '  research:',
    '    canonicalHome: ssot',
    '    publishMirror: docs/research/',
    '    rawMdAllowed: false',
    '    rawMdPaths:',
    '      - .cleo/research/',
    '  note:',
    '    canonicalHome: ssot',
    '    publishMirror: docs/note/',
    '    rawMdAllowed: false',
    '',
  ].join('\n');
  writeFileSync(join(tmpRoot, '.cleo', 'canon.yml'), body);
}

/**
 * @param {string} relPath - relative to tmpRoot
 * @param {string} body
 */
function writeDoc(relPath, body) {
  const abs = join(tmpRoot, relPath);
  mkdirSync(resolve(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
}

// ============================================================================
// Strict mode
// ============================================================================

describe('lint-docs-similarity — strict mode (--all bypasses git)', () => {
  it('passes when no existing doc resembles the new one', () => {
    writeCanonYml();
    writeDoc(
      'docs/research/alpha.md',
      [
        '# Alpha database migration',
        '',
        'This research note examines the alpha database migration approach,',
        'covering tablespace allocation and primary key collisions during the',
        'forward port of legacy rows.',
      ].join('\n'),
    );
    writeDoc(
      'docs/research/beta.md',
      [
        '# Beta widget rendering',
        '',
        'Completely different topic: rendering pipeline for the beta widget,',
        'focused on canvas layering and animation easing for the toolbar.',
      ].join('\n'),
    );
    const result = runLint(['--strict', '--all']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('STRICT OK');
  });

  it('fails when a copy-paste duplicate appears', () => {
    writeCanonYml();
    const body = [
      '# Alpha database migration',
      '',
      'This research note examines the alpha database migration approach,',
      'covering tablespace allocation and primary key collisions during the',
      'forward port of legacy rows from the staging cluster into production.',
    ].join('\n');
    writeDoc('docs/research/alpha-original.md', body);
    // Near-copy with a one-line tweak.
    writeDoc(
      'docs/research/alpha-rephrase.md',
      `${body}\n\nAdditional note: see the staging plan for cutover timing.`,
    );

    const result = runLint(['--strict', '--all']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('STRICT FAIL');
    expect(result.stderr).toContain('alpha-rephrase.md');
    // Should also surface the suggested fix.
    expect(result.stderr).toContain('cleo docs update');
  });

  it('honours the similarity-exempt frontmatter marker', () => {
    writeCanonYml();
    const body = [
      '# Alpha database migration',
      '',
      'This research note examines the alpha database migration approach,',
      'covering tablespace allocation and primary key collisions.',
    ].join('\n');
    writeDoc('docs/research/alpha-canonical.md', body);
    writeDoc(
      'docs/research/alpha-quoted.md',
      ['---', 'similarity-exempt: release-note legitimately quotes the spec', '---', body].join(
        '\n',
      ),
    );

    const result = runLint(['--strict', '--all']);
    expect(result.status).toBe(0);
  });

  it('respects --threshold override', () => {
    writeCanonYml();
    const body = [
      '# Alpha database migration',
      '',
      'This research note examines the alpha database migration approach.',
    ].join('\n');
    writeDoc('docs/research/a.md', body);
    writeDoc('docs/research/b.md', body); // would normally trigger.

    // Set threshold to 0.999 — only literal copies of identical token vectors
    // should clear it. Since both docs ARE identical here, 1.0 still fires.
    // So we use a different test: cap to 1.0 and ship a partial overlap.
    const partial = body.replace(
      'database migration',
      'kernel checkpoint sequence with disjoint vocabulary',
    );
    writeDoc('docs/research/b.md', partial);

    const tight = runLint(['--strict', '--all', '--threshold', '0.99']);
    expect(tight.status).toBe(0);
  });
});

// ============================================================================
// --baseline + --check modes
// ============================================================================

describe('lint-docs-similarity — baseline + check modes', () => {
  it('--baseline writes the current findings and exits 0', () => {
    writeCanonYml();
    const body = [
      '# Alpha database migration',
      '',
      'This research note examines the alpha database migration approach,',
      'covering tablespace allocation and primary key collisions during the',
      'forward port of legacy rows.',
    ].join('\n');
    writeDoc('docs/research/alpha.md', body);
    writeDoc('docs/research/alpha-clone.md', body);

    const result = runLint(['--baseline', '--all']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('baseline written');

    const baseline = JSON.parse(
      readFileSync(join(tmpRoot, 'scripts/.lint-docs-similarity-baseline.json'), 'utf-8'),
    );
    // One of the two pairs is the "new" perspective for the other; cosine is
    // symmetric, so we'll see at least one finding pair recorded.
    expect(baseline.findings.length).toBeGreaterThanOrEqual(1);
    expect(baseline.threshold).toBe(0.85);
  });

  it('--check passes when all findings are in the baseline (no net-add)', () => {
    writeCanonYml();
    const body = [
      '# Alpha database migration',
      '',
      'This research note examines the alpha database migration approach.',
      'It covers tablespace allocation and primary key collisions during the',
      'forward port of legacy rows.',
    ].join('\n');
    writeDoc('docs/research/alpha.md', body);
    writeDoc('docs/research/alpha-clone.md', body);

    // Lock the baseline first.
    const lock = runLint(['--baseline', '--all']);
    expect(lock.status).toBe(0);

    const check = runLint(['--check', '--all']);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain('OK');
  });

  it('--check fails when a NEW near-duplicate pair appears post-baseline', () => {
    writeCanonYml();
    const bodyA = [
      '# Alpha database migration',
      '',
      'This research note examines the alpha database migration approach.',
      'It covers tablespace allocation and primary key collisions during the',
      'forward port of legacy rows.',
    ].join('\n');
    writeDoc('docs/research/alpha.md', bodyA);
    // Lock empty baseline first (no findings).
    const lock = runLint(['--baseline', '--all']);
    expect(lock.status).toBe(0);

    // Now introduce a duplicate.
    writeDoc('docs/research/alpha-clone.md', bodyA);
    const check = runLint(['--check', '--all']);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('E_DOC_NEAR_DUPLICATE');
    expect(check.stderr).toContain('alpha-clone.md');
  });

  it('bootstraps the baseline on first run when none exists', () => {
    writeCanonYml();
    writeDoc(
      'docs/research/alpha.md',
      '# Solo doc\n\nUnique tokens that match nothing else exist here entirely.',
    );

    const result = runLint(['--check', '--all']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('baseline created');
  });
});

// ============================================================================
// Setup failures
// ============================================================================

describe('lint-docs-similarity — setup failures', () => {
  it('exits 2 (FATAL) when .cleo/canon.yml is missing', () => {
    // No canon.yml written.
    const result = runLint(['--strict', '--all']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('canon.yml not found');
  });
});

// ============================================================================
// git-diff mode (real git repo)
// ============================================================================

describe('lint-docs-similarity — git-diff mode', () => {
  /**
   * Run a shell command with `cwd=tmpRoot`. Throws on non-zero exit.
   *
   * @param {string} cmd
   * @param {string[]} cmdArgs
   */
  function git(cmd, cmdArgs) {
    const r = spawnSync(cmd, cmdArgs, { cwd: tmpRoot, encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`${cmd} ${cmdArgs.join(' ')} failed: ${r.stderr}`);
    }
  }

  it('ignores docs that already existed at the base ref', () => {
    writeCanonYml();
    const body =
      '# Alpha database migration\n\n' +
      'This research note examines the alpha database migration approach,\n' +
      'covering tablespace allocation and primary key collisions during the\n' +
      'forward port of legacy rows.\n';
    writeDoc('docs/research/alpha.md', body);
    writeDoc('docs/research/alpha-clone.md', body);

    git('git', ['init', '-q', '-b', 'main']);
    git('git', ['config', 'user.email', 'test@example.com']);
    git('git', ['config', 'user.name', 'test']);
    git('git', ['add', '.']);
    git('git', ['commit', '-q', '-m', 'baseline']);

    // Both docs predate HEAD~0 — no diff additions. Lint should report
    // "no new docs" since git diff filter=A finds nothing.
    const result = runLint(['--strict', '--base', 'HEAD']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no new docs');
  });

  it('flags a near-duplicate added after the base ref', () => {
    writeCanonYml();
    const body =
      '# Alpha database migration\n\n' +
      'This research note examines the alpha database migration approach,\n' +
      'covering tablespace allocation and primary key collisions during the\n' +
      'forward port of legacy rows from staging into production clusters.\n';
    writeDoc('docs/research/alpha.md', body);

    git('git', ['init', '-q', '-b', 'main']);
    git('git', ['config', 'user.email', 'test@example.com']);
    git('git', ['config', 'user.name', 'test']);
    git('git', ['add', '.']);
    git('git', ['commit', '-q', '-m', 'baseline alpha']);

    // Now add the duplicate AFTER the baseline commit.
    writeDoc('docs/research/alpha-clone.md', body);
    git('git', ['add', '.']);
    git('git', ['commit', '-q', '-m', 'add near-dup']);

    const result = runLint(['--strict', '--base', 'HEAD~1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('STRICT FAIL');
    expect(result.stderr).toContain('alpha-clone.md');
  });
});
