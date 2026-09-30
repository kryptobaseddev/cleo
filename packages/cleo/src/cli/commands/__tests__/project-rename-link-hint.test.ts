/**
 * `cleo project rename` on a Nexus-linked project tells the operator to
 * re-run `cleo project link`. The hinted command must actually exist with the
 * flags it names (T12716 AC5): the hint once named `--name`, a flag
 * `cleo project link` does not declare.
 *
 * @task T12716
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renameProject } from '@cleocode/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectCommand } from '../project.js';

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cleo-rename-link-hint-'));
  vi.stubEnv('CLEO_HOME', join(sandbox, 'cleo-home'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  vi.stubEnv('CLEO_DISABLE_PROJECT_AUTOREGISTER', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(sandbox, { recursive: true, force: true });
});

/** Declared args of `cleo project link`. */
async function linkArgs(): Promise<Record<string, unknown>> {
  const subs = (projectCommand as { subCommands?: unknown }).subCommands;
  const resolved = (typeof subs === 'function' ? await subs() : subs) as
    | Record<string, { args?: Record<string, unknown> }>
    | undefined;
  const link = resolved?.['link'];
  if (!link) throw new Error('cleo project has no link subcommand');
  return link.args ?? {};
}

describe('rename on a linked project hints a real `cleo project link` invocation', () => {
  it('names only flags the link command declares', async () => {
    const root = join(sandbox, 'linked');
    mkdirSync(join(root, '.cleo'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'pipe' });
    const id = 'aaaaaaaaaaaa';
    writeFileSync(
      join(root, '.cleo', 'project.json'),
      `${JSON.stringify({ schemaVersion: 1, id, name: 'before' }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, '.cleo', 'project-info.json'),
      JSON.stringify({ projectId: id, name: 'before', projectHash: 'a1b2c3d4e5f6' }),
    );
    writeFileSync(join(root, '.cleo', 'nexus-link.json'), '{"version":1,"links":{}}');

    const result = await renameProject('after', root);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.nexusLabel).toBe('relink-required');

    const hinted = /`(cleo project link[^`]*)`/.exec(result.data.hint ?? '')?.[1];
    expect(hinted).toBeDefined();
    const flags = [...(hinted ?? '').matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1] ?? '');
    const declared = await linkArgs();
    for (const flag of flags) expect(Object.keys(declared)).toContain(flag);
  });
});
