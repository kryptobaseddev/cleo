import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderVerificationInvocation } from '@cleocode/contracts/capabilities';
import { _forceSystemdRunAvailable } from '@cleocode/core/resources/spawn-wrapper';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  providerVerificationArguments,
  runProviderVerification,
} from '../provider-verification.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'provider-verification-fixture-'));
  _forceSystemdRunAvailable(false);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function invocation(script: string): Promise<ProviderVerificationInvocation> {
  const projectRoot = join(root, 'project');
  await mkdir(join(projectRoot, '.cleo'), { recursive: true });
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    NODE_OPTIONS: '--max-old-space-size=128',
  };
  for (const key of [
    'HOME',
    'USERPROFILE',
    'XDG_DATA_HOME',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_STATE_HOME',
    'XDG_RUNTIME_DIR',
    'TMPDIR',
    'TMP',
    'TEMP',
    'CLEO_HOME',
    'CLEO_CONFIG_HOME',
    'NEXUS_HOME',
    'NEXUS_CACHE_DIR',
    'AGENTS_HOME',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'KIMI_CODE_HOME',
    'KIMI_HOME',
    'KIMI_CONFIG_DIR',
  ]) {
    environment[key] = join(root, key);
    await mkdir(environment[key], { recursive: true });
  }
  environment.CLEO_ROOT = projectRoot;
  environment.CLEO_PROJECT_ROOT = projectRoot;
  environment.CLEO_DIR = join(projectRoot, '.cleo');
  const executable = join(root, 'synthetic-provider');
  await writeFile(executable, `#!${process.execPath}\n${script}\n`);
  await chmod(executable, 0o700);
  return {
    provider: 'codex',
    executable,
    invocationId: 'synthetic-observation',
    isolationRoot: root,
    projectRoot,
    environment,
    prompt: 'Inspect the synthetic project using its installed instructions.',
    deadlineAt: Date.now() + 3000,
    transcriptByteLimit: 4096,
    memoryMaxMb: 256,
  };
}

