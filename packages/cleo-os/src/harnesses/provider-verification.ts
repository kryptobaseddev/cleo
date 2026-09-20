/** Bounded external CLI observation for the existing installed-artifact verifier. @packageDocumentation */

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  CertifiableProviderCli,
  ProviderScopeObservation,
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
  const captured = {
    ...input,
    environment: { ...input.environment },
    systemdControl: input.systemdControl ? { ...input.systemdControl } : undefined,
  };
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
    scope: null,
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
      scopeId: `${invocation.invocationId}-${randomUUID()}`,
      systemdControl: invocation.systemdControl,
      resources: { memoryMax: `${invocation.memoryMaxMb}M` },
    },
  );
  result.containment = owned.mode;
  const { child } = owned;
  const managerEnv = invocation.systemdControl
    ? {
        ...invocation.environment,
        XDG_RUNTIME_DIR: invocation.systemdControl.runtimeDirectory,
        DBUS_SESSION_BUS_ADDRESS:
          invocation.systemdControl.busAddress ??
          `unix:path=${join(invocation.systemdControl.runtimeDirectory, 'bus')}`,
      }
    : { ...invocation.environment };
  const scope: ProviderScopeObservation | null =
    owned.mode === 'systemd' && owned.unitName
      ? {
          unitName: owned.unitName,
          cgroupPath: null,
          memoryMaxBytes: null,
          memorySwapMaxBytes: null,
          observedMemberPids: [],
          populatedBefore: null,
          populatedAfter: null,
          removedAfter: false,
          verified: false,
        }
      : null;
  result.scope = scope;
  const scopeDiagnostics = new Set<string>();
  const scopeDiagnostic = (message: string) => {
    if (scopeDiagnostics.has(message)) return;
    scopeDiagnostics.add(message);
    diagnostics.push(message);
  };
  let cleanupDeadline: number | undefined;
  const beginCleanup = () => (cleanupDeadline ??= Date.now() + 1000);
  const observeScope = (after: boolean) => {
    if (
      !scope ||
      process.platform !== 'linux' ||
      Date.now() >= (after ? beginCleanup() : invocation.deadlineAt)
    )
      return;
    try {
      if (!scope.cgroupPath) {
        const remaining = (after ? beginCleanup() : invocation.deadlineAt) - Date.now();
        if (remaining <= 0) return;
        const query = spawnSync(
          'systemctl',
          ['--user', 'show', scope.unitName, '--property=ControlGroup', '--value'],
          {
            env: managerEnv,
            encoding: 'utf8',
            timeout: Math.min(100, remaining),
            maxBuffer: 4096,
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        );
        if (query.status !== 0 || query.error) {
          scopeDiagnostic('An owned scope query failed or exceeded its bounded observation time.');
          return;
        }
        const group = query.stdout.trim();
        // Observe only the exact randomly named scope, never a parent/global slice.
        if (
          !group.startsWith('/') ||
          group.split('/').includes('..') ||
          !group.endsWith(`/${scope.unitName}`)
        )
          return;
        scope.cgroupPath = group;
      }
      const directory = join('/sys/fs/cgroup', scope.cgroupPath);
      const events = readFileSync(join(directory, 'cgroup.events'), 'utf8');
      const populated = /^populated ([01])$/m.exec(events)?.[1];
      if (after) scope.populatedAfter = populated === undefined ? null : populated === '1';
      else {
        scope.populatedBefore =
          scope.populatedBefore === true
            ? true
            : populated === undefined
              ? null
              : populated === '1';
        const memory = readFileSync(join(directory, 'memory.max'), 'utf8').trim();
        const swap = readFileSync(join(directory, 'memory.swap.max'), 'utf8').trim();
        scope.memoryMaxBytes = /^\d+$/.test(memory) ? Number(memory) : null;
        scope.memorySwapMaxBytes = /^\d+$/.test(swap) ? Number(swap) : null;
        const members = readFileSync(join(directory, 'cgroup.procs'), 'utf8').trim().split(/\s+/);
        if (members.length > 1024) return;
        const matched: number[] = [];
        for (const member of members) {
          if (Date.now() >= invocation.deadlineAt) return;
          if (!/^\d+$/.test(member)) continue;
          const membership = readFileSync(`/proc/${member}/cgroup`, 'utf8');
          if (membership.split('\n').includes(`0::${scope.cgroupPath}`))
            matched.push(Number(member));
        }
        scope.observedMemberPids = [...new Set([...scope.observedMemberPids, ...matched])];
      }
    } catch (error) {
      if (
        after &&
        scope.populatedBefore === true &&
        scope.observedMemberPids.length > 0 &&
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        scope.removedAfter = true;
        scope.populatedAfter = null;
      } else
        scopeDiagnostic(
          'An owned scope filesystem observation failed; unavailable evidence remains unverified.',
        );
      // Races during startup or process exit leave the corresponding evidence unverified.
    }
  };
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
      const remaining = beginCleanup() - Date.now();
      const cleanup =
        remaining > 0
          ? spawnSync(
              'systemctl',
              ['--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', owned.unitName],
              { env: managerEnv, stdio: 'ignore', timeout: Math.max(1, remaining) },
            )
          : null;
      if (!cleanup || cleanup.error || cleanup.status !== 0)
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
    beginCleanup();
    result.outcome = outcome;
    killGroup();
    // This is a bounded cleanup observation window, not extra scenario execution time.
    cleanupTimer = setTimeout(
      () => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle();
      },
      Math.max(0, beginCleanup() - Date.now()),
    );
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
  else if (Date.now() >= invocation.deadlineAt) stop('deadline');
  const scopePoll = setInterval(() => {
    if (!stopRequested && !result.childClosed) observeScope(false);
  }, 25);
  if (!stopRequested) observeScope(false);
  try {
    await settled;
  } finally {
    clearTimeout(deadline);
    clearInterval(scopePoll);
    if (cleanupTimer) clearTimeout(cleanupTimer);
    invocation.signal?.removeEventListener('abort', abort);
    beginCleanup();
    killGroup();
    if (scope) {
      do {
        observeScope(true);
        if (scope.removedAfter || scope.populatedAfter === false) break;
        await new Promise<void>((done) =>
          setTimeout(done, Math.min(25, Math.max(0, beginCleanup() - Date.now()))),
        );
      } while (Date.now() < beginCleanup());
      scope.verified =
        result.childClosed &&
        scope.populatedBefore === true &&
        scope.observedMemberPids.length > 0 &&
        scope.memoryMaxBytes === invocation.memoryMaxMb * 1024 * 1024 &&
        scope.memorySwapMaxBytes === 0 &&
        (scope.removedAfter || scope.populatedAfter === false);
    }
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
  else if (!scope?.verified)
    diagnostics.push(
      'Owned scope membership, resource bounds or cleanup could not all be verified.',
    );
  else
    diagnostics.push(
      'Owned scope membership, memory/swap limits and empty cleanup were observed; this is not a complete provider lifecycle certificate.',
    );
  diagnostics.push(
    'Synchronous manager probes and kernel reads are bounded cooperatively; timers do not preempt them. Cleanup gets at most one separate one-second observation window; elapsed time includes overruns.',
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
