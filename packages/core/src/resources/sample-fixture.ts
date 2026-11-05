/**
 * A fixed resource sample for the test suite (T14282): `CLEO_RESOURCE_SAMPLE_FILE`
 * names a JSON {@link ResourceSample} that the default backend returns
 * instead of reading the host, so a test's admission never depends on the
 * machine's load, and a CLI child a test spawns can be fed a hot sample to
 * drive the real admission logic end to end.
 *
 * It is honoured ONLY when both the file AND the project admission runs for
 * (the resolved CLEO project root, or the cwd when there is none) lie below
 * the test sandbox marker ({@link TEST_SANDBOX_MARKER}). Anywhere else it is
 * ignored with one stderr line: on a real project it would fake a calm host,
 * a bypass of admission under another name. A marker planted beside a sample
 * file does not make a real project a fixture.
 *
 * @task T14282
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getProjectRoot } from '../paths.js';
import { insideTestSandbox, TEST_SANDBOX_MARKER } from '../store/worktree-build-guard.js';
import type { ResourceBackend, ResourceSample } from './backend.js';

/** Names a JSON resource sample the default backend returns (test sandbox only). */
export const RESOURCE_SAMPLE_FILE_ENV = 'CLEO_RESOURCE_SAMPLE_FILE';

let warned = false;

/** The project admission runs for: the resolved CLEO root, else the cwd. */
function admissionProjectRoot(): string {
  try {
    return getProjectRoot();
  } catch {
    return process.cwd(); // CWD-OK: no CLEO project resolves; admission runs for the cwd
  }
}

/**
 * The sample file to use, or `null`: unset, or the file or the project lies
 * outside the test sandbox (then ignored, with one stderr line per process).
 *
 * @param env - the environment. @defaultValue process.env
 * @param warn - where the ignored-file line goes. @defaultValue stderr
 * @param projectRoot - the project admission runs for. @defaultValue the
 *   resolved CLEO project root, or the cwd when none resolves
 * @returns the absolute path, or `null`.
 */
export function sampleFixturePath(
  env: NodeJS.ProcessEnv = process.env,
  warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  projectRoot: string = admissionProjectRoot(),
): string | null {
  const raw = env[RESOURCE_SAMPLE_FILE_ENV];
  if (raw === undefined || raw === '') return null;
  const path = resolve(raw);
  // The root itself may hold the marker: search from a path inside it.
  const inRoot = join(resolve(projectRoot), TEST_SANDBOX_MARKER);
  if (insideTestSandbox(path) && insideTestSandbox(inRoot)) return path;
  if (!warned) {
    warned = true;
    warn(
      `[cleo] ${RESOURCE_SAMPLE_FILE_ENV} is ignored: it is a test fixture, honoured only ` +
        `when the file and the project both lie below a ${TEST_SANDBOX_MARKER} marker; ` +
        'admission reads this machine.',
    );
  }
  return null;
}

/** Forget the ignored-file warning. Tests only. @internal */
export function _resetSampleFixtureForTest(): void {
  warned = false;
}

/**
 * One sample for the default backend when {@link RESOURCE_SAMPLE_FILE_ENV} is
 * set (T14282): the fixture's JSON {@link ResourceSample}, stamped with the
 * current time, when {@link sampleFixturePath} honours it; otherwise `base`'s
 * own sample of this machine. A fixture that cannot be read or parsed throws,
 * which every caller reads as "no signal". Loaded only when the variable is
 * set, so the CLI's startup graph never carries it.
 *
 * @param base - the platform backend.
 * @returns the sample.
 */
export async function fixtureSample(base: ResourceBackend): Promise<ResourceSample> {
  const path = sampleFixturePath();
  if (path === null) return base.sample();
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as ResourceSample;
  return { ...parsed, sampledAtMs: Date.now() };
}
