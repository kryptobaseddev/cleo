/**
 * Tests for workspace-aware version-bump auto-discovery.
 *
 * Validates the fix for the dogfooded `cleo release ship v2026.5.63` bug
 * where Step 0 silently skipped the version bump because the project did
 * not declare `release.versionBump.files` in `.cleo/config.json`. The
 * engine now auto-discovers workspace package.json (node) and Cargo.toml
 * (rust) targets, respects `.cleo/project-context.json` ecosystem hints,
 * and honours an explicit `release.versionBump.autoDiscover: false` opt-out.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bumpVersionFromConfig,
  discoverWorkspacePackageJsonFiles,
  resolveVersionBumpTargets,
} from '../version-bump.js';

let ROOT: string;

function writeJson(p: string, body: unknown): void {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(body, null, 2), 'utf-8');
}

function writeFile(p: string, body: string): void {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body, 'utf-8');
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'cleo-vbump-'));
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe('discoverWorkspacePackageJsonFiles — node workspaces', () => {
  it('returns empty array when no workspace markers exist', () => {
    writeJson(join(ROOT, 'package.json'), { name: 'lonely', version: '1.0.0' });
    expect(discoverWorkspacePackageJsonFiles(ROOT)).toEqual([]);
  });

  it('detects pnpm-workspace.yaml and discovers packages/*/package.json', () => {
    writeJson(join(ROOT, 'package.json'), { name: 'root', version: '2026.5.63' });
    writeFile(join(ROOT, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    writeJson(join(ROOT, 'packages', 'alpha', 'package.json'), {
      name: '@x/alpha',
      version: '2026.5.63',
    });
    writeJson(join(ROOT, 'packages', 'beta', 'package.json'), {
      name: '@x/beta',
      version: '2026.5.63',
    });

    const targets = discoverWorkspacePackageJsonFiles(ROOT);
    const files = targets.map((t) => t.file).sort();
    expect(files).toEqual([
      'package.json',
      'packages/alpha/package.json',
      'packages/beta/package.json',
    ]);
    for (const t of targets) {
      expect(t.strategy).toBe('json');
      expect(t.field).toBe('version');
    }
  });

  it('detects yarn/npm workspaces declared in root package.json', () => {
    writeJson(join(ROOT, 'package.json'), {
      name: 'root',
      version: '1.0.0',
      workspaces: ['packages/*'],
    });
    writeJson(join(ROOT, 'packages', 'one', 'package.json'), { name: 'one', version: '1.0.0' });
    const files = discoverWorkspacePackageJsonFiles(ROOT).map((t) => t.file);
    expect(files).toContain('package.json');
    expect(files).toContain('packages/one/package.json');
  });

  it('skips empty package directories', () => {
    writeJson(join(ROOT, 'package.json'), {
      name: 'root',
      version: '1.0.0',
      workspaces: ['packages/*'],
    });
    mkdirSync(join(ROOT, 'packages', 'empty'), { recursive: true });
    const files = discoverWorkspacePackageJsonFiles(ROOT).map((t) => t.file);
    expect(files).toEqual(['package.json']);
  });
});

