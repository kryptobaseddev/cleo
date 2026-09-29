/**
 * `isMissingProjectError` (T12733): the T310 startup check stays silent
 * (debug) when a project-independent command such as `cleo decide config`
 * runs outside any CLEO project, and still warns on a real failure.
 *
 * @task T12733
 */

import { ExitCode } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { CleoError } from '../errors.js';
import { isMissingProjectError } from '../project-scope.js';

describe('isMissingProjectError', () => {
  it('recognises every "no project here" signal', () => {
    expect(
      isMissingProjectError(
        new CleoError(
          ExitCode.NOT_FOUND,
          'Not inside a CLEO project. Run cleo init or cd to an existing project',
        ),
      ),
    ).toBe(true);
    expect(
      isMissingProjectError(
        new CleoError(ExitCode.NEXUS_PROJECT_NOT_FOUND, 'No CLEO project found — …'),
      ),
    ).toBe(true);
    expect(isMissingProjectError(new Error('E_NO_PROJECT: no project root'))).toBe(true);
    expect(isMissingProjectError(new CleoError(ExitCode.CONFIG_ERROR, 'Run cleo init at /x'))).toBe(
      true,
    );
  });

  it('a real failure is not mistaken for a missing project (it still warns)', () => {
    expect(
      isMissingProjectError(new Error('SQLITE_CORRUPT: database disk image is malformed')),
    ).toBe(false);
    expect(isMissingProjectError(new Error('EACCES: permission denied'))).toBe(false);
    expect(isMissingProjectError(undefined)).toBe(false);
  });
});
