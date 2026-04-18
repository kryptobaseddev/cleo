/**
 * CleoOS keystore — Pi API key management with XDG-compliant storage.
 *
 * Wraps Pi's `FileAuthStorageBackend` with a CleoOS-specific path so
 * that credentials are persisted at `~/.config/cleo/auth/auth.json` (the
 * `auth` sub-path of the CleoOS config directory) rather than Pi's
 * default location.
 *
 * This ensures:
 *   - Credentials survive `cleoos` reinstalls (XDG is outside the package).
 *   - Multiple CleoOS installations on the same host share credentials.
 *   - The auth file lives under the XDG Config spec (`~/.config/cleo/`).
 *
 * @packageDocumentation
 */

import { join } from 'node:path';
import { getPlatformPaths } from '@cleocode/core/system/platform-paths.js';
import { FileAuthStorageBackend } from '@mariozechner/pi-coding-agent';

/** Default auth file name inside the keystore directory. */
const AUTH_FILENAME = 'auth.json';

/**
 * Resolve a `FileAuthStorageBackend` configured to use the CleoOS XDG
 * auth directory (`~/.config/cleo/auth/auth.json`).
 *
 * The directory is NOT created here — that is handled by the postinstall
 * script so that directory creation is a one-time operation.
 *
 * @returns A `FileAuthStorageBackend` pointed at the XDG-compliant path.
 */
export function resolveKeystore(): FileAuthStorageBackend {
  const { config } = getPlatformPaths();
  const authFilePath = join(config, 'auth', AUTH_FILENAME);
  return new FileAuthStorageBackend(authFilePath);
}
