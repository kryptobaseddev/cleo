/**
 * Shared CLI middleware for resolving output format from --human/--json/--quiet flags.
 *
 * Delegates to LAFS protocol's resolveOutputFormat() for canonical flag resolution,
 * and provides a Commander.js-compatible helper to extract flag values from opts.
 *
 * @task T4703
 * @epic T4663
 */

import { resolveOutputFormat, type FlagInput, type FlagResolution } from '@cleocode/lafs-protocol';

export type { FlagResolution };

/**
 * Resolve output format from Commander.js option values.
 *
 * Reads --json, --human, and --quiet flags and delegates to
 * the canonical LAFS resolveOutputFormat(). Project/user defaults
 * can be passed via the optional `defaults` parameter.
 *
 * @param opts - Commander.js parsed options object
 * @param defaults - Optional project/user defaults
 * @returns Resolved format with source provenance
 *
 * @task T4703
 * @epic T4663
 */
export function resolveFormat(
  opts: Record<string, unknown>,
  defaults?: { projectDefault?: 'json' | 'human'; userDefault?: 'json' | 'human' },
): FlagResolution {
  const input: FlagInput = {
    jsonFlag: opts['json'] === true,
    humanFlag: opts['human'] === true,
    quiet: opts['quiet'] === true,
    projectDefault: defaults?.projectDefault,
    userDefault: defaults?.userDefault,
  };

  return resolveOutputFormat(input);
}
