/**
 * Unit tests for the project-agnostic tool resolver (T1534 / ADR-061).
 *
 * Covers:
 *   - Canonical names (`test`, `build`, `lint`, ...) resolve from
 *     `.cleo/project-context.json` when populated.
 *   - Per-`primaryType` fallbacks fire when project-context.json is missing
 *     a command (or the file itself is absent).
 *   - Legacy aliases (`pnpm-test`, `tsc`, `biome`, ...) map to canonical and
 *     resolve identically.
 *   - Unknown tool names fail with `E_TOOL_UNKNOWN`.
 *   - The resolver works for non-Node project types (rust, python, go) so
 *     `@cleocode/core` is no longer hardcoded to TypeScript / pnpm.
 *
 * @task T1534
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CANONICAL_TOOLS, listValidToolNames, resolveToolCommand } from '../tool-resolver.js';

function writeProjectContext(root: string, ctx: Record<string, unknown>): void {
  mkdirSync(join(root, '.cleo'), { recursive: true });
  writeFileSync(join(root, '.cleo', 'project-context.json'), JSON.stringify(ctx, null, 2));
}

/**
 * Give the sandbox the toolchain markers a node project would really have.
 *
 * T12083 gates GUESSED language defaults on evidence that the project uses that
 * toolchain, so a test about language-default *provenance* has to be run in a
 * project where the default is applicable — otherwise it is a test about
 * applicability instead. The marker-less case is covered in
 * `tool-applicability.test.ts`.
 */
function writeNodeToolchain(root: string): void {
  writeFileSync(join(root, 'tsconfig.json'), '{}');
  writeFileSync(join(root, 'biome.json'), '{}');
}

describe('resolveToolCommand — project-context overrides', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-resolver-pc-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves test from testing.command', () => {
    writeProjectContext(dir, {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['node'],
      primaryType: 'node',
      monorepo: true,
      testing: { command: 'pnpm run test' },
    });
    const r = resolveToolCommand('test', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.canonical).toBe('test');
      expect(r.command.cmd).toBe('pnpm');
      expect(r.command.args).toEqual(['run', 'test']);
      expect(r.command.source).toBe('project-context');
    }
  });

  it('resolves build from build.command', () => {
    writeProjectContext(dir, {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['rust'],
      primaryType: 'rust',
      build: { command: 'cargo build --release' },
    });
    const r = resolveToolCommand('build', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.cmd).toBe('cargo');
      expect(r.command.args).toEqual(['build', '--release']);
      expect(r.command.source).toBe('project-context');
    }
  });

  it('legacy alias `pnpm-test` resolves to canonical test from project-context', () => {
    writeProjectContext(dir, {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['node'],
      primaryType: 'node',
      testing: { command: 'pnpm run test' },
    });
    const r = resolveToolCommand('pnpm-test', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.canonical).toBe('test');
      expect(r.command.displayName).toBe('pnpm-test');
      expect(r.command.cmd).toBe('pnpm');
      expect(r.command.source).toBe('legacy-alias');
    }
  });
});

describe('resolveToolCommand — language defaults (no project-context)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-resolver-lang-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to cargo for rust projects', () => {
    writeProjectContext(dir, {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['rust'],
      primaryType: 'rust',
    });
    const r = resolveToolCommand('test', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.cmd).toBe('cargo');
      expect(r.command.args).toEqual(['test']);
      expect(r.command.source).toBe('language-default');
      expect(r.command.primaryType).toBe('rust');
    }
  });

  it('falls back to pytest for python projects', () => {
    writeProjectContext(dir, {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['python'],
      primaryType: 'python',
    });
    const r = resolveToolCommand('test', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.cmd).toBe('pytest');
      expect(r.command.source).toBe('language-default');
    }
  });

  it('falls back to go test for go projects', () => {
    writeProjectContext(dir, {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['go'],
      primaryType: 'go',
    });
    const r = resolveToolCommand('test', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.cmd).toBe('go');
      expect(r.command.args).toEqual(['test', './...']);
    }
  });

  it('falls back to clippy for rust lint', () => {
    writeProjectContext(dir, {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['rust'],
      primaryType: 'rust',
    });
    const r = resolveToolCommand('lint', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.cmd).toBe('cargo');
      expect(r.command.args).toContain('clippy');
    }
  });

  it('legacy alias `tsc` resolves to canonical typecheck for node', () => {
    writeProjectContext(dir, {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['node'],
      primaryType: 'node',
    });
    writeNodeToolchain(dir);
    const r = resolveToolCommand('tsc', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.canonical).toBe('typecheck');
      expect(r.command.source).toBe('language-default');
    }
  });

  it('legacy alias `cargo-test` resolves to canonical test for rust', () => {
    writeProjectContext(dir, {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['rust'],
      primaryType: 'rust',
    });
    const r = resolveToolCommand('cargo-test', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.canonical).toBe('test');
      expect(r.command.cmd).toBe('cargo');
    }
  });
});

