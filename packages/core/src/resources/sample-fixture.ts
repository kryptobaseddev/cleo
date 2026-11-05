/**
 * A fixed resource sample for the test suite (T14282): `CLEO_RESOURCE_SAMPLE_FILE`
 * names a JSON {@link ResourceSample} that the default backend returns
 * instead of reading the host, so a test's admission never depends on the
 * machine's load, and a CLI child a test spawns can be fed a hot sample to
 * drive the real admission logic end to end.
 *
 * It is honoured ONLY for a file below the test sandbox marker
 * ({@link TEST_SANDBOX_MARKER}). Anywhere else it is ignored with one stderr
 * line: on a real machine it would fake a calm host, a bypass of admission
 * under another name.
 *
 * @task T14282
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { insideTestSandbox, TEST_SANDBOX_MARKER } from '../test-sandbox.js';
import type { ChildRssSweep, ResourceBackend, ResourceSample } from './backend.js';

/** Names a JSON resource sample the default backend returns (test sandbox only). */
export const RESOURCE_SAMPLE_FILE_ENV = 'CLEO_RESOURCE_SAMPLE_FILE';

let warned = false;

/**
 * The sample file to use, or `null`: unset, or set outside the test sandbox
 * (then ignored, with one stderr line per process).
 *
 * @param env - the environment. @defaultValue process.env
 * @param warn - where the ignored-file line goes. @defaultValue stderr
 * @returns the absolute path, or `null`.
 */
export function sampleFixturePath(
  env: NodeJS.ProcessEnv = process.env,
  warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): string | null {
  const raw = env[RESOURCE_SAMPLE_FILE_ENV];
  if (raw === undefined || raw === '') return null;
  const path = resolve(raw);
  if (insideTestSandbox(path)) return path;
  if (!warned) {
    warned = true;
    warn(
      `[cleo] ${RESOURCE_SAMPLE_FILE_ENV} is ignored: it is a test fixture, honoured only ` +
        `below a ${TEST_SANDBOX_MARKER} marker; admission reads this machine.`,
    );
  }
  return null;
}

/** Forget the ignored-file warning. Tests only. @internal */
export function _resetSampleFixtureForTest(): void {
  warned = false;
}

/**
 * `base` with its samples read from `path` (a JSON {@link ResourceSample},
 * stamped with the current time). A file that cannot be read or parsed
 * throws, which every caller reads as "no signal".
 *
 * @param base - the platform backend (its RSS sweep is kept).
 * @param path - the sample file, already checked by {@link sampleFixturePath}.
 */
export function withSampleFixture(base: ResourceBackend, path: string): ResourceBackend {
  return {
    async sample(): Promise<ResourceSample> {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as ResourceSample;
      return { ...parsed, sampledAtMs: Date.now() };
    },
    sweepChildRss(pids: readonly number[]): Promise<ChildRssSweep> {
      return base.sweepChildRss(pids);
    },
  };
}
