/**
 * T12721 — `toReplicaPresence` maps a fleet location to the cloud
 * `ReplicaPresence`: every remote enum value, the derivation rules, and no
 * device-local field ever reaches the output.
 *
 * @task T12721
 */

import {
  NEXUS_FLEET_SCHEMA_VERSION,
  type NexusFleetDevice,
  type NexusFleetGitSummary,
  type NexusFleetLocation,
} from '@cleocode/contracts';
import { ReplicaPresence } from '@cleocode/contracts/cloud';
import { describe, expect, it } from 'vitest';
import { REPLICA_PRESENCE_LIMITS, replicaRemoteState, toReplicaPresence } from '../presence.js';

/** Distinctive device-local values: none may appear in any serialized output. */
const LOCAL = {
  path: '/Users/secret-user/private-repos/acme-internal',
  hostname: 'secret-host.corp.example',
  remoteUrl: 'https://github.com/acme-private/internal-thing.git',
  remoteName: 'upstream-secret-remote',
  upstream: 'upstream-secret-remote/feature-x',
  headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  remoteHeadSha: 'f0e1d2c3b4a5968778695a4b3c2d1e0f98765432',
  probeError: 'fatal: cannot open /Users/secret-user/private-repos/acme-internal: EACCES',
  branch: 'feature/secret-customer-name',
} as const;

function gitSummary(over: Partial<NexusFleetGitSummary> = {}): NexusFleetGitSummary {
  return {
    branch: LOCAL.branch,
    headSha: LOCAL.headSha,
    headCommittedAt: '2026-09-29T08:07:21-07:00',
    detached: false,
    dirtyCount: 0,
    untrackedCount: 0,
    remote: {
      name: LOCAL.remoteName,
      url: LOCAL.remoteUrl,
      upstream: LOCAL.upstream,
      headSha: LOCAL.remoteHeadSha,
      ahead: 0,
      behind: 0,
      fetchedAt: '2026-09-29T12:00:00.000Z',
      stale: false,
    },
    probedAt: '2026-09-29T15:00:00.000Z',
    probeStale: false,
    probeErrorCode: null,
    probeError: null,
    ...over,
  };
}

function withRemote(
  remote: Partial<NexusFleetGitSummary['remote']>,
  over: Partial<NexusFleetGitSummary> = {},
): NexusFleetGitSummary {
  const base = gitSummary(over);
  return { ...base, remote: { ...base.remote, ...remote } };
}

function location(git: NexusFleetGitSummary | null): NexusFleetLocation {
  return {
    deviceId: 'dev-a',
    replicaId: null,
    hostname: LOCAL.hostname,
    current: true,
    path: LOCAL.path,
    state: 'live',
    lastSeen: '2026-09-29T14:00:00.000Z',
    git,
    flags: [],
  };
}

const device: NexusFleetDevice = {
  deviceId: 'dev-a',
  hostname: LOCAL.hostname,
  os: 'darwin',
  arch: 'arm64',
  cleoVersion: '2026.9.23',
  lastHeartbeatAt: '2026-09-29T14:30:00.000Z',
  heartbeatStale: false,
  current: true,
};

describe('replicaRemoteState — every enum value', () => {
  it.each([
    ['in-sync', withRemote({ ahead: 0, behind: 0 })],
    ['ahead', withRemote({ ahead: 2, behind: 0 })],
    ['behind', withRemote({ ahead: 0, behind: 3 })],
    ['diverged', withRemote({ ahead: 1, behind: 1 })],
    ['no-upstream', withRemote({ upstream: null, ahead: null, behind: null })],
    ['unknown', withRemote({ fetchedAt: null })],
  ] as const)('%s', (expected, git) => {
    expect(replicaRemoteState(git)).toBe(expected);
    const body = toReplicaPresence(location(git), device);
    expect(body.git?.remote).toBe(expected);
    expect(ReplicaPresence.parse(body)).toEqual(body);
  });

  it('a probe error is unknown, even with no upstream learned', () => {
    const errored = withRemote(
      { upstream: null, fetchedAt: null, ahead: null, behind: null },
      { probeErrorCode: 'E_PATH_ACCESS', probeError: LOCAL.probeError, dirtyCount: null },
    );
    expect(replicaRemoteState(errored)).toBe('unknown');
    const fetchFailed = withRemote(
      { ahead: 0, behind: 4 },
      { probeErrorCode: 'E_FETCH_FAILED', probeError: 'fetch failed' },
    );
    expect(replicaRemoteState(fetchFailed)).toBe('unknown');
  });

  it('null ahead/behind with an upstream and a fetch is in-sync', () => {
    expect(replicaRemoteState(withRemote({ ahead: null, behind: null }))).toBe('in-sync');
  });
});

