/**
 * Credential seeder for the GitHub CLI (`gh`)
 * (E-CONFIG-AUTH-UNIFY E2a / T9418).
 *
 * ## DISABLED — T9594
 *
 * This seeder is intentionally NOT registered in `BUILTIN_SEEDERS` until a
 * real `github-models` provider exists in CLEO.  The token returned by
 * `gh auth token` is a GitHub Personal Access Token (`ghp_*` / `gho_*`) that
 * **cannot authenticate against `api.openai.com`**.  Tagging the entry as
 * `provider:'openai'` created unusable pool entries.
 *
 * Re-enable by:
 *   1. Implementing a `github-models` transport in `packages/core/src/llm/`.
 *   2. Changing `readonly provider = 'openai'` below to `'github-models'` (or
 *      whichever id the transport registers under).
 *   3. Adding `BUILTIN_SEEDERS.register(ghCliSeeder)` back to `./index.ts`.
 *
 * The file is kept in tree so the `readGhAuthToken` helper and the
 * `GhCliSeeder` class are available for the future provider without a
 * `git revert`.
 *
 * ## Security note
 *
 * MUST use `execFileSync` (not `execSync`) so the `gh` invocation cannot
 * be hijacked by shell metacharacters in the working directory or
 * environment. No arguments are interpolated from user input.
 *
 * ## Failure model
 *
 * Every failure path resolves to `{ entries: [] }`:
 *   - `gh` not installed (`ENOENT` on spawn) → silent skip
 *   - `gh auth token` exits non-zero (no logged-in account, scope mismatch,
 *     etc.) → silent skip
 *   - `gh` hangs → 2-second timeout terminates the child and skips
 *   - any other unexpected error → captured warning, still skipped
 *
 * This matches the rest of the seeder cohort: absence of the upstream tool
 * MUST never crash the resolver.
 *
 * @module llm/credential-seeders/gh-cli-seeder
 * @task T9418
 * @task T9594 (disabled — see note above)
 * @epic E-CONFIG-AUTH-UNIFY (E2a)
 */

import { execFileSync } from 'node:child_process';
import type { CredentialSeeder, SeederResult } from './index.js';

/**
 * Max time (ms) we let `gh auth token` run before terminating it.
 *
 * Two seconds is well above `gh`'s typical sub-100ms response time but
 * short enough that a hung child cannot stall pool resolution.
 *
 * @internal
 * @task T9418
 */
const GH_AUTH_TOKEN_TIMEOUT_MS = 2_000;

/**
 * Run `gh auth token` and return its trimmed stdout, or `null` on any
 * failure (tool absent, non-zero exit, timeout, etc.).
 *
 * Factored out so tests can stub `execFileSync` via `vi.mock('node:child_process')`
 * without needing to instantiate the seeder class.
 *
 * @internal
 * @task T9418
 */
export function readGhAuthToken(): { token: string | null; warning?: string } {
  try {
    const stdout = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf-8',
      timeout: GH_AUTH_TOKEN_TIMEOUT_MS,
      // Suppress gh's stderr ("not logged in") chatter — we treat any
      // failure as silent skip. Stdin closed so gh can't prompt.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const token = stdout.trim();
    return { token: token || null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // gh is not installed — entirely normal on minimal dev boxes.
      return { token: null };
    }
    // Distinguish "tool ran and refused" from "tool unavailable" via a
    // warning so verbose mode can surface the difference. The empty-token
    // path makes the seeder a no-op either way.
    return {
      token: null,
      warning: `gh-cli: \`gh auth token\` failed (${(err as Error).message})`,
    };
  }
}

/**
 * Credential seeder for the GitHub CLI (`gh`).
 *
 * Returns at most one entry: the token captured from `gh auth token`. The
 * entry is labelled `'gh-cli'` so the resolver and removal flows can
 * round-trip the source identity through the credential store.
 *
 * @task T9418
 */
export class GhCliSeeder implements CredentialSeeder {
  readonly sourceId = 'gh-cli' as const;
  readonly provider = 'openai';

  /**
   * Invoke `gh auth token` and shape the result for the resolver.
   *
   * Never throws — see the module docstring for the failure-mode table.
   *
   * @returns Zero or one entry plus optional warning.
   * @task T9418
   */
  async seed(): Promise<SeederResult> {
    const { token, warning } = readGhAuthToken();
    if (!token) {
      return warning ? { entries: [], warnings: [warning] } : { entries: [] };
    }

    return {
      entries: [
        {
          provider: 'openai',
          label: 'gh-cli',
          authType: 'oauth',
          accessToken: token,
          source: 'gh-cli',
        },
      ],
    };
  }
}

/**
 * Module-level singleton registered into `BUILTIN_SEEDERS`.
 *
 * @task T9418
 */
export const ghCliSeeder: CredentialSeeder = new GhCliSeeder();
