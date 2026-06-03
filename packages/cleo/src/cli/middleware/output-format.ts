/**
 * Shared CLI middleware for resolving output format from --human/--json/--quiet flags.
 *
 * Delegates to LAFS protocol's resolveOutputFormat() for canonical flag resolution,
 * and provides a Commander.js-compatible helper to extract flag values from opts.
 *
 * @task T4703
 * @epic T4663
 */

import { type FlagInput, type FlagResolution, resolveOutputFormat } from '@cleocode/lafs';

export type { FlagResolution };

/**
 * Resolve output format from Commander.js option values.
 *
 * Reads --json, --human, and --quiet flags and delegates to
 * the canonical LAFS resolveOutputFormat(). Project/user defaults
 * can be passed via the optional `defaults` parameter.
 *
 * The optional `tty` argument feeds the LAFS resolver's TTY→human fallback
 * branch (lowest precedence — only reached when no explicit flag and no
 * project/user default applies). The CLI passes `tty: true` ONLY for the
 * interactive-output command class (logins, credential entry, onboarding
 * wizards — see `lib/interactive-commands.ts`), keeping the agent-first JSON
 * default for every other command. `--json` always wins over this fallback.
 *
 * @param opts - Commander.js parsed options object
 * @param defaults - Optional project/user defaults
 * @param tty - When true, default to human output absent any flag/config default (T11672)
 * @returns Resolved format with source provenance
 *
 * @task T4703
 * @epic T4663
 */
export function resolveFormat(
  opts: Record<string, unknown>,
  defaults?: { projectDefault?: 'json' | 'human'; userDefault?: 'json' | 'human' },
  tty?: boolean,
): FlagResolution {
  const input: FlagInput = {
    jsonFlag: opts['json'] === true,
    humanFlag: opts['human'] === true,
    quiet: opts['quiet'] === true,
    projectDefault: defaults?.projectDefault,
    userDefault: defaults?.userDefault,
    tty,
  };

  return resolveOutputFormat(input);
}
