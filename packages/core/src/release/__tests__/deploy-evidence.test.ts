/**
 * `deploy:` evidence (T14083): CLEO probes the deployment itself, against a
 * local HTTP server (no real network), and the deployed SHA must contain the
 * task's implemented commits.
 *
 * @task T14083
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceAtom } from '@cleocode/contracts';
import { parseEvidenceString } from '@cleocode/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boundHeadGapReason, checkGateEvidenceMinimum } from '../../tasks/evidence.js';
import {
  probeDeployment,
  readDeploySatisfies,
  resolveDeployEvidenceAtom,
} from '../deploy-evidence.js';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
}

function commit(dir: string, file: string, message: string): string {
  writeFileSync(join(dir, file), `export const v = '${message}';\n`);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

let repo: string;
let base: string;
let work: string;
let server: Server;
let origin: string;
/** The SHA each probe path serves; set per test. */
let served = '';

beforeAll(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-deploy-evidence-')));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  base = commit(repo, 'base.ts', 'base');
  work = commit(repo, 'work.ts', 'T901: work');
  server = createServer((req, res) => {
    if (req.url?.startsWith('/echo')) {
      // Echoes its request: names whatever SHA the URL carries.
      res.writeHead(200, { 'X-Commit': req.url }).end(`you asked for ${req.url}`);
      return;
    }
    switch (req.url) {
      case '/header':
        res.writeHead(200, { 'X-Commit': served }).end('ok');
        return;
      case '/version':
        res.writeHead(200, { 'X-Version': `v1.2.3+${served.slice(0, 12)}` }).end('ok');
        return;
      case '/body':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', commit: served }));
        return;
      case '/none':
        res.writeHead(200).end('ok');
        return;
      case '/fail':
        res.writeHead(503, { 'X-Commit': served }).end('down');
        return;
      case '/hang':
        return; // never answers
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(repo, { recursive: true, force: true });
});

const roots = (): { storeRoot: string; executionRoot: string } => ({
  storeRoot: repo,
  executionRoot: repo,
});
const context = { evidence: { deploySatisfies: ['documented'] } };

describe('deploy: atom parsing (T14083)', () => {
  it('parses provider, deployment id, sha and probe url', () => {
    expect(
      parseEvidenceString('deploy:Railway/dpl_9f3c@ABCDEF1|https://api.example.com/health'),
    ).toEqual([
      {
        kind: 'deploy',
        provider: 'railway',
        deploymentId: 'dpl_9f3c',
        sha: 'abcdef1',
        probeUrl: 'https://api.example.com/health',
      },
    ]);
  });

  it('refuses a deploy atom without a probe url', () => {
    expect(() => parseEvidenceString('deploy:railway/dpl_9f3c@abcdef1')).toThrow(
      /expected <provider>\/<deploymentId>@<sha>\|<probe-url>/,
    );
  });
});

describe('deploy probe (T14083)', () => {
  it('passes a 2xx probe naming the deployed SHA in X-Commit, and records the probe', async () => {
    served = work;
    const result = await resolveDeployEvidenceAtom(
      {
        provider: 'railway',
        deploymentId: 'd1',
        sha: work.slice(0, 8),
        probeUrl: `${origin}/header`,
      },
      roots(),
      { projectContext: context, taskId: 'T901' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.atom).toMatchObject({
      kind: 'deploy',
      headSha: work,
      satisfiesGates: ['documented'],
      taskId: 'T901',
      probe: { status: 200, shaSource: 'x-commit' },
    });
    expect(result.atom.probe.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isNaN(Date.parse(result.atom.probe.probedAt))).toBe(false);
  });

  it('accepts the SHA in X-Version or in the body', async () => {
    served = work;
    const version = await probeDeployment(`${origin}/version`, work);
    expect(version.ok && version.probe.shaSource).toBe('x-version');
    const body = await probeDeployment(`${origin}/body`, work);
    expect(body.ok && body.probe.shaSource).toBe('body');
  });

  it('refuses a 2xx that names no SHA, naming the header/body fix', async () => {
    const result = await probeDeployment(`${origin}/none`, work);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/names no commit SHA/);
    expect(result.reason).toMatch(/X-Commit/);
  });

  it('refuses a 2xx naming another commit', async () => {
    served = base;
    const result = await probeDeployment(`${origin}/header`, work);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/serves another build/);
  });

  it('refuses a probe URL that carries the deployed SHA, which an echoing endpoint would name', async () => {
    for (const path of [
      `/echo?sha=${work.slice(0, 7)}`,
      `/echo/${work.slice(0, 10).toUpperCase()}`,
      `/echo?v=build-${work}`,
    ]) {
      const result = await probeDeployment(`${origin}${path}`, work);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/its URL carries the deployed commit/);
    }
    // The same echoing endpoint, asked nothing about the SHA, names none.
    const plain = await probeDeployment(`${origin}/echo`, work);
    expect(plain.ok).toBe(false);
    if (!plain.ok) expect(plain.reason).toMatch(/names no commit SHA/);
  });

  it('refuses a 5xx even when it names the SHA', async () => {
    served = work;
    const result = await probeDeployment(`${origin}/fail`, work);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/HTTP 503/);
  });

  it('refuses a probe that times out', async () => {
    const result = await probeDeployment(`${origin}/hang`, work, { timeoutMs: 200 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no complete response within 200 ms/);
  });

  it('refuses a deployed SHA git does not have', async () => {
    const result = await resolveDeployEvidenceAtom(
      { provider: 'fly', deploymentId: 'd1', sha: 'deadbeefdead', probeUrl: `${origin}/header` },
      roots(),
      { projectContext: context },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/git fetch/);
  });
});

