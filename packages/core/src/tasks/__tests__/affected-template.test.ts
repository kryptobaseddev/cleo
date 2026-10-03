/**
 * Deriving an affected-scope test template from a workspace-wide test command
 * (T13125). Live 2026-10-03: VidaPeps' `testing.command` was
 * `pnpm -r --no-bail --if-present run test` with no `affectedCommand`, so every
 * `cleo verify --evidence tool:test` ran the entire workspace, once per task.
 *
 * @task T13125
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAffectedTestCommand } from '../affected-packages.js';
import {
  isWorkspaceRoot,
  proposeAffectedCommand,
  resolveAffectedTemplate,
} from '../affected-template.js';

let root: string;

/** A workspace root: `pnpm-workspace.yaml` plus a root package.json. */
function workspace(rootScripts: Record<string, string> = {}, extra: object = {}): void {
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'root', private: true, scripts: rootScripts, ...extra }),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'affected-template-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('proposeAffectedCommand (T13125)', () => {
  it('the VidaPeps command: pnpm -r becomes {filters}, every other flag kept', () => {
    workspace();
    expect(proposeAffectedCommand(root, 'pnpm -r --no-bail --if-present run test')).toEqual({
      template: 'pnpm {filters} --no-bail --if-present run test',
      basis: 'pnpm -r --no-bail --if-present run test',
    });
    expect(proposeAffectedCommand(root, 'pnpm --recursive test')?.template).toBe(
      'pnpm {filters} test',
    );
  });

  it('reads a delegating command through the root test script', () => {
    workspace({ test: 'pnpm -r --no-bail run test' });
    for (const command of ['pnpm run test', 'pnpm test', 'npm test', 'npm t', undefined]) {
      expect(proposeAffectedCommand(root, command), String(command)).toEqual({
        template: 'pnpm {filters} --no-bail run test',
        basis: 'pnpm -r --no-bail run test',
      });
    }
  });

  it('npm workspaces and turbo', () => {
    workspace({}, { workspaces: ['packages/*'] });
    expect(proposeAffectedCommand(root, 'npm run test --workspaces --if-present')?.template).toBe(
      'npm run test {workspaces} --if-present',
    );
    expect(proposeAffectedCommand(root, 'turbo run test')?.template).toBe(
      'turbo run test {filters}',
    );
    expect(proposeAffectedCommand(root, 'pnpm turbo test')?.template).toBe(
      'pnpm turbo test {filters}',
    );
  });

  it('derives nothing it cannot derive mechanically', () => {
    workspace({ test: 'vitest run' });
    for (const command of [
      'pnpm run test', // the root script is not workspace-wide
      'pnpm exec vitest run', // one vitest process: its projects need {projects}
      'pnpm -r build', // not a test run
      'pnpm -r --filter @x/a test', // already narrowed
      'pnpm -r --include-workspace-root test', // would add the root's own (often whole-suite) test
      'turbo run test build', // more than the test task
      'turbo run test --affected', // already narrowed
      'pnpm -r test && echo done', // shell syntax
      'cargo test',
    ]) {
      expect(proposeAffectedCommand(root, command), command).toBeNull();
    }
  });

  it('derives nothing outside a workspace', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'solo' }));
    expect(isWorkspaceRoot(root)).toBe(false);
    expect(proposeAffectedCommand(root, 'pnpm -r test')).toBeNull();
  });

  it('quotes a word with spaces so the template splits back to the same argv', () => {
    workspace();
    const proposal = proposeAffectedCommand(root, `pnpm -r --reporter 'a b' run test`);
    expect(proposal?.template).toBe(`pnpm {filters} --reporter 'a b' run test`);
    expect(buildAffectedTestCommand(proposal?.template ?? '', ['@x/a'])).toEqual({
      cmd: 'pnpm',
      args: ['--filter', '@x/a', '--reporter', 'a b', 'run', 'test'],
    });
  });
});

describe('resolveAffectedTemplate (T13125)', () => {
  it('a declared template wins, then a derived one, else none', () => {
    workspace();
    expect(
      resolveAffectedTemplate(
        { affectedCommand: 'pnpm exec vitest run {projects}', command: 'pnpm -r test' },
        root,
      ),
    ).toEqual({ template: 'pnpm exec vitest run {projects}', source: 'declared', basis: null });
    expect(resolveAffectedTemplate({ command: 'pnpm -r test' }, root)).toEqual({
      template: 'pnpm {filters} test',
      source: 'derived',
      basis: 'pnpm -r test',
    });
    expect(resolveAffectedTemplate({ command: 'node -e 0' }, root)).toBeNull();
    expect(
      resolveAffectedTemplate({ affectedCommand: '  ', command: 'node -e 0' }, root),
    ).toBeNull();
  });
});

describe('buildAffectedTestCommand {workspaces} (T13125)', () => {
  it('expands to --workspace <name> per package', () => {
    expect(buildAffectedTestCommand('npm run test {workspaces}', ['@x/a', '@x/b'])).toEqual({
      cmd: 'npm',
      args: ['run', 'test', '--workspace', '@x/a', '--workspace', '@x/b'],
    });
  });
});
