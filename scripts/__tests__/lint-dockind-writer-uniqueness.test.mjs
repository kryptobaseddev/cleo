/**
 * Tests for scripts/lint-dockind-writer-uniqueness.mjs (T10369).
 *
 * Strategy:
 *   - Build a synthetic project root under a tmpdir with the three input
 *     surfaces the script reads (registry, contracts taxonomy, canon.yml).
 *   - Vary each input to exercise schema-parity branches.
 *   - Add a synthetic packages/core/src/<file>.ts under the tmpdir to
 *     exercise the unregistered-md-write branch (baseline / strict modes).
 *   - Spawn the script with `cwd=tmpRoot` and assert exit code + stderr.
 *
 * Cases covered:
 *   - PASS schema: registry has every BUILTIN_DOC_KIND, mode/canonicalHome
 *     match exactly.
 *   - FAIL schema (dockind-coverage-missing): contracts adds a new kind,
 *     registry does not.
 *   - FAIL schema (canon-yml-ssot-first-drift): descriptor mode='ssot-first'
 *     but canon.yml has canonicalHome='ssot'.
 *   - PASS baseline (zero violations).
 *   - PASS baseline (existing entry already counted).
 *   - FAIL baseline (NEW unregistered .md write outside allowlist).
 *   - PASS strict (zero violations).
 *   - FAIL strict (any violation present).
 *   - --update-baseline overwrites JSON with current counts and exits 0.
 *
 * @task T10369
 * @epic T10290
 * @saga T10288
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/lint-dockind-writer-uniqueness.mjs');

/** Synthetic project root used as cwd for each spawn. */
let tmpRoot;
let registryDir;
let contractsDir;
let cleoDir;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-dockind-writer-lint-'));
  registryDir = join(tmpRoot, 'packages', 'core', 'src', 'docs');
  contractsDir = join(tmpRoot, 'packages', 'contracts', 'src');
  cleoDir = join(tmpRoot, '.cleo');
  mkdirSync(registryDir, { recursive: true });
  mkdirSync(contractsDir, { recursive: true });
  mkdirSync(cleoDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function runLint(extraArgs = []) {
  return spawnSync('node', [SCRIPT, ...extraArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: tmpRoot,
  });
}

/**
 * Default ten-entry DESCRIPTORS body matching the canonical registry.
 */
const CANONICAL_DESCRIPTORS = [
  { kind: 'adr', mode: 'ssot' },
  { kind: 'spec', mode: 'ssot' },
  { kind: 'research', mode: 'ssot' },
  { kind: 'handoff', mode: 'ssot' },
  { kind: 'note', mode: 'ssot' },
  { kind: 'llm-readme', mode: 'system-managed' },
  { kind: 'changeset', mode: 'ssot-first' },
  { kind: 'release-note', mode: 'system-managed' },
  { kind: 'plan', mode: 'ssot' },
  { kind: 'rcasd', mode: 'ssot' },
];

function descriptorBlock({ kind, mode }) {
  return (
    `  {\n` +
    `    kind: '${kind}',\n` +
    `    verb: 'docs add',\n` +
    `    dispatchOp: 'docs.add',\n` +
    `    coreFn: 'docs.add (dispatch handler)',\n` +
    `    mode: '${mode}',\n` +
    `    sourcePath: 'packages/cleo/src/dispatch/domains/docs.ts',\n` +
    `  },`
  );
}

function writeRegistry(descriptors = CANONICAL_DESCRIPTORS) {
  const body =
    `// synthetic writer-registry.ts for tests\n` +
    `const DESCRIPTORS = Object.freeze([\n` +
    descriptors.map(descriptorBlock).join('\n') +
    `\n]);\n`;
  writeFileSync(join(registryDir, 'writer-registry.ts'), body);
}

function writeContracts(kinds = CANONICAL_DESCRIPTORS.map((d) => d.kind)) {
  const body =
    `// synthetic docs-taxonomy.ts for tests\n` +
    `export const BUILTIN_DOC_KINDS = [\n` +
    kinds.map((k) => `  { kind: '${k}', publishDir: 'docs/${k}/' },`).join('\n') +
    `\n];\n`;
  writeFileSync(join(contractsDir, 'docs-taxonomy.ts'), body);
}

function writeCanonYml(homes = { changeset: 'ssot-first' }) {
  const lines = ['version: 1', 'kinds:'];
  for (const kind of CANONICAL_DESCRIPTORS.map((d) => d.kind)) {
    lines.push(`  ${kind}:`);
    lines.push(`    canonicalHome: ${homes[kind] ?? 'ssot'}`);
  }
  writeFileSync(join(cleoDir, 'canon.yml'), lines.join('\n') + '\n');
}

function writeBaseline(total = 0, counts = { 'unregistered-md-write': 0 }) {
  writeFileSync(
    join(tmpRoot, '.lint-dockind-writer-baseline.json'),
    JSON.stringify({ counts, total, violations: [], updatedAt: '2026-01-01T00:00:00Z' }, null, 2),
  );
}

// ============================================================================
// Schema parity — registry coverage + canon.yml alignment
// ============================================================================

describe('lint-dockind-writer-uniqueness — schema parity', () => {
  it('passes when registry, contracts, and canon.yml all agree', () => {
    writeRegistry();
    writeContracts();
    writeCanonYml();
    writeBaseline();
    const result = runLint();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK');
  });

  it('fails when a BUILTIN_DOC_KIND has no descriptor', () => {
    // Contracts adds 'mystery-kind' but registry doesn't.
    writeRegistry();
    writeContracts([...CANONICAL_DESCRIPTORS.map((d) => d.kind), 'mystery-kind']);
    writeCanonYml();
    const result = runLint();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dockind-coverage-missing');
    expect(result.stderr).toContain('mystery-kind');
  });

  it('fails when a descriptor mode=ssot-first does NOT match canon.yml', () => {
    writeRegistry();
    writeContracts();
    // canon.yml has changeset=ssot (drift from descriptor mode='ssot-first')
    writeCanonYml({ changeset: 'ssot' });
    const result = runLint();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('canon-yml-ssot-first-drift');
    expect(result.stderr).toContain('changeset');
  });

  it('fails when canon.yml has ssot-first but registry does not', () => {
    // Force a kind in canon.yml to ssot-first that the registry has as ssot
    writeRegistry(); // adr is mode='ssot' here
    writeContracts();
    writeCanonYml({ changeset: 'ssot-first', adr: 'ssot-first' });
    const result = runLint();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('canon-yml-ssot-first-drift');
    expect(result.stderr).toContain('adr');
  });

  it('FATAL when registry file is missing', () => {
    // do NOT write registry
    writeContracts();
    writeCanonYml();
    const result = runLint();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('registry not found');
  });
});

// ============================================================================
// Baseline mode (default)
// ============================================================================

describe('lint-dockind-writer-uniqueness — baseline mode', () => {
  beforeEach(() => {
    writeRegistry();
    writeContracts();
    writeCanonYml();
  });

  it('bootstraps a baseline file on first run when none exists', () => {
    const result = runLint();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('baseline created');
    const baseline = JSON.parse(
      readFileSync(join(tmpRoot, '.lint-dockind-writer-baseline.json'), 'utf-8'),
    );
    expect(baseline.total).toBe(0);
  });

  it('exits 0 when there are zero violations and the baseline is also zero', () => {
    writeBaseline();
    const result = runLint();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK');
  });

  it('exits 1 when a NEW unregistered .md write appears (net-add over baseline)', () => {
    writeBaseline(); // baseline = 0
    // Introduce a violation outside the allowlist.
    const violationDir = join(tmpRoot, 'packages', 'core', 'src', 'rogue');
    mkdirSync(violationDir, { recursive: true });
    writeFileSync(
      join(violationDir, 'writer.ts'),
      `import { writeFileSync } from 'node:fs';\n` +
        `export function bad() {\n` +
        `  writeFileSync('/tmp/leak.md', 'oops');\n` +
        `}\n`,
    );
    const result = runLint();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unregistered-md-write');
    expect(result.stderr).toContain('regressed');
  });

  it('honours the per-line opt-out comment // dockind-writer-allowed', () => {
    writeBaseline();
    const violationDir = join(tmpRoot, 'packages', 'core', 'src', 'rogue2');
    mkdirSync(violationDir, { recursive: true });
    writeFileSync(
      join(violationDir, 'writer.ts'),
      `import { writeFileSync } from 'node:fs';\n` +
        `export function tolerated() {\n` +
        `  writeFileSync('/tmp/ok.md', 'fine'); // dockind-writer-allowed: e2e fixture\n` +
        `}\n`,
    );
    const result = runLint();
    expect(result.status).toBe(0);
  });

  it('skips .test.ts files even outside __tests__', () => {
    writeBaseline();
    const violationDir = join(tmpRoot, 'packages', 'core', 'src', 'rogue3');
    mkdirSync(violationDir, { recursive: true });
    writeFileSync(
      join(violationDir, 'thing.test.ts'),
      `import { writeFileSync } from 'node:fs';\n` +
        `writeFileSync('/tmp/spec.md', 'test fixture');\n`,
    );
    const result = runLint();
    expect(result.status).toBe(0);
  });

  it('skips __tests__/ subdirectories', () => {
    writeBaseline();
    const testsDir = join(tmpRoot, 'packages', 'core', 'src', 'foo', '__tests__');
    mkdirSync(testsDir, { recursive: true });
    writeFileSync(
      join(testsDir, 'fixture.ts'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync('/tmp/x.md', '');\n`,
    );
    const result = runLint();
    expect(result.status).toBe(0);
  });
});

// ============================================================================
// Strict mode
// ============================================================================

describe('lint-dockind-writer-uniqueness — strict mode', () => {
  beforeEach(() => {
    writeRegistry();
    writeContracts();
    writeCanonYml();
  });

  it('passes when there are zero violations', () => {
    const result = runLint(['--strict']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('STRICT OK');
  });

  it('fails on ANY violation, even at the baseline count', () => {
    writeBaseline(5, { 'unregistered-md-write': 5 });
    const violationDir = join(tmpRoot, 'packages', 'core', 'src', 'rogue4');
    mkdirSync(violationDir, { recursive: true });
    writeFileSync(
      join(violationDir, 'writer.ts'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync('/tmp/leak.md', 'x');\n`,
    );
    const result = runLint(['--strict']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('STRICT FAIL');
  });
});

// ============================================================================
// Update-baseline mode
// ============================================================================

describe('lint-dockind-writer-uniqueness — update-baseline', () => {
  it('--update-baseline writes current counts and exits 0', () => {
    writeRegistry();
    writeContracts();
    writeCanonYml();
    const result = runLint(['--update-baseline']);
    expect(result.status).toBe(0);
    const baseline = JSON.parse(
      readFileSync(join(tmpRoot, '.lint-dockind-writer-baseline.json'), 'utf-8'),
    );
    expect(baseline.total).toBe(0);
    expect(baseline.counts['unregistered-md-write']).toBe(0);
  });

  it('--baseline is an alias for --update-baseline', () => {
    writeRegistry();
    writeContracts();
    writeCanonYml();
    const result = runLint(['--baseline']);
    expect(result.status).toBe(0);
    const baseline = JSON.parse(
      readFileSync(join(tmpRoot, '.lint-dockind-writer-baseline.json'), 'utf-8'),
    );
    expect(baseline.total).toBe(0);
  });
});