describe('deploy: gate mapping (T14083)', () => {
  const atom = (
    gates: Extract<EvidenceAtom, { kind: 'deploy' }>['satisfiesGates'],
    headSha = work,
  ): EvidenceAtom => ({
    kind: 'deploy',
    provider: 'railway',
    deploymentId: 'd1',
    headSha,
    probeUrl: `${origin}/header`,
    probe: {
      status: 200,
      probedAt: '2026-10-27T00:00:00Z',
      bodySha256: 'x',
      shaSource: 'x-commit',
    },
    satisfiesGates: gates,
    taskId: 'T901',
  });

  it('with no evidence.deploySatisfies the atom is refused and satisfies nothing', async () => {
    expect(readDeploySatisfies(null)).toEqual([]);
    expect(readDeploySatisfies({ evidence: { deploySatisfies: 'testsPassed' } })).toEqual([]);
    served = work;
    const result = await resolveDeployEvidenceAtom(
      { provider: 'railway', deploymentId: 'd1', sha: work, probeUrl: `${origin}/header` },
      roots(),
      { projectContext: { evidence: {} } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/deploySatisfies lists none/);
    expect(checkGateEvidenceMinimum('documented', [atom([])])).not.toBeNull();
  });

  it('stands only for the gates the project listed, never testsPassed by default', () => {
    expect(checkGateEvidenceMinimum('documented', [atom(['documented'])])).toBeNull();
    expect(checkGateEvidenceMinimum('testsPassed', [atom(['documented'])])).not.toBeNull();
    expect(checkGateEvidenceMinimum('testsPassed', [atom(['testsPassed'])])).toBeNull();
  });

  it('refuses a deployed SHA that does not contain the implemented commit', async () => {
    const task = {
      id: 'T901',
      verification: {
        passed: false,
        round: 1,
        gates: {},
        lastAgent: null,
        lastUpdated: null,
        failureLog: [],
        evidence: {
          implemented: {
            atoms: [{ kind: 'commit' as const, sha: work }],
            capturedAt: '2026-10-27T00:00:00Z',
            capturedBy: 'test',
          },
        },
      },
    };
    expect(await boundHeadGapReason(task, [atom(['documented'], base)], repo)).toMatch(
      /does not contain T901's implemented commit/,
    );
    expect(await boundHeadGapReason(task, [atom(['documented'], work)], repo)).toBeNull();

    // A squash merge: the deployed main commit is not a descendant of the
    // branch commit, but carries its patch (git cherry, the T13003 rule).
    git(repo, ['switch', '-q', '-c', 'task/T902', base]);
    const branchWork = commit(repo, 'squashed.ts', 'T902: work');
    git(repo, ['switch', '-q', 'main']);
    git(repo, ['merge', '-q', '--squash', 'task/T902']);
    git(repo, ['commit', '-q', '-m', 'T902: squash merge']);
    const squash = git(repo, ['rev-parse', 'HEAD']);
    const squashed = {
      ...task,
      id: 'T902',
      verification: {
        ...task.verification,
        evidence: {
          implemented: {
            ...task.verification.evidence.implemented,
            atoms: [{ kind: 'commit' as const, sha: branchWork }],
          },
        },
      },
    };
    expect(await boundHeadGapReason(squashed, [atom(['documented'], squash)], repo)).toBeNull();
    expect(await boundHeadGapReason(squashed, [atom(['documented'], work)], repo)).toMatch(
      /does not contain T902's implemented commit/,
    );
  });
});
