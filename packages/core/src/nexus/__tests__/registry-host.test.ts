/**
 * Registry row host classification (T14013).
 *
 * @task T14013
 */

import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyRegistryRowHost, hasForeignPathRoot } from '../registry-host.js';

const NO_ROOT = '/zz-cleo-no-such-root/projects/app';

describe('registry row host (T14013)', () => {
  it('reads the host from recorded locations', () => {
    const locations = [
      { projectId: 'here', deviceId: 'this-mac', state: 'live' },
      { projectId: 'here', deviceId: 'fedora', state: 'missing' },
      { projectId: 'there', deviceId: 'fedora', state: 'live' },
    ];
    expect(
      classifyRegistryRowHost({ projectId: 'here', projectPath: NO_ROOT }, locations, 'this-mac'),
    ).toEqual({
      host: 'local',
      devices: [],
    });
    expect(
      classifyRegistryRowHost({ projectId: 'there', projectPath: '/x' }, locations, 'this-mac'),
    ).toEqual({
      host: 'other-host',
      devices: ['fedora'],
    });
  });

  it('a live location on another device wins over a non-live one here (mixed devices)', () => {
    const locations = [
      { projectId: 'x', deviceId: 'this-mac', state: 'missing' },
      { projectId: 'x', deviceId: 'fedora', state: 'live' },
      { projectId: 'x', deviceId: 'pi', state: 'candidate' },
    ];
    expect(
      classifyRegistryRowHost(
        { projectId: 'x', projectPath: '/Users/me/x' },
        locations,
        'this-mac',
      ),
    ).toEqual({
      host: 'other-host',
      devices: ['fedora'],
    });
  });

  it('a project recorded only here, even no longer live, is local', () => {
    const locations = [
      { projectId: 'x', deviceId: 'this-mac', state: 'missing' },
      { projectId: 'x', deviceId: 'fedora', state: 'superseded' },
    ];
    expect(
      classifyRegistryRowHost({ projectId: 'x', projectPath: '/Users/me/x' }, locations, 'this-mac')
        .host,
    ).toBe('local');
  });

  it('judges an unrecorded row by whether its path root exists here', () => {
    expect(
      classifyRegistryRowHost({ projectId: 'legacy', projectPath: NO_ROOT }, [], 'this-mac').host,
    ).toBe('foreign-root');
    const home = join(homedir(), 'zz-cleo-gone-project');
    expect(
      classifyRegistryRowHost({ projectId: 'legacy', projectPath: home }, [], 'this-mac').host,
    ).toBe('unknown');
  });

  it('never calls a temp path or a relative path foreign', () => {
    expect(hasForeignPathRoot(NO_ROOT)).toBe(true);
    expect(hasForeignPathRoot(join(tmpdir(), 'zz-cleo-fixture', 'x'))).toBe(false);
    expect(hasForeignPathRoot('relative/path')).toBe(false);
  });
});
