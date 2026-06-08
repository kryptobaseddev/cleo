/**
 * Child runner for the single-LAFS-envelope-on-stdout test (T11761 · S2 · T11898).
 *
 * Simulates the daemon's emission discipline (ADR-086): the Pi adapter runs,
 * streaming/progress noise goes to STDERR, and EXACTLY ONE LAFS envelope JSON
 * line is written to STDOUT. The parent test asserts the stdout/stderr split.
 *
 * Run with `tsx`. Not a vitest file (lives under `fixtures/`).
 */

import { createEnvelope } from '@cleocode/lafs';
import { PiAgentAdapter } from '../../pi-agent-adapter.js';

async function main(): Promise<void> {
  // Streaming / progress noise — ALL to stderr, never stdout (ADR-086).
  process.stderr.write('pi: starting agent loop\n');
  process.stderr.write('pi: streaming delta...\n');

  const adapter = new PiAgentAdapter({ system: 'task-executor' });
  const result = await adapter.run('say hello', noopTools(), {
    system: 'task-executor',
    sessionId: 'fixture-session-1',
    agentId: null,
    parentSessionId: null,
  });

  process.stderr.write(`pi: loop done status=${result.status}\n`);

  // EXACTLY ONE LAFS envelope on stdout.
  const envelope = createEnvelope({
    success: result.status === 'success',
    result: result.output,
    meta: { operation: 'pi.run', requestId: 'fixture-1' },
    ...(result.status === 'failure'
      ? { error: { code: 'E_PI_RUN_FAILED', message: result.error ?? 'pi run failed' } }
      : {}),
  });
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function noopTools() {
  return {
    async readFileText(input: { path: string }) {
      return { path: input.path, content: '' };
    },
    async readJson<T>() {
      return {} as T;
    },
    async writeFileAtomic(input: { path: string }) {
      return { path: input.path, bytesWritten: 0 };
    },
    async pathExists() {
      return { exists: false };
    },
    async executeShell() {
      return { stdout: '', stderr: '', code: 0 };
    },
    async runGit() {
      return { stdout: '', stderr: '', code: 0 };
    },
  };
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`fixture error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