describe('discoverWorkspacePackageJsonFiles — rust workspaces', () => {
  it('detects Cargo [workspace] members and emits toml targets', () => {
    writeFile(
      join(ROOT, 'Cargo.toml'),
      `[workspace]
members = [
  "crates/foo",
  "crates/bar",
]
`,
    );
    writeFile(
      join(ROOT, 'crates', 'foo', 'Cargo.toml'),
      `[package]
name = "foo"
version = "0.1.0"
`,
    );
    writeFile(
      join(ROOT, 'crates', 'bar', 'Cargo.toml'),
      `[package]
name = "bar"
version = "0.1.0"
`,
    );

    const targets = discoverWorkspacePackageJsonFiles(ROOT);
    const files = targets.map((t) => t.file).sort();
    expect(files).toEqual(['crates/bar/Cargo.toml', 'crates/foo/Cargo.toml']);
    for (const t of targets) {
      expect(t.strategy).toBe('toml');
      expect(t.key).toBe('version');
    }
  });

  it('includes root Cargo.toml when it carries a [package] version', () => {
    writeFile(
      join(ROOT, 'Cargo.toml'),
      `[package]
name = "root"
version = "0.1.0"

[workspace]
members = ["crates/foo"]
`,
    );
    writeFile(
      join(ROOT, 'crates', 'foo', 'Cargo.toml'),
      `[package]
name = "foo"
version = "0.1.0"
`,
    );
    const files = discoverWorkspacePackageJsonFiles(ROOT)
      .map((t) => t.file)
      .sort();
    expect(files).toEqual(['Cargo.toml', 'crates/foo/Cargo.toml']);
  });

  it('skips members with version.workspace = true (inheritance) — only roots workspace.package', () => {
    // Modern Cargo convention: shared version lives in root [workspace.package],
    // members declare `version.workspace = true`. The bumper must target ONLY
    // the root — bumping the member's inheritance directive is a no-op.
    writeFile(
      join(ROOT, 'Cargo.toml'),
      `[workspace]
members = ["crates/foo", "crates/bar"]

[workspace.package]
edition = "2021"
version = "0.1.0"
`,
    );
    writeFile(
      join(ROOT, 'crates', 'foo', 'Cargo.toml'),
      `[package]
name = "foo"
edition.workspace = true
version.workspace = true
`,
    );
    writeFile(
      join(ROOT, 'crates', 'bar', 'Cargo.toml'),
      `[package]
name = "bar"
edition.workspace = true
version.workspace = true
`,
    );

    const targets = discoverWorkspacePackageJsonFiles(ROOT);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.file).toBe('Cargo.toml');
    expect(targets[0]?.section).toBe('workspace.package');

    // End-to-end bump should change ONLY the root [workspace.package] version
    const result = bumpVersionFromConfig('0.9.0', { dryRun: false }, ROOT);
    expect(result.allSuccess).toBe(true);
    expect(result.results[0]?.previousVersion).toBe('0.1.0');
    expect(result.results[0]?.newVersion).toBe('0.9.0');

    const rootAfter = readFileSync(join(ROOT, 'Cargo.toml'), 'utf-8');
    expect(rootAfter).toContain('version = "0.9.0"');
    const fooAfter = readFileSync(join(ROOT, 'crates', 'foo', 'Cargo.toml'), 'utf-8');
    expect(fooAfter).toContain('version.workspace = true'); // unchanged
  });

  it('mixes workspace-inheritance root + members that override with explicit version', () => {
    writeFile(
      join(ROOT, 'Cargo.toml'),
      `[workspace]
members = ["crates/shared", "crates/standalone"]

[workspace.package]
version = "0.1.0"
`,
    );
    writeFile(
      join(ROOT, 'crates', 'shared', 'Cargo.toml'),
      `[package]
name = "shared"
version.workspace = true
`,
    );
    writeFile(
      join(ROOT, 'crates', 'standalone', 'Cargo.toml'),
      `[package]
name = "standalone"
version = "0.5.0"
`,
    );

    const targets = discoverWorkspacePackageJsonFiles(ROOT);
    const files = targets.map((t) => t.file).sort();
    expect(files).toEqual(['Cargo.toml', 'crates/standalone/Cargo.toml']);
  });

  it('skips glob members (requires deeper resolution)', () => {
    writeFile(
      join(ROOT, 'Cargo.toml'),
      `[workspace]
members = ["crates/*"]
`,
    );
    writeFile(
      join(ROOT, 'crates', 'foo', 'Cargo.toml'),
      `[package]
name = "foo"
version = "0.1.0"
`,
    );
    expect(discoverWorkspacePackageJsonFiles(ROOT)).toEqual([]);
  });
});

describe('discoverWorkspacePackageJsonFiles — multi-language', () => {
  it('merges node + rust targets when project-context declares both', () => {
    writeJson(join(ROOT, '.cleo', 'project-context.json'), {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['node', 'rust'],
      primaryType: 'node',
      monorepo: true,
    });
    writeJson(join(ROOT, 'package.json'), {
      name: 'root',
      version: '1.0.0',
      workspaces: ['packages/*'],
    });
    writeJson(join(ROOT, 'packages', 'a', 'package.json'), { name: 'a', version: '1.0.0' });
    writeFile(
      join(ROOT, 'Cargo.toml'),
      `[workspace]
members = ["crates/c"]
`,
    );
    writeFile(
      join(ROOT, 'crates', 'c', 'Cargo.toml'),
      `[package]
name = "c"
version = "0.1.0"
`,
    );

    const files = discoverWorkspacePackageJsonFiles(ROOT)
      .map((t) => t.file)
      .sort();
    expect(files).toEqual(['crates/c/Cargo.toml', 'package.json', 'packages/a/package.json']);
  });

  it('treats bun/deno as node-family — probes JS workspace markers', () => {
    writeJson(join(ROOT, '.cleo', 'project-context.json'), {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['bun'],
      primaryType: 'bun',
      monorepo: true,
    });
    writeJson(join(ROOT, 'package.json'), {
      name: 'root',
      version: '1.0.0',
      workspaces: ['packages/*'],
    });
    writeJson(join(ROOT, 'packages', 'a', 'package.json'), { name: 'a', version: '1.0.0' });

    const files = discoverWorkspacePackageJsonFiles(ROOT).map((t) => t.file);
    expect(files).toContain('package.json');
    expect(files).toContain('packages/a/package.json');
  });

  it('respects ProjectContext.primaryType: skips rust discovery for node-only project', () => {
    writeJson(join(ROOT, '.cleo', 'project-context.json'), {
      schemaVersion: '1.0.0',
      detectedAt: new Date().toISOString(),
      projectTypes: ['node'],
      primaryType: 'node',
      monorepo: true,
    });
    writeJson(join(ROOT, 'package.json'), {
      name: 'root',
      version: '1.0.0',
      workspaces: ['packages/*'],
    });
    writeFile(
      join(ROOT, 'Cargo.toml'),
      `[workspace]
members = ["crates/c"]
`,
    );
    writeFile(
      join(ROOT, 'crates', 'c', 'Cargo.toml'),
      `[package]
name = "c"
version = "0.1.0"
`,
    );

    const files = discoverWorkspacePackageJsonFiles(ROOT).map((t) => t.file);
    expect(files).toContain('package.json');
    expect(files).not.toContain('crates/c/Cargo.toml');
  });
});

