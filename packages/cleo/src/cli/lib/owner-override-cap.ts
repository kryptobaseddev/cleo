/**
 * `cleo config set evidence.overrideCapPerSession <n>` — the owner-only path
 * (T13787). The value is sealed by core's `setOwnerOverrideCap`, never written
 * to config.json; without a TTY and the bound session's owner-auth password
 * core refuses and audits the attempt.
 *
 * @task T13787
 */

import { ExitCode } from '@cleocode/contracts';
import { cliError, cliOutput } from '../renderers/index.js';
import { readOwnerPassword } from './owner-password.js';

/**
 * Set the owner override cap from the CLI, prompting for the owner-auth
 * password only where an owner can answer (a TTY and an owner-auth session).
 *
 * @param rawValue - The value as typed.
 * @task T13787
 */
export async function runOwnerOverrideCapSet(rawValue: string): Promise<void> {
  const [core, { getProjectRoot }] = await Promise.all([
    import('@cleocode/core/internal'),
    import('@cleocode/core/project-scope'),
  ]);
  const root = getProjectRoot();
  const sessionId = await core.resolveBoundSessionId(root);
  const auth = sessionId ? await core.getSessionOwnerAuth(sessionId, root) : null;
  const canAsk = Boolean(process.stdin.isTTY && process.stderr.isTTY && auth?.token);
  const password = canAsk
    ? ((await readOwnerPassword(core.OVERRIDE_CAP_SETTING, 'config.set')) ?? '')
    : '';
  const result = await core.setOwnerOverrideCap(root, {
    value: Number(rawValue),
    password,
    session: sessionId
      ? { id: sessionId, name: auth?.name ?? null, token: auth?.token ?? null }
      : null,
  });
  if (!result.ok) {
    const exit =
      result.code === 'E_VALIDATION' ? ExitCode.VALIDATION_ERROR : ExitCode.GENERAL_ERROR;
    cliError(result.message, exit, { name: result.code }, { operation: 'config.set' });
    process.exit(exit);
    return;
  }
  cliOutput(
    {
      scope: 'project',
      key: core.OVERRIDE_CAP_SETTING,
      value: result.value,
      previous: result.previous,
      clamped: result.clamped,
      sealed: true,
    },
    { command: 'config-set', operation: 'config.set' },
  );
}
