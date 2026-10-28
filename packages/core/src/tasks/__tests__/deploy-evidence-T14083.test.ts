/**
 * `deploy:` evidence (T14083): an exact-commit deployment plus a health probe
 * naming the commit, accepted for the gates the project maps it to.
 *
 * @task T14083
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type EvidenceValidationContext,
  parseEvidenceString,
  type VerificationGate,
} from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type DeployProbe,
  deployContainmentReason,
  validateDeployAtom,
} from '../deploy-evidence.js';

let root: string;
let change: string;
let deployed: string;
let unrelated: string;

function git(args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...args], {
    cwd: root,
    encoding: 'utf-8',
  }).trim();
}

function commit(file: string, body: string, message: string): string {
  writeFileSync(join(root, file), body);
  git(['add', file]);
  git(['commit', '-q', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-deploy-')));
  git(['init', '-q', '-b', 'main']);
  const base = commit('a.txt', 'base\n', 'base');
  change = commit('a.txt', 'change\n', 'T950: the change');
  deployed = commit('b.txt', 'later\n', 'later work');
  git(['switch', '-q', '-c', 'other', base]);
  unrelated = commit('c.txt', 'other\n', 'unrelated');
  git(['switch', '-q', 'main']);
  mkdirSync(join(root, '.cleo'), { recursive: true });
  writeFileSync(
    join(root, '.cleo', 'project-context.json'),
    JSON.stringify({ evidence: { deployGates: ['qaPassed'] } }),
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function context(gates: VerificationGate[]): EvidenceValidationContext {
  return {
    task: {
      id: 'T950',
      verification: {
        passed: false,
        round: 1,
        gates: { implemented: true },
        failureLog: [],
        lastAgent: null,
        lastUpdated: null,
        evidence: {
          implemented: {
            atoms: [{ kind: 'commit', sha: change, shortSha: change.slice(0, 7) }],
            capturedAt: '2026-10-27T00:00:00Z',
            capturedBy: 'test',
          },
        },
      },
    },
    gates,
    criteria: [],
  };
}

const healthy =
  (sha: string): DeployProbe =>
  async () => ({ status: 200, body: JSON.stringify({ status: 'ok', commit: sha }) });

const atom = (sha: string) => ({
  kind: 'deploy' as const,
  provider: 'railway',
  deploymentId: 'dep-1',
  sha,
  probeUrl: 'https://api.example.test/healthz',
});

const roots = () => ({ storeRoot: root, executionRoot: root });

describe('deploy: evidence (T14083)', () => {
  it('parses deploy:<provider>/<id>@<sha>=<probeUrl>, and refuses a malformed one', () => {
    expect(
      parseEvidenceString('deploy:railway/9f1c-2@4f60761=https://api.example.test/healthz'),
    ).toEqual([
      {
        kind: 'deploy',
        provider: 'railway',
        deploymentId: '9f1c-2',
        sha: '4f60761',
        probeUrl: 'https://api.example.test/healthz',
      },
    ]);
    expect(() => parseEvidenceString('deploy:railway@4f60761')).toThrow(/Malformed deploy atom/);
  });

  it('a deploy of a commit containing the change, probed healthy and naming it, stands', async () => {
    const result = await validateDeployAtom(
      atom(deployed.slice(0, 10)),
      roots(),
      context(['qaPassed']),
      undefined,
      healthy(deployed.slice(0, 7)),
    );
    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
    if (!result.ok || result.atom.kind !== 'deploy') return;
    expect(result.atom).toMatchObject({ sha: deployed, probeStatus: 200, provider: 'railway' });
  });

  it('a deploy of another commit that lacks the change is refused', async () => {
    const result = await validateDeployAtom(
      atom(unrelated),
      roots(),
      context(['qaPassed']),
      undefined,
      healthy(unrelated),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.codeName).toBe('E_EVIDENCE_CONTENT_MISMATCH');
    expect(!result.ok && result.reason).toMatch(/does not contain the task's change/);
  });

  it('a failed probe, or one that does not name the commit, is refused', async () => {
    const down = await validateDeployAtom(
      atom(deployed),
      roots(),
      context(['qaPassed']),
      undefined,
      async () => ({ status: 503, body: deployed }),
    );
    expect(!down.ok && down.codeName).toBe('E_EVIDENCE_TOOL_FAILED');
    expect(!down.ok && down.reason).toMatch(/HTTP 503/);
    const silent = await validateDeployAtom(
      atom(deployed),
      roots(),
      context(['qaPassed']),
      undefined,
      healthy('0000000'),
    );
    expect(!silent.ok && silent.reason).toMatch(/X-Version header names commit/);
    const unreachable = await validateDeployAtom(
      atom(deployed),
      roots(),
      context(['qaPassed']),
      undefined,
      async () => {
        throw new Error('connect ECONNREFUSED');
      },
    );
    expect(!unreachable.ok && unreachable.reason).toMatch(/did not answer: connect ECONNREFUSED/);
  });

  it('accepts the commit named in an X-Commit or X-Version header', async () => {
    for (const header of ['x-commit', 'x-version']) {
      const result = await validateDeployAtom(
        atom(deployed),
        roots(),
        context(['qaPassed']),
        undefined,
        async () => ({ status: 200, body: 'ok', headers: { [header]: `v1+${deployed}` } }),
      );
      expect(result.ok, `${header}: ${result.ok ? '' : result.reason}`).toBe(true);
    }
  });

  it('counts only for a gate the project maps it to; nothing is mapped by default', async () => {
    writeFileSync(join(root, '.cleo', 'project-context.json'), JSON.stringify({}));
    const unmapped = await validateDeployAtom(
      atom(deployed),
      roots(),
      context(['qaPassed']),
      undefined,
      healthy(deployed),
    );
    expect(!unmapped.ok && unmapped.reason).toMatch(
      /evidence\.deployGates maps it to \(none here\)/,
    );
  });

  it('a gate the project does not list is refused, naming evidence.deployGates', async () => {
    const result = await validateDeployAtom(
      atom(deployed),
      roots(),
      context(['testsPassed']),
      undefined,
      healthy(deployed),
    );
    expect(!result.ok && result.codeName).toBe('E_EVIDENCE_INSUFFICIENT');
    expect(!result.ok && result.reason).toMatch(/evidence\.deployGates maps it to \(qaPassed\)/);
  });

  it('a squash-merged change (a patch-equivalent copy) is contained', async () => {
    git(['switch', '-q', '-c', 'feature', 'main']);
    const branchWork = commit('d.txt', 'feature\n', 'T950: on the branch');
    git(['switch', '-q', 'main']);
    git(['merge', '-q', '--squash', 'feature']);
    git(['commit', '-q', '-m', 'T950 squashed (#7)']);
    const squashed = git(['rev-parse', 'HEAD']);
    const ctx = context(['qaPassed']);
    const evidence = ctx.task.verification?.evidence?.implemented;
    if (evidence)
      evidence.atoms = [{ kind: 'commit', sha: branchWork, shortSha: branchWork.slice(0, 7) }];
    const result = await validateDeployAtom(
      atom(squashed),
      roots(),
      ctx,
      undefined,
      healthy(squashed),
    );
    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
  });

  it('cleo complete re-checks containment, and records the probe body hash', async () => {
    const result = await validateDeployAtom(
      atom(deployed),
      roots(),
      context(['qaPassed']),
      undefined,
      healthy(deployed),
    );
    if (!result.ok || result.atom.kind !== 'deploy') throw new Error('expected a deploy atom');
    expect(result.atom.probeBodySha256).toMatch(/^[0-9a-f]{64}$/);
    const task = context(['qaPassed']).task;
    expect(deployContainmentReason(task, [result.atom], root)).toBeNull();
    const elsewhere = { ...result.atom, sha: unrelated };
    expect(deployContainmentReason(task, [elsewhere], root)).toMatch(
      /does not contain the task's implemented change/,
    );
  });
});