describe('resolveVersionBumpTargets — preference order', () => {
  it('prefers explicit release.versionBump.files config over auto-discovery', () => {
    writeJson(join(ROOT, '.cleo', 'config.json'), {
      release: {
        versionBump: {
          files: [{ path: 'VERSION', strategy: 'plain' }],
        },
      },
    });
    writeJson(join(ROOT, 'package.json'), {
      name: 'root',
      version: '1.0.0',
      workspaces: ['packages/*'],
    });
    writeJson(join(ROOT, 'packages', 'a', 'package.json'), { name: 'a', version: '1.0.0' });

    const result = resolveVersionBumpTargets(ROOT);
    expect(result.source).toBe('config');
    expect(result.targets.map((t) => t.file)).toEqual(['VERSION']);
  });

  it('falls back to workspace auto-discovery when config is empty', () => {
    writeJson(join(ROOT, '.cleo', 'config.json'), {});
    writeJson(join(ROOT, 'package.json'), {
      name: 'root',
      version: '1.0.0',
      workspaces: ['packages/*'],
    });
    writeJson(join(ROOT, 'packages', 'a', 'package.json'), { name: 'a', version: '1.0.0' });

    const result = resolveVersionBumpTargets(ROOT);
    expect(result.source).toBe('workspace');
    expect(result.targets.map((t) => t.file).sort()).toEqual([
      'package.json',
      'packages/a/package.json',
    ]);
  });

  it('returns none when release.versionBump.autoDiscover is false', () => {
    writeJson(join(ROOT, '.cleo', 'config.json'), {
      release: { versionBump: { autoDiscover: false } },
    });
    writeJson(join(ROOT, 'package.json'), {
      name: 'root',
      version: '1.0.0',
      workspaces: ['packages/*'],
    });
    writeJson(join(ROOT, 'packages', 'a', 'package.json'), { name: 'a', version: '1.0.0' });

    const result = resolveVersionBumpTargets(ROOT);
    expect(result.source).toBe('none');
    expect(result.targets).toEqual([]);
  });

  it('returns none when project has no workspace markers at all', () => {
    // Empty ROOT — no package.json, no Cargo.toml, no .cleo/
    const result = resolveVersionBumpTargets(ROOT);
    expect(result.source).toBe('none');
    expect(result.targets).toEqual([]);
  });
});

describe('bumpVersionFromConfig — fails loud on silent no-op', () => {
  it('reports failure when explicit toml target has no matching version line', () => {
    // Explicit config pointing at an inheritance-only Cargo.toml — without the
    // loud-fail guard this would silently report success while changing nothing.
    writeJson(join(ROOT, '.cleo', 'config.json'), {
      release: {
        versionBump: {
          files: [{ path: 'Cargo.toml', strategy: 'toml', key: 'version' }],
        },
      },
    });
    writeFile(
      join(ROOT, 'Cargo.toml'),
      `[package]
name = "thing"
version.workspace = true
`,
    );

    const result = bumpVersionFromConfig('1.0.0', { dryRun: false }, ROOT);
    expect(result.allSuccess).toBe(false);
    expect(result.results[0]?.error).toMatch(/version\.workspace = true/);

    // File must NOT have been mutated
    const after = readFileSync(join(ROOT, 'Cargo.toml'), 'utf-8');
    expect(after).toContain('version.workspace = true');
    expect(after).not.toContain('version = "1.0.0"');
  });

  it('honours section field — bumps version inside the named section only', () => {
    writeJson(join(ROOT, '.cleo', 'config.json'), {
      release: {
        versionBump: {
          files: [
            { path: 'Cargo.toml', strategy: 'toml', key: 'version', section: 'workspace.package' },
          ],
        },
      },
    });
    writeFile(
      join(ROOT, 'Cargo.toml'),
      `[workspace]
members = []

[workspace.package]
version = "0.1.0"

[some-other]
version = "9.9.9"
`,
    );

    const result = bumpVersionFromConfig('0.2.0', { dryRun: false }, ROOT);
    expect(result.allSuccess).toBe(true);
    const after = readFileSync(join(ROOT, 'Cargo.toml'), 'utf-8');
    expect(after).toContain('[workspace.package]\nversion = "0.2.0"');
    expect(after).toContain('[some-other]\nversion = "9.9.9"'); // untouched
  });
});