describe.skipIf(process.platform === 'win32')('bounded external provider observations', () => {
  it('uses fixed normal policy flags without adapter bypass defaults', () => {
    expect(providerVerificationArguments('codex')).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
    ]);
    expect(providerVerificationArguments('claude-code')).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    expect(providerVerificationArguments('kimi')).toEqual([
      '--output-format',
      'stream-json',
      '--prompt',
    ]);
    for (const provider of ['codex', 'claude-code', 'kimi'] as const) {
      expect(providerVerificationArguments(provider).join(' ')).not.toMatch(
        /bypass|dangerously|yolo|--auto|ignore-rules/,
      );
    }
  });

  it('captures isolated identity but cannot certify an agent-authored success claim', async () => {
    const input = await invocation(
      "process.stdout.write(JSON.stringify({home:process.env.HOME,project:process.env.CLEO_ROOT,workflow:'passed',lifecycle:'passed'}));",
    );
    const pending = runProviderVerification(input);
    input.projectRoot = '/not-the-captured-project';
    const result = await pending;
    expect(result.outcome).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(result.certification).toBe('unverified');
    expect(result.executable.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(result.stdout)).toMatchObject({
      home: join(root, 'HOME'),
      project: join(root, 'project'),
    });
    expect(result.childClosed).toBe(true);
    expect(result.processGroupGone).toBe(true);
    expect(result.diagnostics.join(' ')).toContain('cannot exclude escaped descendants');
  });

  it('treats absent accounts or failed interfaces as observations, never certification', async () => {
    const result = await runProviderVerification(
      await invocation("process.stderr.write('account unavailable');process.exitCode=42;"),
    );
    expect(result.exitCode).toBe(42);
    expect(result.stderr).toBe('account unavailable');
    expect(result.certification).toBe('unverified');
  });

  it('bounds shared stdout/stderr UTF-8 bytes and stops excess output', async () => {
    const input = await invocation(
      "process.stdout.write('😀'.repeat(20000));setInterval(()=>{},1000);",
    );
    input.transcriptByteLimit = 1025;
    const result = await runProviderVerification(input);
    expect(result.outcome).toBe('transcript-limit');
    expect(result.transcriptTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      1025,
    );
    expect(result.childClosed).toBe(true);
    expect(result.certification).toBe('unverified');
  });

  it('stops on the original deadline without renewing the attempt', async () => {
    const input = await invocation('setInterval(()=>{},1000);');
    input.deadlineAt = Date.now() + 150;
    const result = await runProviderVerification(input);
    expect(result.outcome).toBe('deadline');
    expect(result.deadlineAt).toBe(input.deadlineAt);
    expect(result.elapsedMs).toBeLessThan(1500);
    expect(result.childClosed).toBe(true);
  });

  it('cancels an actually running child and preserves uncertain mutation outcome', async () => {
    const marker = join(root, 'started');
    const input = await invocation(
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000);`,
    );
    const controller = new AbortController();
    input.signal = controller.signal;
    const pending = runProviderVerification(input);
    let started = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        started = (await readFile(marker, 'utf8')) === 'ready';
      } catch {}
      if (started) break;
      await new Promise((done) => setTimeout(done, 10));
    }
    controller.abort();
    expect(started).toBe(true);
    const result = await pending;
    expect(result.outcome).toBe('cancelled');
    expect(result.childClosed).toBe(true);
    expect(result.diagnostics.join(' ')).toContain(
      'cannot establish whether an in-flight CLEO mutation committed',
    );
  });

  it('rejects an escaped supported Kimi Code home before launch', async () => {
    const input = await invocation("process.stdout.write('must not run');");
    input.provider = 'kimi';
    input.environment = { ...input.environment, KIMI_CODE_HOME: tmpdir() };
    await expect(runProviderVerification(input)).rejects.toThrow('Writable root KIMI_CODE_HOME');
  });

  it('rejects a writable-root symlink escape before launch', async () => {
    const input = await invocation("process.stdout.write('must not run');");
    const outside = await mkdtemp(join(tmpdir(), 'provider-outside-fixture-'));
    try {
      const home = join(root, 'HOME');
      await rm(home, { recursive: true });
      await symlink(outside, home);
      await expect(runProviderVerification(input)).rejects.toThrow('Writable root HOME');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a scenario string that a CLI could interpret as a permission flag', async () => {
    const input = await invocation("process.stdout.write('must not run');");
    input.prompt = '--dangerously-bypass-approvals-and-sandbox';
    await expect(runProviderVerification(input)).rejects.toThrow('CLI options');
    input.provider = 'kimi';
    input.prompt = '--auto';
    await expect(runProviderVerification(input)).rejects.toThrow('CLI options');
  });

  it('rejects already expired or cancelled preparation before launch', async () => {
    const input = await invocation("process.stdout.write('must not run');");
    input.deadlineAt = Date.now() - 1;
    await expect(runProviderVerification(input)).rejects.toThrow('deadline');
    input.deadlineAt = Date.now() + 3000;
    const controller = new AbortController();
    controller.abort();
    input.signal = controller.signal;
    await expect(runProviderVerification(input)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.skipIf(process.platform !== 'linux')(
    'kills inherited process-group descendants without claiming complete lifecycle containment',
    async () => {
      const marker = join(root, 'descendant-pid');
      const input = await invocation(
        `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(c.pid));setTimeout(()=>process.exit(0),20);`,
      );
      input.deadlineAt = Date.now() + 500;
      const result = await runProviderVerification(input);
      const pid = Number(await readFile(marker, 'utf8'));
      let cleanupFailure: Error | undefined;
      try {
        expect(result.outcome).toBe('deadline');
        expect(result.childClosed).toBe(true);
        expect(result.certification).toBe('unverified');
        try {
          const status = await readFile(`/proc/${pid}/stat`, 'utf8');
          expect(status.slice(status.lastIndexOf(')') + 2).split(' ')[0]).toBe('Z');
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
            throw error;
        }
      } finally {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH')
            cleanupFailure = error instanceof Error ? error : new Error(String(error));
        }
      }
      if (cleanupFailure) throw cleanupFailure;
    },
  );
});
