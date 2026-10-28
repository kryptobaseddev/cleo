/**
 * `deploy:<provider>/<deploymentId>@<sha>|<probe-url>` evidence (T14083).
 *
 * A deployment is proven by CLEO itself, never by the agent's word (option
 * (b), a self-attested deploy record, was rejected): at verify time CLEO runs
 * one bounded GET of the probe URL, which must return 2xx and name the
 * deployed SHA in an `X-Commit` / `X-Version` header or in its body. A probe
 * that names no SHA is refused with the fix; a bare 2xx never stands in. The
 * deployed SHA must contain the task's implemented commits (ancestor or
 * patch-equivalent, the T13003 rule in `boundHeadGapReason`), which
 * `cleo complete` re-checks; the probe is not re-run.
 *
 * The atom satisfies only the gates the project lists in
 * `evidence.deploySatisfies`: there is no default mapping, and it never
 * stands for `testsPassed` unless the project lists it.
 *
 * @task T14083
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { EvidenceAtom, VerificationGate } from '@cleocode/contracts';
import { discoveryEnv } from '../git/work-tree.js';
import type { EvidenceRoots } from '../tasks/evidence.js';
import { isVerificationGate } from '../tasks/verification-policy.js';

/** A validated `deploy:` atom. */
export type DeployEvidenceAtom = Extract<EvidenceAtom, { kind: 'deploy' }>;

/** Default probe timeout, covering the request and the body read. */
export const DEPLOY_PROBE_TIMEOUT_MS = 10_000;

/** The most response body a probe reads (and hashes) before it stops. */
export const DEPLOY_PROBE_MAX_BODY_BYTES = 64 * 1024;

/** A refusal to accept a `deploy:` atom. */
interface DeployRefusal {
  ok: false;
  codeName: string;
  reason: string;
}

/** Probe tuning, for tests and slow hosts. */
export interface DeployProbeOptions {
  /** Abort the request and body read after this long (default {@link DEPLOY_PROBE_TIMEOUT_MS}). */
  timeoutMs?: number;
}

/**
 * The gates `evidence.deploySatisfies` lists (T14083): valid gate names only,
 * de-duplicated. Empty when the key is missing, not an array or names none.
 *
 * @param projectContext - Parsed `.cleo/project-context.json`, or `null`.
 * @returns The gates a probed deployment satisfies in this project.
 * @example
 * ```ts
 * readDeploySatisfies({ evidence: { deploySatisfies: ['documented'] } }); // ['documented']
 * ```
 */
export function readDeploySatisfies(
  projectContext: Record<string, unknown> | null,
): VerificationGate[] {
  const evidence = projectContext?.['evidence'];
  const listed =
    typeof evidence === 'object' && evidence !== null && 'deploySatisfies' in evidence
      ? evidence.deploySatisfies
      : undefined;
  if (!Array.isArray(listed)) return [];
  const gates = listed.filter(
    (g): g is VerificationGate => typeof g === 'string' && isVerificationGate(g),
  );
  return [...new Set(gates)];
}

/** Commit-like hex tokens in a header or body. */
function shaTokens(text: string): string[] {
  return (text.match(/\b[0-9a-f]{7,40}\b/gi) ?? []).map((t) => t.toLowerCase());
}

/** Read at most `max` bytes of a response body, then stop the stream. */
async function readBounded(response: Response, max: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).subarray(0, max);
}

/**
 * Probe a deployment (T14083): one bounded GET of `url` that must return 2xx
 * and name `sha` (full, or a 7+ character prefix of it) in an `X-Commit` or
 * `X-Version` header, else in the first {@link DEPLOY_PROBE_MAX_BODY_BYTES}
 * of its body. Refuses a timeout, an unreachable host, a non-2xx status, and
 * a response naming no SHA or another commit, each with the fix.
 *
 * @param url - The probe URL (`http://` or `https://`).
 * @param sha - The deployed commit's full SHA.
 * @param options - Probe tuning.
 * @returns The recorded probe, or the refusal.
 * @example
 * ```ts
 * const probe = await probeDeployment('https://api.example.com/health', fullSha);
 * if (probe.ok) console.log(probe.probe.shaSource);
 * ```
 */