describe('resolveToolCommand — no project-context.json at all', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-resolver-bare-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects primaryType from cwd marker files (Cargo.toml → rust)', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
    const r = resolveToolCommand('test', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.primaryType).toBe('rust');
      expect(r.command.cmd).toBe('cargo');
    }
  });

  it('detects primaryType from cwd marker files (package.json → node)', () => {
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}');
    const r = resolveToolCommand('test', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.primaryType).toBe('node');
    }
  });

  it('detects primaryType from cwd marker files (pyproject.toml → python)', () => {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname="x"\n');
    const r = resolveToolCommand('test', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.primaryType).toBe('python');
      expect(r.command.cmd).toBe('pytest');
    }
  });

  it('returns unknown primaryType for empty directory and reports E_TOOL_UNAVAILABLE', () => {
    const r = resolveToolCommand('build', dir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codeName).toBe('E_TOOL_UNAVAILABLE');
    }
  });
});

describe('resolveToolCommand — error paths', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-resolver-err-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects unknown tool names', () => {
    writeFileSync(join(dir, 'package.json'), '{}');
    const r = resolveToolCommand('frobnicate', dir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codeName).toBe('E_TOOL_UNKNOWN');
      expect(r.reason).toMatch(/Unknown tool/);
    }
  });

  it('reports E_TOOL_UNAVAILABLE when language has no default for the canonical', () => {
    writeProjectContext(dir, {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['bash'],
      primaryType: 'bash',
    });
    // bash has only a `test` default; lint has none.
    const r = resolveToolCommand('lint', dir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codeName).toBe('E_TOOL_UNAVAILABLE');
    }
  });
});

