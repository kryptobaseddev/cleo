/**
 * Stable device identifier — persisted UUIDv4 keyed to the CLEO home directory.
 *
 * Used by providers that enforce device-ID stability on every request
 * (`X-Msh-Device-Id` for Kimi Code; future GitHub Copilot / Cursor). The UUID
 * is written once at first use and reused across processes — losing it would
 * trigger device re-registration prompts upstream.
 *
 * Storage: `${CLEO_HOME}/device-id` — single-line UUIDv4, no metadata. Path
 * resolves through `getCleoHome()` so it follows XDG conventions on Linux
 * and stays inside the CLEO home on Windows/macOS.
 *
 * @module llm/stable-device-id
 * @task T9321
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getCleoHome } from '@cleocode/paths';

/** Filename within `getCleoHome()` storing the persisted UUID. */
const DEVICE_ID_FILE = 'device-id';

/** Process-lifetime cache so repeat callers do not re-read the disk. */
let _cachedDeviceId: string | null = null;

/**
 * Return the stable device UUID for this CLEO installation.
 *
 * Creates the file on first call (atomic write — tmp+rename pattern). All
 * subsequent calls in the same process return the cached value. Across
 * processes, the file is the source of truth.
 *
 * The UUID is OPAQUE — callers MUST treat it as a stable identifier and not
 * encode any meaning into its bytes.
 *
 * @returns A UUIDv4 string in canonical hyphenated form.
 *
 * @task T9321
 */
export function getStableDeviceId(): string {
  if (_cachedDeviceId !== null) return _cachedDeviceId;

  const path = join(getCleoHome(), DEVICE_ID_FILE);

  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8').trim();
      if (raw.length > 0) {
        _cachedDeviceId = raw;
        return raw;
      }
    } catch {
      // Unreadable — fall through to regenerate. Common cause: permissions
      // changed on the file. Regenerating is safer than throwing.
    }
  }

  const fresh = randomUUID();
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    // Atomic write: tmp file + rename. Avoids partial-write corruption if
    // the process is killed mid-flush. renameSync is atomic on POSIX; on
    // Windows it falls back to copy+delete which is close enough for our
    // single-writer single-reader use case.
    const tmpPath = `${path}.tmp.${process.pid}`;
    writeFileSync(tmpPath, fresh, { mode: 0o600 });
    renameSync(tmpPath, path);
  } catch {
    // If we cannot persist, still return the UUID for THIS process. The
    // next process will regenerate. Callers that need true cross-process
    // stability MUST surface a writable getCleoHome at install time.
  }

  _cachedDeviceId = fresh;
  return fresh;
}

/**
 * Reset the in-memory cache. Test-only — production code never calls this.
 *
 * @internal
 */
export function _resetDeviceIdCacheForTests(): void {
  _cachedDeviceId = null;
}