export async function probeDeployment(
  url: string,
  sha: string,
  options: DeployProbeOptions = {},
): Promise<{ ok: true; probe: DeployEvidenceAtom['probe'] } | DeployRefusal> {
  const timeoutMs = options.timeoutMs ?? DEPLOY_PROBE_TIMEOUT_MS;
  const refuse = (reason: string): DeployRefusal => ({
    ok: false,
    codeName: 'E_EVIDENCE_INVALID',
    reason: `deploy probe ${url}: ${reason}`,
  });
  let response: Response;
  let body: Buffer;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    response = await fetch(url, { method: 'GET', redirect: 'follow', signal });
    body = await readBounded(response, DEPLOY_PROBE_MAX_BODY_BYTES);
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    // @sync-invariant none:input-shape an unreachable or slow probe is refused before anything is written
    return refuse(
      name === 'TimeoutError' || name === 'AbortError'
        ? `no complete response within ${timeoutMs} ms; the deployment is not proven live.`
        : `could not be reached (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  if (response.status < 200 || response.status > 299) {
    // @sync-invariant none:input-shape a probe that does not answer 2xx is refused before anything is written
    return refuse(`returned HTTP ${response.status}; a deploy probe must return 2xx.`);
  }
  const names = (text: string | null): boolean =>
    text !== null && shaTokens(text).some((t) => sha.startsWith(t));
  const sources = [
    ['x-commit', response.headers.get('x-commit')],
    ['x-version', response.headers.get('x-version')],
    ['body', body.toString('utf-8')],
  ] as const;
  const named = sources.find(([, text]) => names(text));
  if (!named) {
    const others = [...new Set(sources.flatMap(([, text]) => shaTokens(text ?? '')))];
    // @sync-invariant none:input-shape a probe that does not name the deployed SHA is refused before anything is written
    return refuse(
      others.length > 0
        ? `names ${others.slice(0, 3).join(', ')}, not the deployed commit ${sha.slice(0, 12)}: ` +
            'it serves another build. Probe the deployment of this commit.'
        : `returned ${response.status} but names no commit SHA, so it does not prove which build ` +
            `is live. Serve the deployed SHA in an X-Commit (or X-Version) response header, or in ` +
            `the body (e.g. {"commit":"${sha.slice(0, 12)}"}), and verify again.`,
    );
  }
  return {
    ok: true,
    probe: {
      status: response.status,
      probedAt: new Date().toISOString(),
      bodySha256: createHash('sha256').update(body).digest('hex'),
      shaSource: named[0],
    },
  };
}

/**
 * Validate a parsed `deploy:` atom (T14083): the project must list at least
 * one gate in `evidence.deploySatisfies`, git must know the deployed commit
 * (resolved to its full SHA), and the probe must pass
 * ({@link probeDeployment}). Containment of the task's implemented commits is
 * judged with the gate (`boundHeadGapReason`), at verify and at complete.
 *
 * @param parsed - The parsed atom.
 * @param roots - Store root (project context) and execution root (git).
 * @param opts - The parsed project context, the task id and probe tuning.
 * @returns The validated atom, or the refusal.
 * @example
 * ```ts
 * const r = await resolveDeployEvidenceAtom(parsed, roots, { projectContext, taskId: 'T1' });
 * ```
 */
export async function resolveDeployEvidenceAtom(
  parsed: { provider: string; deploymentId: string; sha: string; probeUrl: string },
  roots: EvidenceRoots,
  opts: {
    projectContext: Record<string, unknown> | null;
    taskId?: string;
    probe?: DeployProbeOptions;
  },
): Promise<{ ok: true; atom: DeployEvidenceAtom } | DeployRefusal> {
  const satisfiesGates = readDeploySatisfies(opts.projectContext);
  if (satisfiesGates.length === 0) {
    // @sync-invariant none:input-shape a deploy: atom in a project that maps it to no gate is refused before anything is written
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
      reason:
        'deploy: evidence satisfies no gate in this project: evidence.deploySatisfies lists none. ' +
        'There is no default mapping. List the gates a probed deployment proves in ' +
        '.cleo/project-context.json, e.g. "evidence": { "deploySatisfies": ["<gate>"] } ' +
        '(testsPassed only if a live deployment really is your test).',
    };
  }
  let headSha: string;
  try {
    headSha = execFileSync('git', ['rev-parse', '--verify', '--quiet', `${parsed.sha}^{commit}`], {
      cwd: roots.executionRoot,
      encoding: 'utf-8',
      env: discoveryEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // @sync-invariant none:input-shape a deployed commit git cannot read is refused before anything is written
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INVALID',
      reason:
        `deploy: commit ${parsed.sha} is not in ${roots.executionRoot}, so CLEO cannot check that it ` +
        "contains the task's work. Fetch it (git fetch origin) and verify again.",
    };
  }
  const probe = await probeDeployment(parsed.probeUrl, headSha, opts.probe);
  if (!probe.ok) return probe;
  return {
    ok: true,
    atom: {
      kind: 'deploy',
      provider: parsed.provider,
      deploymentId: parsed.deploymentId,
      headSha,
      probeUrl: parsed.probeUrl,
      probe: probe.probe,
      satisfiesGates,
      ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
    },
  };
}