describe('resolveToolCommand — T12027 generalized overrides (lint/typecheck/audit/security-scan)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-resolver-t12027-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves lint from project-context lint.command', () => {
    writeProjectContext(dir, {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['node'],
      primaryType: 'node',
      lint: { command: 'pnpm biome check --write .' },
    });
    const r = resolveToolCommand('lint', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.canonical).toBe('lint');
      expect(r.command.cmd).toBe('pnpm');
      expect(r.command.args).toEqual(['biome', 'check', '--write', '.']);
      expect(r.command.source).toBe('project-context');
    }
  });

  it('resolves typecheck from project-context typecheck.command', () => {
    writeProjectContext(dir, {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['node'],
      primaryType: 'node',
      typecheck: { command: 'pnpm exec tsc --noEmit' },
    });
    const r = resolveToolCommand('typecheck', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.canonical).toBe('typecheck');
      expect(r.command.cmd).toBe('pnpm');
      expect(r.command.args).toEqual(['exec', 'tsc', '--noEmit']);
      expect(r.command.source).toBe('project-context');
    }
  });

  it('resolves audit from project-context audit.command', () => {
    writeProjectContext(dir, {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['node'],
      primaryType: 'node',
      audit: { command: 'pnpm audit --prod' },
    });
    const r = resolveToolCommand('audit', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.canonical).toBe('audit');
      expect(r.command.cmd).toBe('pnpm');
      expect(r.command.args).toEqual(['audit', '--prod']);
      expect(r.command.source).toBe('project-context');
    }
  });

  it('resolves security-scan from project-context security-scan.command', () => {
    writeProjectContext(dir, {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['node'],
      primaryType: 'node',
      'security-scan': { command: 'snyk test' },
    });
    const r = resolveToolCommand('security-scan', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.canonical).toBe('security-scan');
      expect(r.command.cmd).toBe('snyk');
      expect(r.command.args).toEqual(['test']);
      expect(r.command.source).toBe('project-context');
    }
  });

  it('configured lint override prevents node language default', () => {
    writeProjectContext(dir, {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['node'],
      primaryType: 'node',
      lint: { command: 'eslint .' },
    });
    const r = resolveToolCommand('lint', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.cmd).toBe('eslint');
      // The node default would be 'npx biome check .' — must not be used.
      expect(r.command.args).not.toContain('biome');
      expect(r.command.source).toBe('project-context');
    }
  });

  it('configured typecheck override prevents node language default', () => {
    writeProjectContext(dir, {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['node'],
      primaryType: 'node',
      typecheck: { command: 'pyright .' },
    });
    const r = resolveToolCommand('typecheck', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.cmd).toBe('pyright');
      // The node default would be 'npx tsc --noEmit'
      expect(r.command.args).not.toContain('tsc');
    }
  });

  it('legacy alias `biome` resolves with legacy-alias provenance when lint.command override exists', () => {
    writeProjectContext(dir, {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['node'],
      primaryType: 'node',
      lint: { command: 'pnpm biome check --write .' },
    });
    const r = resolveToolCommand('biome', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.canonical).toBe('lint');
      expect(r.command.displayName).toBe('biome');
      expect(r.command.source).toBe('legacy-alias');
    }
  });

  it('legacy alias `tsc` resolves with legacy-alias provenance when typecheck.command override exists', () => {
    writeProjectContext(dir, {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['node'],
      primaryType: 'node',
      typecheck: { command: 'pnpm exec tsc --noEmit' },
    });
    const r = resolveToolCommand('tsc', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.canonical).toBe('typecheck');
      expect(r.command.displayName).toBe('tsc');
      expect(r.command.source).toBe('legacy-alias');
    }
  });

  it('legacy alias `eslint` resolves with legacy-alias provenance when lint.command override exists', () => {
    writeProjectContext(dir, {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['node'],
      primaryType: 'node',
      lint: { command: 'eslint .' },
    });
    const r = resolveToolCommand('eslint', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.canonical).toBe('lint');
      expect(r.command.displayName).toBe('eslint');
      expect(r.command.source).toBe('legacy-alias');
    }
  });

  it('falls through to language default when override object exists but command is empty', () => {
    writeProjectContext(dir, {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['node'],
      primaryType: 'node',
      lint: { command: '' },
    });
    writeNodeToolchain(dir);
    const r = resolveToolCommand('lint', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.source).toBe('language-default');
    }
  });

  it('falls through to language default when override object exists but no command key', () => {
    writeProjectContext(dir, {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['node'],
      primaryType: 'node',
      lint: {},
    });
    writeNodeToolchain(dir);
    const r = resolveToolCommand('lint', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.source).toBe('language-default');
    }
  });

  it('legacy alias `cargo-audit` resolves canonical audit with legacy-alias provenance from audit.command override', () => {
    writeProjectContext(dir, {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['node'],
      primaryType: 'node',
      audit: { command: 'pnpm audit --prod' },
    });
    const r = resolveToolCommand('cargo-audit', dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.canonical).toBe('audit');
      expect(r.command.source).toBe('legacy-alias');
    }
  });
});

describe('listValidToolNames', () => {
  it('includes every canonical name', () => {
    const names = listValidToolNames();
    for (const c of CANONICAL_TOOLS) {
      expect(names).toContain(c);
    }
  });

  it('includes legacy aliases for backwards compatibility', () => {
    const names = listValidToolNames();
    expect(names).toContain('pnpm-test');
    expect(names).toContain('tsc');
    expect(names).toContain('biome');
    expect(names).toContain('cargo-test');
    expect(names).toContain('pytest');
  });
});
