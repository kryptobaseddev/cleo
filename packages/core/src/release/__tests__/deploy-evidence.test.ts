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
  checkDeployWithProvider,
  type DeployProviderCheckOptions,
  probeDeployment,
  railwayDeployAdapter,
  readDeploySatisfies,
  resolveDeployEvidenceAtom,
} from '../deploy-evidence.js';

/** No credential anywhere: the provider is never asked (no real network). */
const offline: DeployProviderCheckOptions = { env: {} };

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
      { projectContext: context, taskId: 'T901', provider: offline },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.atom).toMatchObject({
      kind: 'deploy',
      headSha: work,
      satisfiesGates: ['documented'],
      taskId: 'T901',
      probe: { status: 200, shaSource: 'x-commit' },
      providerCheck: {
        verified: false,
        reason: expect.stringMatching(/no RAILWAY_API_TOKEN\/RAILWAY_TOKEN/),
      },
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
      { projectContext: context, provider: offline },
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
      { projectContext: { evidence: {} }, provider: offline },
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

describe('deploy: the provider confirms the deployment (T14091, Railway)', () => {
  const token = 'rw-secret-token';
  const credentialed: DeployProviderCheckOptions = { env: { RAILWAY_API_TOKEN: token } };
  /** A stubbed Railway GraphQL API: one deployment, and which deployment is live. */
  function railway(deployment: Record<string, unknown> | null, liveId: string): typeof fetch {
    return (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${token}`);
      const query = JSON.parse(String(init?.body)).query as string;
      const data = query.includes('deployments(')
        ? { deployments: { edges: [{ node: { id: liveId } }] } }
        : { deployment };
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as typeof fetch;
  }
  const live = (commitHash: string) => ({
    id: 'dep-1',
    status: 'SUCCESS',
    meta: { commitHash },
    serviceId: 'svc',
    environmentId: 'env',
  });

  it('a live deployment built from the commit is verified, and the token is never kept', async () => {
    const r = await checkDeployWithProvider('railway', 'dep-1', work, {
      ...credentialed,
      fetch: railway(live(work), 'dep-1'),
    });
    expect(r).toMatchObject({
      ok: true,
      check: { verified: true, status: 'SUCCESS', commitSha: work },
    });
    expect(JSON.stringify(r)).not.toContain(token);
  });

  it('a deployment the provider does not have is refused, naming it', async () => {
    const r = await checkDeployWithProvider('railway', 'dep-x', work, {
      ...credentialed,
      fetch: railway(null, 'dep-1'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Railway has no deployment dep-x/);
  });

  it('a deployment that is not live is refused, naming it and its status', async () => {
    const failed = await checkDeployWithProvider('railway', 'dep-1', work, {
      ...credentialed,
      fetch: railway({ ...live(work), status: 'CRASHED' }, 'dep-1'),
    });
    expect(!failed.ok && failed.reason).toMatch(/deployment dep-1 is CRASHED, not live/);
    const superseded = await checkDeployWithProvider('railway', 'dep-1', work, {
      ...credentialed,
      fetch: railway(live(work), 'dep-2'),
    });
    expect(!superseded.ok && superseded.reason).toMatch(
      /dep-1 succeeded but is not the live one \(the live deployment is dep-2\)/,
    );
  });

  it('a deployment built from another commit is refused, naming the deployment and both commits', async () => {
    const r = await checkDeployWithProvider('railway', 'dep-1', work, {
      ...credentialed,
      fetch: railway(live(base), 'dep-1'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('railway deployment dep-1');
      expect(r.reason).toContain(base.slice(0, 12));
      expect(r.reason).toContain(work.slice(0, 12));
    }
  });

  it('with no adapter or no credential, the probe stands and the id is reported unverified', async () => {
    const noAdapter = await checkDeployWithProvider('fly', 'dep-1', work, credentialed);
    expect(noAdapter).toMatchObject({
      ok: true,
      check: { verified: false, reason: /no adapter for fly/ },
    });
    const noCredential = await checkDeployWithProvider('railway', 'dep-1', work, offline);
    expect(noCredential).toMatchObject({
      ok: true,
      check: { verified: false, reason: /no RAILWAY_API_TOKEN\/RAILWAY_TOKEN/ },
    });
  });

  it('reads the credential from the env only: account token, then project token', () => {
    expect(railwayDeployAdapter.credential({ RAILWAY_API_TOKEN: 'a', RAILWAY_TOKEN: 'p' })).toEqual(
      {
        header: 'Authorization',
        value: 'a',
      },
    );
    expect(railwayDeployAdapter.credential({ RAILWAY_TOKEN: 'p' })).toEqual({
      header: 'Project-Access-Token',
      value: 'p',
    });
    expect(railwayDeployAdapter.credential({ RAILWAY_TOKEN: '  ' })).toBeNull();
    expect(railwayDeployAdapter.credential({})).toBeNull();
  });
});
