/**
 * Regression guard (T11353): the modules that adopted the shared
 * {@link truncateString} util MUST NOT re-introduce a locally-defined
 * `truncate`/`truncated`/`truncateEvidence` string-truncation helper.
 *
 * Collapsing the 6+ ad-hoc `truncate()` impls into one shared util is only
 * durable if drift is policed. This test reads each migrated source file and
 * fails if a local truncation *helper definition* reappears (call sites and
 * the canonical `truncated<T>` array util in helpers.ts are fine).
 *
 * @task T11353
 * @epic T11285 EP-MVI-PRIMITIVE
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/core/src/render/__tests__ → packages/core/src
const CORE_SRC = join(HERE, '..', '..');

/**
 * Files that adopted the shared `truncateString` util. Each MUST import it and
 * MUST NOT define its own bare `truncate`/`truncated` helper. Relative to
 * `packages/core/src`.
 *
 * `session/canon-lint.ts` is checked separately — it legitimately keeps a
 * thin `truncateEvidence` wrapper that *delegates* to `truncateString` (it adds
 * whitespace-collapse), so it must not re-implement the slice+ellipsis itself.
 */
const MIGRATED_CORE_FILES = [
  'sessions/briefing.ts',
  'memory/public-api.ts',
  'tasks/gate-runner.ts',
];

/**
 * Match a *local function/const definition* named `truncate` or `truncated`.
 * We deliberately do NOT match call sites (e.g. `truncateString(x, 5)`) nor the
 * canonical array util `truncated<T>` in render/helpers.ts (not in this list).
 */
const LOCAL_HELPER_DEF =
  /(?:^|\n)\s*(?:export\s+)?(?:function\s+(truncate|truncated)\s*[<(]|const\s+(truncate|truncated)\s*=\s*(?:\([^)]*\)|[A-Za-z0-9_]+)\s*(?::[^=]+)?=>)/;

describe('no local truncate helper re-introduced (T11353 guard)', () => {
  for (const rel of MIGRATED_CORE_FILES) {
    it(`${rel} uses the shared truncateString, defines no local truncate helper`, () => {
      const src = readFileSync(join(CORE_SRC, rel), 'utf8');
      expect(src.includes('truncateString')).toBe(true);
      const match = LOCAL_HELPER_DEF.exec(src);
      expect(
        match,
        match
          ? `Local truncate helper "${match[1] ?? match[2]}" found in ${rel} — use the shared truncateString from render/helpers.ts instead.`
          : undefined,
      ).toBeNull();
    });
  }

  it('canon-lint.ts truncateEvidence delegates to truncateString (no local slice+ellipsis)', () => {
    const src = readFileSync(join(CORE_SRC, 'session/canon-lint.ts'), 'utf8');
    expect(src.includes('truncateString')).toBe(true);
    // The duplicated truncation tail `.slice(0, N)}…` must be gone.
    expect(/\.slice\(0,\s*\d+\)\}…/.test(src)).toBe(false);
  });
});
