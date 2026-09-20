/** Bounded external CLI observation for the existing installed-artifact verifier. @packageDocumentation */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  CertifiableProviderCli,
  ProviderVerificationInvocation,
  ProviderVerificationProcessResult,
} from '@cleocode/contracts/capabilities';
import { spawnWrapped } from '@cleocode/core/resources/spawn-wrapper';

const WRITABLE_ROOTS = [
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
  'CLEO_ROOT',
  'CLEO_PROJECT_ROOT',
  'CLEO_DIR',
  'NEXUS_HOME',
  'NEXUS_CACHE_DIR',
  'AGENTS_HOME',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'KIMI_CODE_HOME',
  'KIMI_HOME',
  'KIMI_CONFIG_DIR',
] as const;

/** Whether an already-canonical path stays within the synthetic isolation root. */
function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
  );
}

/**
 * Return normal noninteractive CLI flags without adapter bypass defaults.
 * @param provider - External CLI, distinct from its programmatic adapter.
 * @returns Fixed argument prefix; the scenario prompt is appended separately.
 * @example
 * ```ts
 * const args = providerVerificationArguments('codex');
 * ```
 */
export function providerVerificationArguments(provider: CertifiableProviderCli): readonly string[] {
  switch (provider) {
    case 'claude-code':
      return ['--print', '--output-format', 'stream-json', '--verbose'];
    case 'codex':
      return ['exec', '--json', '--sandbox', 'workspace-write'];
    case 'kimi':
      return ['--output-format', 'stream-json', '--prompt'];
    default:
      throw new Error('Unsupported external provider CLI');
  }
}

/** Verify explicit roots before any child launch; never copy ambient credentials. */
async function validateInvocation(
  input: ProviderVerificationInvocation,
): Promise<ProviderVerificationInvocation> {
  if (!input.invocationId.trim() || !input.prompt.trim())
    throw new Error('Invocation identity and prompt are required');
  if (input.prompt.startsWith('-'))
    throw new Error('Scenario prompt must not be interpreted as CLI options');
  if (
    !Number.isSafeInteger(input.deadlineAt) ||
    input.deadlineAt <= Date.now() ||
    input.deadlineAt - Date.now() > 600_000
  )
    throw new Error('Original provider deadline must be future and within ten minutes');
  if (
    !Number.isSafeInteger(input.transcriptByteLimit) ||
    input.transcriptByteLimit < 1024 ||
    input.transcriptByteLimit > 16 * 1024 * 1024
  )
    throw new Error('Transcript byte ceiling must be between 1024 and 16777216');
  if (
    !Number.isSafeInteger(input.memoryMaxMb) ||
    input.memoryMaxMb < 128 ||
    input.memoryMaxMb > 4096
  )
    throw new Error('Provider memory ceiling must be between 128 and 4096 MiB');
  if (
    !isAbsolute(input.isolationRoot) ||
    !isAbsolute(input.projectRoot) ||
    !isAbsolute(input.executable)
  )
    throw new Error('Provider paths must be absolute');
  const root = await realpath(input.isolationRoot);
  if (!(await stat(root)).isDirectory()) throw new Error('Isolation root must be a directory');
  const projectRoot = await realpath(input.projectRoot);
  const environment = { ...input.environment };
  if (!within(root, projectRoot)) throw new Error('Provider project escapes isolation root');
  for (const key of WRITABLE_ROOTS) {
    const path = input.environment[key];
    if (!path || !isAbsolute(path))
      throw new Error(`Writable root ${key} must exist inside isolation root`);
    const capturedPath = await realpath(path);
    if (!within(root, capturedPath) || !(await stat(capturedPath)).isDirectory())
      throw new Error(`Writable root ${key} must exist inside isolation root`);
    environment[key] = capturedPath;
  }
  if (environment['CLEO_ROOT'] !== projectRoot || environment['CLEO_PROJECT_ROOT'] !== projectRoot)
    throw new Error('CLEO project pins must match the captured provider project');
  if (environment['CLEO_DIR'] !== join(projectRoot, '.cleo'))
    throw new Error('CLEO_DIR must identify the captured project store');
  input.signal?.throwIfAborted();
  if (Date.now() >= input.deadlineAt)
    throw new Error('Original provider deadline expired during preparation');
  return { ...input, isolationRoot: root, projectRoot, environment };
}

/**
 * Observe a real external provider using canonical spawning and bounded cleanup.
 * @param input - Captured isolated invocation; no ambient environment is inherited.
 * @returns Process evidence only; repair, instruction delivery and lifecycle remain unverified.
 * @remarks Process groups cannot prove that descendants did not escape. A successful
 * systemd launch or kill request is not an independently verified empty cgroup.
 * @example
 * ```ts
 * const processEvidence = await runProviderVerification(invocation);
 * // Independently inspect actual installed repair receipts before assessing capabilities.
 * ```
 */
