/**
 * Shared helpers for the `caamp pi <verb>` command group.
 *
 * @remarks
 * Every `caamp pi` verb has to:
 *
 * 1. Check that Pi is installed and abort with a stable error envelope
 *    when it is not (per ADR-035 cross-cutting concerns §"Pi-absent
 *    fallback").
 * 2. Resolve a three-tier scope flag from the Commander option object
 *    into a typed {@link HarnessTier}.
 * 3. Construct a {@link PiHarness} bound to the resolved provider so
 *    every verb talks to the same concrete implementation.
 *
 * This module centralises those steps so each verb file stays focused
 * on its own argument parsing and output shaping.
 *
 * @packageDocumentation
 */

import { getHarnessFor } from '../../core/harness/index.js';
import { PiHarness } from '../../core/harness/pi.js';
import type { HarnessTier } from '../../core/harness/scope.js';
import { getInstalledProviders } from '../../core/registry/detection.js';
import { getProvider } from '../../core/registry/providers.js';
import { LAFSCommandError } from '../advanced/lafs.js';

/**
 * Canonical LAFS error codes used by the `caamp pi` command group.
 *
 * @remarks
 * The `advanced/lafs.ts` emit path normalises any unregistered error
 * code to `E_INTERNAL_UNEXPECTED` — so every code the Pi commands
 * throw MUST come from the canonical LAFS error registry. These
 * constants map the semantic verbs we care about onto the registered
 * codes:
 *
 * - `VALIDATION` — caller-supplied input failed validation
 * - `NOT_FOUND`  — referenced resource does not exist
 * - `CONFLICT`   — target already exists (overwrite without `--force`)
 * - `TRANSIENT`  — network/upstream call failed, retry is viable
 *
 * The three codes covered here (`E_VALIDATION_SCHEMA`,
 * `E_NOT_FOUND_RESOURCE`, `E_CONFLICT_VERSION`, `E_TRANSIENT_UPSTREAM`)
 * are registered in `packages/lafs/schemas/v1/error-registry.json` and
 * round-trip through `runLafsCommand`'s envelope builder without being
 * rewritten to `E_INTERNAL_UNEXPECTED`.
 *
 * @public
 */
export const PI_ERROR_CODES = {
  /** Caller-supplied input failed validation (shape, type, enum). */
  VALIDATION: 'E_VALIDATION_SCHEMA',
  /** Referenced resource does not exist on disk or in the registry. */
  NOT_FOUND: 'E_NOT_FOUND_RESOURCE',
  /** Write target already exists and overwrite was not requested. */
  CONFLICT: 'E_CONFLICT_VERSION',
  /** Network/upstream call failed; retry is viable. */
  TRANSIENT: 'E_TRANSIENT_UPSTREAM',
} as const;

/**
 * Standard option shape accepted by every `caamp pi <verb>` command.
 *
 * @public
 */
export interface PiCommandBaseOptions {
  /** `--scope project|user|global`. */
  scope?: string;
  /** `--force` — overwrite existing targets on install verbs. */
  force?: boolean;
  /** `--project-dir <path>` — override cwd for the `project` tier. */
  projectDir?: string;
}

/**
 * Resolve and validate Pi's installation, returning a ready-to-use
 * {@link PiHarness}.
 *
 * @remarks
 * Throws a {@link LAFSCommandError} with code `E_NOT_FOUND` when Pi is
 * not installed — which `runLafsCommand` converts to an exit code 1
 * error envelope. The ADR calls for exit code 4 semantically, but the
 * CAAMP LAFS layer only exposes exit code 1 for errors; the category
 * `NOT_FOUND` and the explicit code `E_PI_NOT_INSTALLED` carry the
 * semantic distinction instead.
 *
 * @returns A PiHarness bound to the resolved Pi provider entry.
 * @throws `LAFSCommandError` when Pi is not installed.
 *
 * @public
 */
export function requirePiHarness(): PiHarness {
  const provider = getProvider('pi');
  if (provider === undefined) {
    throw new LAFSCommandError(
      PI_ERROR_CODES.NOT_FOUND,
      'Pi provider is not registered in the CAAMP registry.',
      'This is a configuration bug — open an issue with `caamp providers list`.',
      false,
    );
  }

  const installed = getInstalledProviders();
  const piInstalled = installed.some((p) => p.id === 'pi');
  if (!piInstalled) {
    throw new LAFSCommandError(
      PI_ERROR_CODES.NOT_FOUND,
      'Pi is not installed. Run: caamp providers install pi',
      'Install Pi via its official installer, then retry this command.',
      true,
    );
  }

  const harness = getHarnessFor(provider);
  if (!(harness instanceof PiHarness)) {
    throw new LAFSCommandError(
      'E_INTERNAL_UNEXPECTED',
      'Pi provider is registered but no PiHarness implementation was returned.',
      'This is a programming error — the harness dispatcher should always return a PiHarness for Pi.',
      false,
    );
  }
  return harness;
}

/**
 * Parse and validate a `--scope` option value into a typed tier.
 *
 * @remarks
 * Accepts `project`, `user`, `global`, or `undefined` — in which case
 * the `defaultTier` is returned. Unknown values throw a typed
 * {@link LAFSCommandError} so the error envelope carries a meaningful
 * error code.
 *
 * @param raw - The raw option value from Commander (may be undefined).
 * @param defaultTier - Tier to use when `raw` is undefined.
 * @returns A resolved {@link HarnessTier}.
 * @throws `LAFSCommandError` when `raw` is set to an invalid value.
 *
 * @public
 */
export function parseScope(raw: string | undefined, defaultTier: HarnessTier): HarnessTier {
  if (raw === undefined) return defaultTier;
  if (raw === 'project' || raw === 'user' || raw === 'global') return raw;
  throw new LAFSCommandError(
    PI_ERROR_CODES.VALIDATION,
    `Invalid --scope value: ${raw}`,
    "Use one of: 'project', 'user', 'global'.",
    false,
  );
}

/**
 * Resolve the project directory to use for the `project` tier,
 * honouring an explicit `--project-dir` flag and falling back to cwd.
 *
 * @remarks
 * Kept in a helper so every verb resolves the same way. Returning
 * `undefined` for non-project tiers allows downstream list/install
 * calls to decline the project-dir argument cleanly.
 *
 * @param tier - Resolved tier the verb is targeting.
 * @param explicit - The raw `--project-dir` option value.
 * @returns Absolute project dir when `tier === 'project'`, else `undefined`.
 *
 * @public
 */
export function resolveProjectDir(
  tier: HarnessTier,
  explicit: string | undefined,
): string | undefined {
  if (tier !== 'project') return undefined;
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return process.cwd();
}
