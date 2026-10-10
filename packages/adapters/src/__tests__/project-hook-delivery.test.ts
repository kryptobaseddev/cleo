/** Project-local activation delivery, ownership and hash-guarded removal. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ProjectHookDeliveryOptions,
  ProjectHookDeliveryReceiptSchema,
} from '@cleocode/contracts/project-hook-delivery.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasUnsupportedProjectHookDelivery,
  syncProjectHookProviders,
} from '../project-hook-delivery.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function options(): Promise<ProjectHookDeliveryOptions> {
  const root = await mkdtemp(join(tmpdir(), 'cleo-project-delivery-'));
  dirs.push(root);
  execFileSync('git', ['init', '--quiet', root]);
  await mkdir(join(root, '.codex'));
  return {
    projectRoot: root,
    stateDir: join(root, '.git/cleo-project-hooks'),
    providers: ['codex'],
    events: ['PreToolUse'],
    enabled: true,
    dryRun: false,
  };
}
describe('project hook delivery', () => {
  it('does nothing while disabled and dry-run creates no config or receipt', async () => {
    const opts = await options();
    expect((await syncProjectHookProviders({ ...opts, enabled: false }))[0]?.state).toBe(
      'disabled',
    );
    expect((await syncProjectHookProviders({ ...opts, dryRun: true }))[0]?.state).toBe('planned');
    await expect(readFile(join(opts.projectRoot, '.codex/hooks.json'))).rejects.toThrow();
    await expect(readFile(join(opts.stateDir, 'provider-codex.json'))).rejects.toThrow();
  });
  it('rejects provider traversal and non-Git state paths before creating locks', async () => {
    const opts = await options();
    const traversal = (
      await syncProjectHookProviders({ ...opts, providers: ['x/../../../outside'] })
    )[0];
    expect(traversal?.diagnostics).toContain('HOOK_PROVIDER_INVALID');
    const wrong = (
      await syncProjectHookProviders({ ...opts, stateDir: join(opts.projectRoot, 'foreign') })
    )[0];
    expect(wrong?.diagnostics).toContain('HOOK_STATE_DIRECTORY_INVALID');
    await expect(readFile(join(opts.projectRoot, 'foreign/provider-codex.json'))).rejects.toThrow();
    await symlink(join(opts.projectRoot, '.codex'), opts.stateDir);
    const symlinked = (await syncProjectHookProviders(opts))[0];
    expect(symlinked?.diagnostics).toContain('HOOK_STATE_DIRECTORY_INVALID');
    await expect(readFile(join(opts.projectRoot, '.codex/provider-codex.json'))).rejects.toThrow();
  });
  it('preserves foreign rules and heavy entry through repeated sync and rollback', async () => {
    const opts = await options();
    const file = join(opts.projectRoot, '.codex/hooks.json');
    const heavy = '{"hooks":[{"type":"command","command":"budget # cleo-hook"}]}';
    await writeFile(file, '{// team comment\n"hooks":{"PreToolUse":[' + heavy + ']}}\n');
    expect((await syncProjectHookProviders(opts))[0]?.state).toBe('installed');
    expect((await syncProjectHookProviders(opts))[0]?.state).toBe('current');
    expect(await readFile(file, 'utf8')).toContain(heavy);
    await syncProjectHookProviders({ ...opts, enabled: false, rollback: true });
    const body = await readFile(file, 'utf8');
    expect(body).toContain('// team comment');
    expect(body).toContain(heavy);
    expect(body).not.toContain('# cleo-project-hook:v1');
  });
  it('warns and allows native invocation when CLEO is absent or lacks the protocol', async () => {
    const opts = await options();
    await syncProjectHookProviders(opts);
    const receipt = ProjectHookDeliveryReceiptSchema.parse(
      JSON.parse(await readFile(join(opts.stateDir, 'provider-codex.json'), 'utf8')),
    );
    const cmd = receipt.entries[0]?.command;
    expect(cmd).toBeDefined();
    if (!cmd) throw new Error('missing generated command');
    const unavailable = spawnSync('/bin/sh', ['-c', cmd], {
      env: { PATH: '/nonexistent' },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(unavailable.status).toBe(0);
    expect(unavailable.stdout).toBe('');
    expect(unavailable.stderr).toContain('operation allowed');
    const bin = join(opts.projectRoot, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'cleo'),
      '#!/bin/sh\nprintf "%s\\n" "old unsupported CLI"\nexit 1\n',
      { mode: 0o755 },
    );
    expect(
      execFileSync('/bin/sh', ['-c', cmd], {
        env: { PATH: bin },
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    ).toBe('');
  });
  it('refreshes a historical same-command entry without dropping its binding', async () => {
    const opts = await options();
    await syncProjectHookProviders(opts);
    const file = join(opts.projectRoot, '.codex/hooks.json');
    const receiptPath = join(opts.stateDir, 'provider-codex.json');
    const receipt = ProjectHookDeliveryReceiptSchema.parse(
      JSON.parse(await readFile(receiptPath, 'utf8')),
    );
    const command = receipt.entries[0]?.command;
    if (!command) throw new Error('missing generated command');
    const legacy = { matcher: '', hooks: [{ type: 'command', command }] };
    const foreign = { hooks: [{ type: 'command', command: 'team migration gate' }] };
    await writeFile(file, JSON.stringify({ hooks: { PreToolUse: [foreign, legacy] } }));
    receipt.entries[0] = {
      event: 'PreToolUse',
      command,
      hash: createHash('sha256').update(JSON.stringify(legacy)).digest('hex'),
    };
    await writeFile(receiptPath, JSON.stringify(receipt));
    const refreshed = (await syncProjectHookProviders(opts))[0];
    expect(refreshed?.state, JSON.stringify(refreshed)).toBe('installed');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      hooks: {
        PreToolUse: [foreign, { matcher: '', hooks: [{ type: 'command', command, timeout: 130 }] }],
      },
    });
    expect((await syncProjectHookProviders(opts))[0]?.state).toBe('current');
  });
  it('preserves tracked provider configuration despite an inherited alternate empty index', async () => {
    const opts = await options();
    const file = join(opts.projectRoot, '.codex/hooks.json');
    const body = '{"hooks":{"PreToolUse":[]}}\n';
    await writeFile(file, body);
    execFileSync('git', ['-C', opts.projectRoot, 'add', '--', '.codex/hooks.json']);
    const index = join(opts.projectRoot, '.git/alternate-index');
    execFileSync('git', ['-C', opts.projectRoot, 'read-tree', '--empty'], {
      env: { ...process.env, GIT_INDEX_FILE: index },
    });
    vi.stubEnv('GIT_INDEX_FILE', index);
    try {
      const result = (await syncProjectHookProviders(opts))[0];
      expect(result?.diagnostics).toContain('HOOK_CONFIG_TRACKED_REVIEW_REQUIRED');
      expect(await readFile(file, 'utf8')).toBe(body);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('refuses a customized managed entry even with its original marker', async () => {
    const opts = await options();
    await syncProjectHookProviders(opts);
    const file = join(opts.projectRoot, '.codex/hooks.json');
    const edited = (await readFile(file, 'utf8')).replace(
      '--event PreToolUse',
      '--event SessionStart',
    );
    await writeFile(file, edited);
    expect((await syncProjectHookProviders(opts))[0]?.state).toBe('conflict');
    await syncProjectHookProviders({ ...opts, rollback: true });
    expect(await readFile(file, 'utf8')).toBe(edited);
  });
  it('never writes through a provider directory symlink outside the checkout', async () => {
    const opts = await options();
    const outside = await mkdtemp(join(tmpdir(), 'cleo-hook-outside-'));
    dirs.push(outside);
    await rm(join(opts.projectRoot, '.codex'), { recursive: true });
    await symlink(outside, join(opts.projectRoot, '.codex'));
    expect((await syncProjectHookProviders(opts))[0]?.state).toBe('conflict');
    await expect(readFile(join(outside, 'hooks.json'))).rejects.toThrow();
  });
  it('delivers OpenCode as an auto-discovered JavaScript plugin with guarded removal', async () => {
    const opts = await options();
    const openCode = { ...opts, providers: ['opencode'] };
    const result = (await syncProjectHookProviders(openCode))[0];
    expect(result?.state).toBe('installed');
    expect(result?.configPath).toBe(
      join(opts.projectRoot, '.opencode/plugins/cleo-project-hooks.js'),
    );
    const file = join(opts.projectRoot, '.opencode/plugins/cleo-project-hooks.js');
    const body = await readFile(file, 'utf8');
    expect(body).toContain('"tool.execute.before"');
    expect(body).toContain('timeout:130000');
    expect(
      (await syncProjectHookProviders({ ...openCode, enabled: false, rollback: true }))[0]?.state,
    ).toBe('disabled');
    await expect(readFile(file)).rejects.toThrow();
  });
  it('reports Kimi project-local support unavailable without writing global hooks', async () => {
    const opts = await options();
    const result = (await syncProjectHookProviders({ ...opts, providers: ['kimi'] }))[0];
    expect(result).toMatchObject({
      state: 'unsupported',
      nativeTrust: 'unverified',
      provenance: 'unknown',
    });
  });
  it('reports unsupported plugin bindings without creating a no-op plugin or claiming mixed delivery complete', async () => {
    const opts = await options();
    const sole = await syncProjectHookProviders({
      ...opts,
      providers: ['opencode'],
      events: ['SessionStart'],
    });
    expect(sole[0]?.state).toBe('unsupported');
    await expect(
      readFile(join(opts.projectRoot, '.opencode/plugins/cleo-project-hooks.js')),
    ).rejects.toThrow();
    await expect(readFile(join(opts.stateDir, 'provider-opencode.json'))).rejects.toThrow();
    const mixed = await syncProjectHookProviders({
      ...opts,
      providers: ['opencode'],
      events: ['PreToolUse', 'SessionStart'],
    });
    expect(mixed[0]?.state).toBe('installed');
    expect(hasUnsupportedProjectHookDelivery(mixed)).toBe(true);
    expect(
      await readFile(join(opts.projectRoot, '.opencode/plugins/cleo-project-hooks.js'), 'utf8'),
    ).toContain('"tool.execute.before"');
  });
  it('preserves a plugin changed by another writer during owned rollback', async () => {
    const opts = await options();
    const openCode = { ...opts, providers: ['opencode'] };
    await syncProjectHookProviders(openCode);
    const file = join(opts.projectRoot, '.opencode/plugins/cleo-project-hooks.js');
    const foreign = '// developer changed this plugin during inspection\n';
    const tools = await import('@cleocode/core/tools/fs');
    const originalRead = tools.readFileText;
    let changed = false;
    const read = vi.spyOn(tools, 'readFileText').mockImplementation(async (input) => {
      const result = await originalRead(input);
      if (input.path === file && !changed) {
        changed = true;
        await writeFile(file, foreign);
      }
      return result;
    });
    try {
      const result = (await syncProjectHookProviders({ ...openCode, rollback: true }))[0];
      expect(result?.diagnostics).toContain('HOOK_CONFIG_CONCURRENT_EDIT');
      expect(await readFile(file, 'utf8')).toBe(foreign);
    } finally {
      read.mockRestore();
    }
  });
  it('refuses a corrupt receipt rather than resetting management authority', async () => {
    const opts = await options();
    await mkdir(opts.stateDir);
    await writeFile(join(opts.stateDir, 'provider-codex.json'), '{ corrupt');
    const result = (await syncProjectHookProviders(opts))[0];
    expect(result?.state).toBe('conflict');
    expect(result?.diagnostics).toContain('HOOK_RECEIPT_INVALID');
    await expect(readFile(join(opts.projectRoot, '.codex/hooks.json'))).rejects.toThrow();
  });
  it('preserves a foreign hook even when a schema-valid receipt claims it', async () => {
    const opts = await options();
    const file = join(opts.projectRoot, '.codex/hooks.json');
    const foreign = {
      matcher: '',
      hooks: [{ type: 'command', command: 'project migration check' }],
    };
    const body = JSON.stringify({ hooks: { PreToolUse: [foreign] } });
    await writeFile(file, body);
    await mkdir(opts.stateDir);
    await writeFile(
      join(opts.stateDir, 'provider-codex.json'),
      JSON.stringify({
        schemaVersion: 1,
        provider: 'codex',
        configPath: file,
        entries: [
          {
            event: 'PreToolUse',
            command: 'project migration check',
            hash: createHash('sha256').update(JSON.stringify(foreign)).digest('hex'),
          },
        ],
        recordedAt: new Date().toISOString(),
      }),
    );
    const result = (await syncProjectHookProviders({ ...opts, rollback: true }))[0];
    expect(result?.diagnostics).toContain('HOOK_RECEIPT_OWNERSHIP_INVALID');
    expect(await readFile(file, 'utf8')).toBe(body);
  });
  it('keeps the existing heavy-hook classifier eligible without altering its generated entry', async () => {
    const opts = await options();
    await syncProjectHookProviders(opts);
    const { codexHooksSharedReason } = await import(
      '../providers/shared/heavy-command-hook-install.js'
    );
    expect(codexHooksSharedReason(opts.projectRoot, false)).toBeNull();
  });
});