export async function runProviderVerification(
  input: ProviderVerificationInvocation,
): Promise<ProviderVerificationProcessResult> {
  const started = Date.now();
  // Copy mutable caller inputs synchronously before filesystem awaits.
  const captured = { ...input, environment: { ...input.environment } };
  const invocation = await validateInvocation(captured);
  const executablePath = await realpath(invocation.executable);
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(executablePath, { signal: invocation.signal })) {
    if (Date.now() >= invocation.deadlineAt)
      throw new Error('Original provider deadline expired while hashing executable');
    digest.update(bytes);
  }
  const executableHash = digest.digest('hex');
  invocation.signal?.throwIfAborted();
  if (Date.now() >= invocation.deadlineAt)
    throw new Error('Original provider deadline expired before launch');
  const args = providerVerificationArguments(invocation.provider);
  const diagnostics = [
    'This process observation does not verify instruction delivery, repair receipts, or full lifecycle containment.',
    'Executable hash records prelaunch bytes; executable immutability during execution was not established.',
    'No permission bypass flags were supplied; provider policy may refuse unattended actions.',
    'Cancellation cannot establish whether an in-flight CLEO mutation committed; inspect its canonical receipt.',
  ];
  const result: ProviderVerificationProcessResult = {
    invocationId: invocation.invocationId,
    provider: invocation.provider,
    executable: { locator: executablePath, sha256: executableHash },
    arguments: args,
    outcome: 'exited',
    exitCode: null,
    startedAt: new Date(started).toISOString(),
    endedAt: '',
    deadlineAt: invocation.deadlineAt,
    elapsedMs: 0,
    stdout: '',
    stderr: '',
    transcriptTruncated: false,
    childClosed: false,
    processGroupGone: null,
    containment: 'pgid',
    certification: 'unverified',
    diagnostics,
  };
  const owned = spawnWrapped(
    executablePath,
    [...args, invocation.prompt],
    {
      cwd: resolve(invocation.projectRoot),
      env: invocation.environment,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
    {
      scopeClass: 'tool',
      scopeId: invocation.invocationId,
      resources: { memoryMax: `${invocation.memoryMaxMb}M` },
    },
  );
  result.containment = owned.mode;
  const { child } = owned;
  let bytesLeft = invocation.transcriptByteLimit;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stopRequested = false;
  let finalized = false;
  let scopeStopRequested = false;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((done) => {
    settle = done;
  });
  const killGroup = () => {
    if (owned.mode === 'systemd' && owned.unitName && !scopeStopRequested) {
      scopeStopRequested = true;
      const cleanup = spawnSync(
        'systemctl',
        ['--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', owned.unitName],
        { stdio: 'ignore', timeout: 1000 },
      );
      if (cleanup.error || cleanup.status !== 0)
        diagnostics.push('Owned systemd scope kill was unsuccessful or unverified.');
    }
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH')
        diagnostics.push(`Cleanup signal failed: ${String(error)}`);
    }
  };
  const stop = (outcome: ProviderVerificationProcessResult['outcome']) => {
    if (stopRequested || finalized) return;
    stopRequested = true;
    result.outcome = outcome;
    killGroup();
    // This is a bounded cleanup observation window, not extra scenario execution time.
    cleanupTimer = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle();
    }, 1000);
  };
  const collect = (chunks: Buffer[], value: Buffer) => {
    if (finalized) return;
    const retained = Math.min(bytesLeft, value.byteLength);
    if (retained) chunks.push(Buffer.from(value.subarray(0, retained)));
    bytesLeft -= retained;
    if (retained < value.byteLength) {
      result.transcriptTruncated = true;
      stop('transcript-limit');
    }
  };
  child.stdout?.on('data', (value: Buffer) => collect(stdout, value));
  child.stderr?.on('data', (value: Buffer) => collect(stderr, value));
  child.once('error', (error) => {
    if (finalized) return;
    diagnostics.push(error.message);
    stop('spawn-failed');
  });
  child.once('close', (code) => {
    if (finalized) return;
    result.exitCode = code;
    result.childClosed = true;
    settle();
  });
  const abort = () => stop('cancelled');
  invocation.signal?.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(
    () => stop('deadline'),
    Math.max(0, invocation.deadlineAt - Date.now()),
  );
  if (invocation.signal?.aborted) abort();
  try {
    await settled;
  } finally {
    clearTimeout(deadline);
    if (cleanupTimer) clearTimeout(cleanupTimer);
    invocation.signal?.removeEventListener('abort', abort);
    killGroup();
    if (process.platform !== 'win32' && child.pid) {
      try {
        process.kill(-child.pid, 0);
        result.processGroupGone = false;
      } catch (error) {
        result.processGroupGone =
          error instanceof Error && 'code' in error && error.code === 'ESRCH' ? true : null;
      }
    }
  }
  finalized = true;
  if (owned.mode === 'pgid')
    diagnostics.push(
      'Process-group fallback has no observed cgroup memory bound and cannot exclude escaped descendants.',
    );
  else
    diagnostics.push(
      'Systemd scope emptiness was not independently inspected; lifecycle verification remains unverified.',
    );
  if (!result.childClosed || result.processGroupGone !== true)
    diagnostics.push('Owned process cleanup is incomplete or unverified.');
  const decode = (chunks: Buffer[]) => {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks), {
        stream: result.transcriptTruncated,
      });
    } catch {
      result.transcriptTruncated = true;
      diagnostics.push('Invalid UTF-8 transcript could not be rendered; evidence is incomplete.');
      return '';
    }
  };
  result.stdout = decode(stdout);
  result.stderr = decode(stderr);
  result.endedAt = new Date().toISOString();
  result.elapsedMs = Date.now() - started;
  return result;
}
