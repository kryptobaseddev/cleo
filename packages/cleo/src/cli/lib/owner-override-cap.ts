/**
 * `cleo config set evidence.overrideCapPerSession <n>` — the owner-only path
 * (T13787). The value is sealed by core's `setOwnerOverrideCap`, never written
 * to config.json; without a TTY and the bound session's owner-auth password
 * core refuses and audits the attempt.
 *
 * @task T13787
 */

import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { cliError, cliOutput } from '../renderers/index.js';
import { readOwnerPassword } from './owner-password.js';

/** The bound session with its owner-auth verifier, and the password when an owner can answer. */
async function ownerCaller(purpose: string) {
  const [core, { getProjectRoot }] = await Promise.all([
    import('@cleocode/core/internal'),
    import('@cleocode/core/project-scope'),
  ]);
  const root = getProjectRoot();
  const sessionId = await core.resolveBoundSessionId(root);
  const auth = sessionId ? await core.getSessionOwnerAuth(sessionId, root) : null;
  // A bare --owner mark has no password to check; only an --owner-auth verifier does.
  const canAsk = Boolean(
    process.stdin.isTTY &&
      process.stderr.isTTY &&
      auth?.token &&
      auth.token !== core.OWNER_SESSION_MARK,
  );
  const password = canAsk ? ((await readOwnerPassword(purpose, 'config')) ?? '') : '';
  const session = sessionId
    ? { id: sessionId, name: auth?.name ?? null, token: auth?.token ?? null }
    : null;
  return { core, root, caller: { password, session } };
}

/**
 * `cleo config owner-enroll [--reset]`: enroll this project's owner key
 * (T13787), explicitly — never as a side effect of a set.
 *
 * @param reset - Replace an existing enrollment (audited).
 * @param confirm - Confirm an enrollment that replaced another without proof
 *   of the previous owner (clears the doctor FAIL; audited).
 * @task T13787
 */
export async function runOwnerEnroll(reset: boolean, confirm = false): Promise<void> {
  const { core, root, caller } = await ownerCaller('owner enrollment');
  const result = confirm
    ? await core.confirmOwnerEnrollment(root, caller)
    : await core.enrollOwner(root, caller, { reset });
  if (!result.ok) {
    cliError(
      result.message,
      ExitCode.GENERAL_ERROR,
      { name: result.code },
      { operation: 'config.owner-enroll' },
    );
    process.exit(ExitCode.GENERAL_ERROR);
    return;
  }
  cliOutput(
    {
      fingerprint: result.fingerprint,
      reset: result.reset,
      file: '.cleo/owner-settings.json',
      next: 'Commit .cleo/owner-settings.json so a delete or forge shows in git.',
    },
    { command: 'config-owner-enroll', operation: 'config.owner-enroll' },
  );
}

/**
 * Set the owner override cap from the CLI, prompting for the owner-auth
 * password only where an owner can answer (a TTY and an owner-auth session).
 *
 * @param rawValue - The value as typed.
 * @task T13787
 */
export async function runOwnerOverrideCapSet(rawValue: string): Promise<void> {
  const { core, root, caller } = await ownerCaller('evidence.overrideCapPerSession');
  const result = await core.setOwnerOverrideCap(root, { ...caller, value: Number(rawValue) });
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
