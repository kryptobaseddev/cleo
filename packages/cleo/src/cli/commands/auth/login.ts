/**
 * `cleo auth login <provider>` — onboarding front door (alias of `cleo login`).
 *
 * A thin alias subcommand that dispatches to the SAME shared handler
 * ({@link runLoginFrontDoor}) and the SAME core engine as `cleo login` and
 * `cleo llm login` (T11725 · AC2 — no duplicated handler logic). It exists so
 * users who reach for the unified `cleo auth` namespace land in the identical
 * provider + auth-method picker → connect → select → bind → validate flow.
 *
 * @module cli/commands/auth/login
 * @task T11725
 * @epic T11671 (E6-ONBOARDING-FRONT-DOOR)
 */

import type { OnboardingResult } from '@cleocode/contracts';
import { defineCommand } from '../../lib/define-cli-command.js';
import { cliError } from '../../renderers/index.js';
import { emitLoginResult, LOGIN_ARGS, runLoginFrontDoor } from '../login.js';

/**
 * `cleo auth login` — onboarding front door, mounted under the `auth` group.
 *
 * @task T11725
 */
export const authLoginCommand = defineCommand({
  meta: {
    name: 'login',
    description:
      'Log in to an LLM provider and bind a usable profile (alias of `cleo login`). ' +
      'Picks a provider + auth method (browser OAuth or API key), selects a model, binds it, ' +
      'and validates the binding. Prompts/URLs go to stderr; the result is a human line on a ' +
      'terminal or a JSON envelope when piped/--json.',
  },
  args: LOGIN_ARGS,
  async run({ args }) {
    let result: OnboardingResult;
    try {
      result = await runLoginFrontDoor(args as Record<string, unknown>);
    } catch (err) {
      cliError(
        err instanceof Error ? err.message : String(err),
        1,
        { name: 'E_LOGIN_FAILED' },
        { operation: 'auth.login' },
      );
      process.exit(1);
    }
    emitLoginResult(result, 'auth.login');
  },
});
