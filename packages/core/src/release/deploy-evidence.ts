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

/** A credential for a deployment provider's API: how to send it. */
export interface DeployCredential {
  /** The header to send it in. */
  header: 'Authorization' | 'Project-Access-Token';
  /** The header value. */
  value: string;
}

/** What a provider's API says about one deployment. */
export type DeployProviderVerdict =
  | { ok: true; status: string; commitSha: string }
  | { ok: false; reason: string };

/**
 * A deployment provider CLEO can ask about a deployment (T14091): whether it
 * exists, is the live one, and which commit it was built from.
 */
export interface DeployProviderAdapter {
  /** Provider name, as the `deploy:` atom spells it. */
  readonly name: string;
  /** The env vars the credential comes from, for the not-verified reason. */
  readonly credentialHint: string;
  /** The user's credential from the environment, read now and never stored, or null. */
  credential(env: NodeJS.ProcessEnv): DeployCredential | null;
  /** Ask the provider about a deployment. */
  verify(
    deploymentId: string,
    credential: DeployCredential,
    fetchImpl: typeof fetch,
  ): Promise<DeployProviderVerdict>;
}

/** Railway's public GraphQL API. */
const RAILWAY_GRAPHQL = 'https://backboard.railway.com/graphql/v2';

/** Run one Railway GraphQL query; the `data` object, or why not. */
async function railwayQuery(
  query: string,
  variables: Record<string, unknown>,
  credential: DeployCredential,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; reason: string }> {
  try {
    const response = await fetchImpl(RAILWAY_GRAPHQL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [credential.header]:
          credential.header === 'Authorization' ? `Bearer ${credential.value}` : credential.value,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(DEPLOY_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: `Railway API answered HTTP ${response.status}` };
    const body = (await response.json()) as {
      data?: Record<string, unknown> | null;
      errors?: Array<{ message?: string }>;
    };
    if (body.errors?.length)
      return { ok: false, reason: `Railway API: ${body.errors.map((e) => e.message).join('; ')}` };
    return { ok: true, data: body.data ?? {} };
  } catch (err) {
    return {
      ok: false,
      reason: `Railway API unreachable (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/**
 * Railway (T14091): the deployment must exist, have status `SUCCESS`, and be
 * the newest successful deployment of its service in its environment (the
 * live one); its commit is `meta.commitHash`. The credential comes from the
 * environment only: `RAILWAY_API_TOKEN` (an account token, sent as Bearer) or
 * `RAILWAY_TOKEN` (a project token, sent as `Project-Access-Token`). CLEO never
 * reads another tool's login file.
 */
export const railwayDeployAdapter: DeployProviderAdapter = {
  name: 'railway',
  credentialHint: 'RAILWAY_API_TOKEN/RAILWAY_TOKEN',
  credential(env) {
    const account = env['RAILWAY_API_TOKEN']?.trim();
    if (account) return { header: 'Authorization', value: account };
    const project = env['RAILWAY_TOKEN']?.trim();
    return project ? { header: 'Project-Access-Token', value: project } : null;
  },
  async verify(deploymentId, credential, fetchImpl) {
    const one = await railwayQuery(
      'query($id: String!) { deployment(id: $id) { id status meta serviceId environmentId } }',
      { id: deploymentId },
      credential,
      fetchImpl,
    );
    if (!one.ok) return one;
    const deployment = one.data['deployment'] as {
      status?: string;
      meta?: { commitHash?: unknown } | null;
      serviceId?: string;
      environmentId?: string;
    } | null;
    if (!deployment) return { ok: false, reason: `Railway has no deployment ${deploymentId}` };
    const status = deployment.status ?? 'UNKNOWN';
    const commitSha =
      typeof deployment.meta?.commitHash === 'string' ? deployment.meta.commitHash : '';
    if (status !== 'SUCCESS')
      return {
        ok: false,
        reason: `Railway deployment ${deploymentId} is ${status}, not live (SUCCESS)`,
      };
    const live = await railwayQuery(
      'query($s: String!, $e: String!) { deployments(first: 1, input: { serviceId: $s, environmentId: $e, status: { in: [SUCCESS] } }) { edges { node { id } } } }',
      { s: deployment.serviceId, e: deployment.environmentId },
      credential,
      fetchImpl,
    );
    if (!live.ok) return live;
    const edges = (live.data['deployments'] as { edges?: Array<{ node?: { id?: string } }> } | null)
      ?.edges;
    const liveId = edges?.[0]?.node?.id;
    if (liveId !== deploymentId)
      return {
        ok: false,
        reason: `Railway deployment ${deploymentId} succeeded but is not the live one (the live deployment is ${liveId ?? 'unknown'})`,
      };
    return { ok: true, status, commitSha };
  },
};

/** The providers CLEO can ask about a deployment, by atom provider name (T14091). */
export const DEPLOY_PROVIDER_ADAPTERS: Readonly<Record<string, DeployProviderAdapter>> = {
  railway: railwayDeployAdapter,
};

/** Seams for the provider check (tests). */
export interface DeployProviderCheckOptions {
  /** Adapters by provider name (default {@link DEPLOY_PROVIDER_ADAPTERS}). */
  adapters?: Readonly<Record<string, DeployProviderAdapter>>;
  /** Environment the credential is read from (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** The fetch the adapter uses (default `fetch`). */
  fetch?: typeof fetch;
}

/** Whether two commit SHAs name the same commit (one a 7+ character prefix of the other). */
function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

/**
 * Ask the deployment's provider about it (T14091). With an adapter and the
 * user's credential: refuse a deployment that does not exist, is not live, or
 * was built from another commit than `headSha` (an exact match), naming the
 * deployment id and both commits; otherwise record it verified. With no
 * adapter or no credential the probe alone stands, recorded as not verified
 * with why. The credential is read now and never stored.
 *
 * @param provider - The atom's provider.
 * @param deploymentId - The atom's deployment id.
 * @param headSha - The deployed commit (full SHA).
 * @param options - Test seams.
 * @returns The provider check for the atom, or the refusal.
 */
export async function checkDeployWithProvider(
  provider: string,
  deploymentId: string,
  headSha: string,
  options: DeployProviderCheckOptions = {},
): Promise<{ ok: true; check: NonNullable<DeployEvidenceAtom['providerCheck']> } | DeployRefusal> {
  const adapter = (options.adapters ?? DEPLOY_PROVIDER_ADAPTERS)[provider];
  if (!adapter)
    return {
      ok: true,
      check: {
        verified: false,
        reason: `no adapter for ${provider}: the deployment id ${deploymentId} was not checked with the provider; the probe alone stands`,
      },
    };
  const credential = adapter.credential(options.env ?? process.env);
  if (credential === null)
    return {
      ok: true,
      check: {
        verified: false,
        reason: `no ${adapter.credentialHint}: the deployment id ${deploymentId} was not checked with ${provider}; the probe alone stands`,
      },
    };
  const verdict = await adapter.verify(deploymentId, credential, options.fetch ?? fetch);
  if (!verdict.ok)
    // @sync-invariant none:input-shape a deployment its provider does not confirm live is refused before anything is written
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INVALID',
      reason: `deploy: ${verdict.reason}; the atom names commit ${headSha.slice(0, 12)}.`,
    };
  if (!sameCommit(verdict.commitSha, headSha))
    // @sync-invariant none:input-shape a deployment built from another commit is refused before anything is written
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INVALID',
      reason:
        `deploy: ${provider} deployment ${deploymentId} was built from ${verdict.commitSha.slice(0, 12) || 'an unknown commit'}, ` +
        `not ${headSha.slice(0, 12)} as the atom says. Name the deployment of ${headSha.slice(0, 12)}, or deploy it.`,
    };
  return {
    ok: true,
    check: {
      verified: true,
      status: verdict.status,
      commitSha: verdict.commitSha,
      checkedAt: new Date().toISOString(),
    },
  };
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

/**
 * Whether a probe URL's path or query names the deployed commit (any 7+
 * character prefix, case-insensitive): an echoing endpoint would then "name"
 * the SHA the agent wrote, proving nothing (review of #2538).
 */
function urlNamesSha(url: string, sha: string): boolean {
  let tail: string;
  try {
    const parsed = new URL(url);
    tail = `${parsed.pathname}${parsed.search}`;
  } catch {
    tail = url;
  }
  let decoded = tail;
  try {
    decoded = decodeURIComponent(tail);
  } catch {
    // A malformed escape: judge the raw text.
  }
  return decoded.toLowerCase().includes(sha.slice(0, 7).toLowerCase());
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
 * of its body. Refuses a URL whose path or query names the SHA (an echoing
 * endpoint would prove nothing), a timeout, an unreachable host, a non-2xx
 * status, and a response naming no SHA or another commit, each with the fix.
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
  if (urlNamesSha(url, sha)) {
    // @sync-invariant none:input-shape a probe URL that carries the deployed SHA is refused before anything is written
    return refuse(
      `its URL carries the deployed commit (${sha.slice(0, 7)}…) in its path or query, so an ` +
        'endpoint that echoes its request would name the SHA without proving which build is ' +
        'live. Probe an endpoint whose URL does not name the commit (e.g. /health) and that ' +
        'reports the SHA itself.',
    );
  }
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
    provider?: DeployProviderCheckOptions;
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
  // T14091: the provider's own word, when CLEO can ask it.
  const checked = await checkDeployWithProvider(
    parsed.provider,
    parsed.deploymentId,
    headSha,
    opts.provider,
  );
  if (!checked.ok) return checked;
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
      providerCheck: checked.check,
      ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
    },
  };
}
