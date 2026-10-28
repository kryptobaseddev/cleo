/**
 * `deploy:` evidence (T14083): a deployment of a commit that contains the
 * task's change, proven live by a health probe whose response names that
 * commit. Ops-verified work (an exact-SHA deploy with `/healthz` 200) needed
 * an owner override before; this is the atom for it.
 *
 * It counts only for the gates the project maps in `evidence.deployGates`.
 *
 * @task T14083
 */

import { execFileSync } from 'node:child_process';
import type {
  EvidenceAtom,
  EvidenceValidationContext,
  VerificationGate,
} from '@cleocode/contracts';
import { discoveryEnv } from '../git/work-tree.js';
import { readProjectContextFile } from '../release/ci-evidence.js';
import type { AtomValidation, EvidenceRoots } from './evidence.js';

/** Gates a `deploy:` atom can stand for. */
const DEPLOY_GATES: readonly VerificationGate[] = ['testsPassed', 'qaPassed'];

/** How long the health probe may take before it counts as failed. */
const PROBE_TIMEOUT_MS = 15_000;

/** Bytes of the probe body read when looking for the commit. */
const PROBE_BODY_LIMIT = 65_536;

/** A parsed `deploy:` atom. */
export interface ParsedDeployAtom {
  kind: 'deploy';
  provider: string;
  deploymentId: string;
  sha: string;
  probeUrl: string;
}

/** What a health probe answered. */
export interface DeployProbeResponse {
  status: number;
  body: string;
}

/** Fetches a probe URL; injectable for tests. */
export type DeployProbe = (url: string) => Promise<DeployProbeResponse>;

/** The gates the project maps `deploy:` evidence to (`evidence.deployGates`). */
function deployGates(storeRoot: string): VerificationGate[] {
  const evidence = readProjectContextFile(storeRoot)?.evidence;
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) return [];
  const gates = (evidence as { deployGates?: unknown }).deployGates;
  return Array.isArray(gates)
    ? DEPLOY_GATES.filter((gate) => gates.some((entry) => entry === gate))
    : [];
}

function git(root: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf-8',
      env: discoveryEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** The commits the task's change is recorded as: its implemented commits and PR merges. */
function changeCommits(
  context: EvidenceValidationContext | undefined,
  siblingCommitSha: string | undefined,
): string[] {
  const recorded = (context?.task.verification?.evidence?.implemented?.atoms ?? []).flatMap(
    (atom: EvidenceAtom) =>
      atom.kind === 'commit' ? [atom.sha] : atom.kind === 'pr' ? [atom.mergeCommitSha] : [],
  );
  const written = (context?.artifactPrs ?? []).map((pr) => pr.mergeCommitSha);
  return [...new Set([...recorded, ...written, ...(siblingCommitSha ? [siblingCommitSha] : [])])];
}

/** Fetch the probe URL with a deadline, reading at most {@link PROBE_BODY_LIMIT} bytes. */
const defaultProbe: DeployProbe = async (url) => {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const body = (await response.text()).slice(0, PROBE_BODY_LIMIT);
  return { status: response.status, body };
};

/**
 * Validate a `deploy:` atom: the project maps it to the gate being written,
 * the deployed commit exists here and contains every commit the task's change
 * is recorded as, and the probe answers 2xx with a body naming the commit.
 *
 * @param parsed - The parsed atom.
 * @param roots - Store root (the gate mapping) and execution root (the commits).
 * @param context - The write's task and gates; required, since the mapping is per gate.
 * @param siblingCommitSha - A `commit:` atom in the same write.
 * @param probe - Probe fetcher; defaults to `fetch` with a 15 s deadline.
 * @returns The validated atom with the probe's status and time, or why not.
 * @task T14083
 */
export async function validateDeployAtom(
  parsed: ParsedDeployAtom,
  roots: EvidenceRoots,
  context?: EvidenceValidationContext,
  siblingCommitSha?: string,
  probe: DeployProbe = defaultProbe,
): Promise<AtomValidation> {
  const mapped = deployGates(roots.storeRoot);
  const wanted = (context?.gates ?? []).filter((gate) => DEPLOY_GATES.includes(gate));
  if (wanted.length === 0 || wanted.some((gate) => !mapped.includes(gate)))
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
      reason:
        `deploy evidence counts only for the gates evidence.deployGates maps it to ` +
        `(${mapped.length > 0 ? mapped.join(', ') : 'none here'}); this write asks for ` +
        `${wanted.length > 0 ? wanted.join(', ') : 'no testsPassed or qaPassed gate'}. ` +
        'Add the gate to evidence.deployGates in .cleo/project-context.json to accept it.',
    };
  const full = git(roots.executionRoot, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${parsed.sha}^{commit}`,
  ]);
  if (!full)
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INVALID',
      reason: `deploy commit ${parsed.sha} is not a commit in ${roots.executionRoot}; fetch it, or name the full SHA the provider deployed.`,
    };
  const change = changeCommits(context, siblingCommitSha);
  if (change.length === 0)
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
      reason:
        'deploy evidence needs the change it deployed: record implemented (commit: or pr:) first, or in the same write.',
    };
  const missing = change.filter(
    (sha) => git(roots.executionRoot, ['merge-base', '--is-ancestor', sha, full]) === null,
  );
  if (missing.length > 0)
    return {
      ok: false,
      codeName: 'E_EVIDENCE_CONTENT_MISMATCH',
      reason: `deployed commit ${full.slice(0, 12)} does not contain the task's change ${missing.map((s) => s.slice(0, 12)).join(', ')}; a deploy of an older or unrelated commit proves nothing about it.`,
    };
  let answer: DeployProbeResponse;
  try {
    answer = await probe(parsed.probeUrl);
  } catch (error) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_TOOL_FAILED',
      reason: `deploy probe ${parsed.probeUrl} did not answer: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (answer.status < 200 || answer.status > 299)
    return {
      ok: false,
      codeName: 'E_EVIDENCE_TOOL_FAILED',
      reason: `deploy probe ${parsed.probeUrl} answered HTTP ${answer.status}; the deployment is not healthy.`,
    };
  if (!answer.body.includes(full.slice(0, 7)))
    return {
      ok: false,
      codeName: 'E_EVIDENCE_CONTENT_MISMATCH',
      reason: `deploy probe ${parsed.probeUrl} answered ${answer.status} but its response does not name commit ${full.slice(0, 12)}; the probe must report the deployed SHA (e.g. a "commit" field in /healthz).`,
    };
  return {
    ok: true,
    atom: {
      kind: 'deploy',
      provider: parsed.provider,
      deploymentId: parsed.deploymentId,
      sha: full,
      probeUrl: parsed.probeUrl,
      probeStatus: answer.status,
      probedAt: new Date().toISOString(),
    },
  };
}
