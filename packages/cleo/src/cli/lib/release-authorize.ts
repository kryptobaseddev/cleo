/**
 * `cleo release authorize` — owner-signed standing release authorization
 * (T14141 · D11215). Grants and revokes go through core's owner check (role
 * fence, TTY, the owner-auth password); `--list` reads.
 *
 * @task T14141
 */

import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { cliError, cliOutput } from '../renderers/index.js';
import { ownerCaller } from './owner-override-cap.js';

/** Flags of `cleo release authorize`. */
export interface ReleaseAuthorizeArgs {
  scope?: string;
  expires?: string;
  reason?: string;
  uses?: string;
  revoke?: string;
  list?: boolean;
}

/**
 * Run `cleo release authorize`: list, revoke, or grant.
 *
 * @param args - The parsed flags.
 * @task T14141
 */
export async function runReleaseAuthorize(args: ReleaseAuthorizeArgs): Promise<void> {
  const meta = { command: 'release-authorize', operation: 'release.authorize' };
  const fail = (code: string, message: string, exit = ExitCode.GENERAL_ERROR): void => {
    cliError(message, exit, { name: code }, { operation: meta.operation });
    process.exit(exit);
  };
  const [core, { getProjectRoot }] = await Promise.all([
    import('@cleocode/core/internal'),
    import('@cleocode/core/project-scope'),
  ]);
  const root = getProjectRoot();
  if (args.list) {
    cliOutput({ grants: await core.listReleaseAuthorizations(root) }, meta);
    return;
  }
  if (args.revoke) {
    const { caller } = await ownerCaller('release authorization revoke');
    const result = await core.revokeReleaseAuthorization(root, { ...caller, id: args.revoke });
    if (!result.ok) return fail(result.code, result.message);
    cliOutput(
      {
        revoked: result.grant.id,
        scope: result.grant.scope,
        next: 'Commit .cleo/owner-settings.json: it seals the revocation count.',
      },
      meta,
    );
    return;
  }
  if (!args.scope || !args.expires || !args.reason) {
    return fail(
      'E_VALIDATION',
      'Grant with --scope <canary|prerelease|stable|version> --expires <30m|24h|30d> --reason <why> [--uses <n>], or use --list / --revoke <id>',
      ExitCode.VALIDATION_ERROR,
    );
  }
  const { caller } = await ownerCaller('release authorization');
  const result = await core.grantReleaseAuthorization(root, {
    ...caller,
    scope: args.scope,
    expires: args.expires,
    reason: args.reason,
    ...(args.uses !== undefined ? { uses: Number(args.uses) } : {}),
  });
  if (!result.ok) {
    return fail(
      result.code,
      result.message,
      result.code === 'E_VALIDATION' ? ExitCode.VALIDATION_ERROR : ExitCode.GENERAL_ERROR,
    );
  }
  cliOutput({ grant: result.grant }, meta);
}
