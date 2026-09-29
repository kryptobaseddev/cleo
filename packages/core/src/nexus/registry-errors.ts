/**
 * Typed registry errors (T12512 · T12513). A registry read that fails must
 * reach the caller as a coded error, never as an empty list or `null` that
 * looks like "no projects".
 *
 * @task T12512
 * @task T12513
 * @epic T12496
 */

import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';

/**
 * The global project registry could not be read (the store is unreadable,
 * locked past its timeout, corrupt, or missing a table). Carries the
 * underlying error as `cause` and its message in `details.actual`.
 *
 * @example
 * ```ts
 * try { await nexusList(); }
 * catch (e) { if (e instanceof NexusRegistryReadError) console.error(e.codeName, e.message); }
 * ```
 */
export class NexusRegistryReadError extends CleoError {
  /** Stable machine-readable error code. */
  readonly codeName = 'E_NEXUS_REGISTRY_READ';

  /**
   * @param operation - What was being read (e.g. `list projects`).
   * @param cause - The underlying failure.
   */
  constructor(operation: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      ExitCode.NEXUS_REGISTRY_CORRUPT,
      `Cannot read the project registry (${operation}): ${reason}`,
      {
        fix: 'Run `cleo doctor` to check the global store; `cleo backup list` shows snapshots to restore.',
        details: {
          field: 'registry',
          expected: 'a readable global cleo.db',
          actual: reason,
          operation,
        },
        cause,
      },
    );
    this.name = 'NexusRegistryReadError';
  }
}

/**
 * Wrap a registry read failure in {@link NexusRegistryReadError}, passing
 * errors that are already typed through unchanged.
 *
 * @param operation - What was being read.
 * @param error - The caught value.
 * @returns A typed error to throw.
 */
export function toRegistryReadError(operation: string, error: unknown): CleoError {
  return error instanceof CleoError ? error : new NexusRegistryReadError(operation, error);
}

/**
 * A `--device` filter named no known device (neither a device id, a hostname,
 * nor `current`). Lists the known devices so the caller can pick one.
 *
 * @example
 * ```ts
 * throw new NexusDeviceNotFoundError('laptop', [{ deviceId: 'd1', hostname: 'desk' }]);
 * ```
 */
export class NexusDeviceNotFoundError extends CleoError {
  /** Stable machine-readable error code. */
  readonly codeName = 'E_NEXUS_DEVICE_NOT_FOUND';

  /**
   * @param device - The value that matched nothing.
   * @param known - Every known device.
   */
  constructor(device: string, known: ReadonlyArray<{ deviceId: string; hostname: string | null }>) {
    super(ExitCode.NOT_FOUND, `No device matches '${device}' (${known.length} known).`, {
      fix: 'Pass a device id or hostname from `cleo nexus projects status`, or `current`.',
      details: {
        field: 'device',
        expected: 'a device id, hostname or current',
        actual: device,
        known,
      },
    });
    this.name = 'NexusDeviceNotFoundError';
  }
}