describe('toReplicaPresence derivation', () => {
  it('maps dirty, counts, instants, cliVersion and schemaVersion', () => {
    const body = toReplicaPresence(
      location(withRemote({ ahead: 2, behind: 1 }, { dirtyCount: 0, untrackedCount: 3 })),
      device,
    );
    expect(body).toEqual({
      cliVersion: '2026.9.23',
      schemaVersion: NEXUS_FLEET_SCHEMA_VERSION,
      observedAt: '2026-09-29T15:00:00.000Z',
      git: {
        dirty: true,
        ahead: 2,
        behind: 1,
        remote: 'diverged',
        lastCommitAt: '2026-09-29T15:07:21.000Z',
      },
    });
    expect(ReplicaPresence.parse(body)).toEqual(body);
  });

  it('dirty is false when both counts are zero or unknown; ahead/behind default to 0', () => {
    const body = toReplicaPresence(
      location(
        withRemote({ ahead: null, behind: null }, { dirtyCount: null, untrackedCount: null }),
      ),
      device,
    );
    expect(body.git).toMatchObject({ dirty: false, ahead: 0, behind: 0 });
    const tracked = toReplicaPresence(location(gitSummary({ dirtyCount: 1 })), device);
    expect(tracked.git?.dirty).toBe(true);
  });

  it('branch only on opt-in, truncated to 200', () => {
    expect(toReplicaPresence(location(gitSummary()), device).git).not.toHaveProperty('branch');
    expect(
      toReplicaPresence(location(gitSummary()), device, { includeBranch: false }).git,
    ).not.toHaveProperty('branch');
    expect(
      toReplicaPresence(location(gitSummary()), device, { includeBranch: true }).git?.branch,
    ).toBe(LOCAL.branch);
    const long = 'b'.repeat(250);
    const body = toReplicaPresence(location(gitSummary({ branch: long })), device, {
      includeBranch: true,
    });
    expect(body.git?.branch).toHaveLength(REPLICA_PRESENCE_LIMITS.branchMax);
    expect(ReplicaPresence.parse(body)).toEqual(body);
    const detached = toReplicaPresence(location(gitSummary({ branch: null })), device, {
      includeBranch: true,
    });
    expect(detached.git).not.toHaveProperty('branch');
  });

  it('cliVersion truncated to 40, unknown when never reported', () => {
    const long = toReplicaPresence(location(gitSummary()), {
      ...device,
      cleoVersion: `2026.9.23-${'x'.repeat(60)}`,
    });
    expect(long.cliVersion).toHaveLength(REPLICA_PRESENCE_LIMITS.cliVersionMax);
    expect(ReplicaPresence.parse(long)).toEqual(long);
    expect(
      toReplicaPresence(location(gitSummary()), { ...device, cleoVersion: null }).cliVersion,
    ).toBe('unknown');
  });

  it('lastCommitAt is omitted when HEAD commit time is unknown', () => {
    const body = toReplicaPresence(location(gitSummary({ headCommittedAt: null })), device);
    expect(body.git).not.toHaveProperty('lastCommitAt');
  });

  it('an unprobed location has no git block and is observed at lastSeen', () => {
    const body = toReplicaPresence(location(null), device);
    expect(body).toEqual({
      cliVersion: '2026.9.23',
      schemaVersion: NEXUS_FLEET_SCHEMA_VERSION,
      observedAt: '2026-09-29T14:00:00.000Z',
    });
    expect(ReplicaPresence.parse(body)).toEqual(body);
  });

  it('schemaVersion can be overridden', () => {
    expect(
      toReplicaPresence(location(gitSummary()), device, { schemaVersion: 7 }).schemaVersion,
    ).toBe(7);
  });

  it('refuses a device that does not hold the location', () => {
    expect(() =>
      toReplicaPresence(location(gitSummary()), { ...device, deviceId: 'dev-b' }),
    ).toThrow(/does not hold/);
  });
});

describe('no device-local field is ever emitted', () => {
  const cases: Array<[string, NexusFleetLocation, boolean]> = [
    ['clean', location(gitSummary()), false],
    ['clean + branch opt-in', location(gitSummary()), true],
    ['diverged dirty', location(withRemote({ ahead: 3, behind: 2 }, { dirtyCount: 5 })), true],
    [
      'errored',
      location(withRemote({}, { probeErrorCode: 'E_PATH_ACCESS', probeError: LOCAL.probeError })),
      true,
    ],
    ['unprobed', location(null), true],
  ];

  it.each(cases)('%s', (_name, loc, includeBranch) => {
    const json = JSON.stringify(toReplicaPresence(loc, device, { includeBranch }));
    const forbidden: string[] = [
      LOCAL.path,
      'secret-user',
      LOCAL.hostname,
      LOCAL.remoteUrl,
      'acme-private',
      LOCAL.remoteName,
      LOCAL.upstream,
      LOCAL.headSha,
      LOCAL.headSha.slice(0, 7),
      LOCAL.remoteHeadSha,
      LOCAL.remoteHeadSha.slice(0, 7),
      LOCAL.probeError,
      'EACCES',
      'E_PATH_ACCESS',
      'dev-a',
    ];
    if (!includeBranch) forbidden.push(LOCAL.branch);
    for (const value of forbidden) expect(json, value).not.toContain(value);
    // Only the server's keys, at every depth (strict: no extra top-level key).
    const raw: Record<string, object> = JSON.parse(json);
    const body = ReplicaPresence.strict().parse(raw);
    expect(Object.keys(raw).sort()).toEqual(
      body.git === undefined
        ? ['cliVersion', 'observedAt', 'schemaVersion']
        : ['cliVersion', 'git', 'observedAt', 'schemaVersion'],
    );
    if (raw['git'] !== undefined) {
      for (const key of Object.keys(raw['git'])) {
        expect(['branch', 'dirty', 'ahead', 'behind', 'remote', 'lastCommitAt']).toContain(key);
      }
    }
    expect(body).toEqual(raw);
  });
});
