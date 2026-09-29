/**
 * `cleo auth login <provider>` — onboarding front door (alias of `cleo login`).
 *
 * A thin alias subcommand that dispatches to the SAME shared handler
 * ({@link runLoginFrontDoor}) and the SAME core engine as `cleo login` and
 * `cleo llm login` (T11725 · AC2 — no duplicated handler logic). It exists so
 * users who reach for the unified `cleo auth` namespace land in the identical
 * provider + auth-method picker → connect → select → bind → validate flow,
 * and `cleo auth login nexus` signs in to a Cleo Nexus account (T12712).
 *
 * @module cli/commands/auth/login
 * @task T11725
 * @epic T11671 (E6-ONBOARDING-FRONT-DOOR)
 */

import { defineCommand } from '../../lib/define-cli-command.js';
import { LOGIN_ARGS, runLoginCommand } from '../login.js';

/**
 * `cleo auth login` — onboarding front door, mounted under the `auth` group.
 *
 * @task T11725
 */
export const authLoginCommand = defineCommand({
  meta: {
    name: 'login',
    description:
      'Log in to a Cleo Nexus account (auth login nexus) or to an LLM provider and bind a usable profile (alias of `cleo login`). ' +
      'Picks a provider + auth method (browser OAuth or API key), selects a model, binds it, ' +
      'and validates the binding. Prompts/URLs go to stderr; the result is a human line on a ' +
      'terminal or a JSON envelope when piped/--json.',
  },
  args: LOGIN_ARGS,
  async run({ args }) {
    await runLoginCommand(args as Record<string, unknown>, 'auth.login');
  },
});
