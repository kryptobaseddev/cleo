/**
 * Fix-generation stage for the self-improvement loop (T11889 · T11975).
 *
 * This is the missing autonomous link the v1 loop explicitly stubbed out
 * ("NO autonomous fix-gen in v1", see {@link "./run-loop.js"}): given a detected
 * regression (an open `selfimprove_dhq` + its envelope-diff) plus minimal repo
 * context, it asks the LLM to PROPOSE a unified-diff patch and writes that patch
 * to the path the draft-PR egress ({@link "./draft-pr.js".openDraftPr}) already
 * `existsSync`-checks: `<cwd>/selfimprove-<scenario>.patch`. Once the patch is on
 * disk the existing egress guard opens ONE DRAFT PR — closing the
 * DHQ → fix → draft-PR pipeline end-to-end.
 *
 * ## Hard safety posture (unchanged from v1 — P5 spec §B.7)
 *
 *   - **LLM ONLY via the E9 chokepoint.** The real generator
 *     ({@link createLlmFixGenerator}) resolves its model strictly through
 *     {@link "../llm/system-resolver.js".resolveLLMForSystem} → {@link ModelRunner}
 *     (Gate-13). It constructs NO raw provider client, reads NO `*_API_KEY` env,
 *     and hardcodes no model id — the resolver/registry is the SSoT. The
 *     plaintext token is materialized only at the wire boundary (E10).
 *   - **Draft-PR-ONLY, never auto-merge.** This module produces a PATCH FILE only;
 *     the egress that consumes it always opens a `--draft` PR against a feature
 *     branch (never `main`). This module performs NO git/gh action.
 *   - **Graceful degrade, never a rogue mutation.** Every failure (no credential,
 *     LLM error, empty / non-unified-diff output) returns a typed
 *     {@link FixGenResult} of kind `'skipped'` and writes NO patch file — so the
 *     existing egress guard (`existsSync` on the patch path) simply skips the PR.
 *     This function NEVER throws.
 *   - **Injectable seam.** The LLM dependency is the {@link FixGenerator} port;
 *     unit tests inject a deterministic fake that returns a canned patch, so NO
 *     real LLM is reached in tests.
 *
 * CORE-first: this engine lives in `core` and owns the `FixGenerator` port TYPE.
 * Import-time side-effect-free.
 *
 * @module @cleocode/core/selfimprove/fix-gen
 * @epic T11889
 * @task T11975
 */

import { writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { cwd as processCwd } from 'node:process';
import type { Logger } from 'pino';
import type { DiffEntry } from './envelope-diff.js';

/**
 * The E9 system-of-use label the fix-generator resolves its model under. Maps to
 * the `judgement` role (see `SYSTEM_ROLE_MAP`) — the closest standing role for
 * "reason about a regression and propose a code change".
 */
const FIXGEN_SYSTEM = 'task-executor' as const;

/** A leading marker every unified-diff hunk header / file header carries. */
const UNIFIED_DIFF_MARKERS = ['diff --git ', '--- ', '+++ ', '@@ '] as const;

/**
 * The structured request handed to a {@link FixGenerator}. Carries only what the
 * generator needs to draft a patch: the DHQ identity, the scenario, the
 * regression diff, and a minimal slice of repo context.
 */
export interface FixGenRequest {
  /** The stable `'DHQ-###'` handle of the open regression. */
  readonly dhqId: string;
  /** The scenario whose replay diverged from the golden. */
  readonly scenario: string;
  /** The idempotency hash tying this request to ONE open DHQ row. */
  readonly questionHash: string;
  /** The structured regression entries (the evidence) from the envelope diff. */
  readonly regressions: readonly DiffEntry[];
  /**
   * Minimal repo context the generator may use to ground the patch (e.g. the
   * project root, a short description). Kept small on purpose — the loop does NOT
   * stuff the whole repo into the prompt.
   */
  readonly repoContext: FixGenRepoContext;
}

/** Minimal repo context grounding a fix-generation request. */
export interface FixGenRepoContext {
  /** Absolute project root the patch is generated against. */
  readonly projectRoot: string;
  /** Optional one-line summary of what the scenario exercises. */
  readonly summary?: string;
}

/** A generated patch, or an explicit "no usable patch" signal. */
export type FixGenOutput =
  | {
      /** The generator produced a candidate unified-diff patch. */
      readonly kind: 'patch';
      /** The raw unified-diff text (validated by {@link generateFixPatch}). */
      readonly diff: string;
      /** The model id that produced it (for audit). */
      readonly model: string;
    }
  | {
      /** The generator produced no usable patch (degrade — never an error throw). */
      readonly kind: 'none';
      /** Machine-stable reason for the absence. */
      readonly reason: string;
    };

/**
 * The injectable fix-generation port (the LLM seam).
 *
 * The real implementation ({@link createLlmFixGenerator}) drives the E9 chokepoint;
 * tests inject a deterministic fake returning a canned patch. A `FixGenerator`
 * MUST NOT throw — it encodes "no patch" as `{ kind: 'none', reason }`.
 */
export interface FixGenerator {
  /**
   * Propose a unified-diff patch for one regression.
   *
   * @param request - The structured {@link FixGenRequest}.
   * @returns A {@link FixGenOutput} — a candidate patch or an explicit "none".
   */
  propose(request: FixGenRequest): Promise<FixGenOutput>;
}

/** The terminal outcome of {@link generateFixPatch}. */
export type FixGenResult =
  | {
      /** A validated patch was written to {@link FixGenResultWritten.patchPath}. */
      readonly kind: 'written';
      /** Absolute path the patch was written to. */
      readonly patchPath: string;
      /** Byte length of the written patch. */
      readonly bytes: number;
      /** The model id that produced the patch. */
      readonly model: string;
    }
  | {
      /** No patch was written; the egress guard will skip the PR. */
      readonly kind: 'skipped';
      /** Machine-stable reason recorded on the DHQ evidence. */
      readonly reason: string;
    };

/**
 * Options for {@link generateFixPatch}.
 */
export interface GenerateFixPatchOptions {
  /** The structured fix-generation request. */
  readonly request: FixGenRequest;
  /** The injected generator (real LLM impl or a test fake). */
  readonly generator: FixGenerator;
  /**
   * Working directory the patch path is resolved against — MUST match the `cwd`
   * the downstream {@link "./draft-pr.js".openDraftPr} uses, so the file it writes
   * is the file the egress finds.
   */
  readonly cwd?: string;
  /** Injectable logger (defaults to the module logger). */
  readonly logger?: Logger;
}

/**
 * Compute the patch path the draft-PR egress expects for a scenario:
 * `<cwd>/selfimprove-<scenario>.patch`. The scenario is sanitized to a safe file
 * stem so a hostile scenario name cannot escape the cwd.
 *
 * @param scenario - The scenario name.
 * @param cwd - The working directory to resolve against (defaults to `process.cwd`).
 * @returns The absolute patch path.
 */
export function fixPatchPath(scenario: string, cwd?: string): string {
  const safeScenario = scenario.replace(/[^a-z0-9-]/gi, '-');
  return resolvePath(cwd ?? processCwd(), `selfimprove-${safeScenario}.patch`);
}

/**
 * Is `text` a plausible unified diff?
 *
 * A real `git apply`-able patch always carries at least one of the canonical
 * unified-diff markers ({@link UNIFIED_DIFF_MARKERS}). An LLM that returns prose,
 * an apology, or an empty string fails this guard, so the loop degrades to "no
 * patch" rather than writing junk the egress would then fail to `git apply`.
 *
 * This is a cheap structural sniff, NOT a full parse — the authoritative
 * applicability check is `git apply` inside the egress (which fails the PR cut on
 * a bad patch, never `main`).
 *
 * @param text - Candidate patch text.
 * @returns `true` when the text looks like a unified diff.
 */
export function looksLikeUnifiedDiff(text: string): boolean {
  if (text.trim().length === 0) return false;
  return UNIFIED_DIFF_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Build the system + user prompt the real generator sends to the LLM. Pure
 * (no IO) so it is unit-testable in isolation. The prompt is deliberately strict:
 * "respond with ONLY a unified diff" — anything else fails
 * {@link looksLikeUnifiedDiff} downstream and degrades to "no patch".
 *
 * @param request - The fix-generation request.
 * @returns The `{ system, user }` prompt pair.
 */
export function buildFixGenPrompt(request: FixGenRequest): { system: string; user: string } {
  const system =
    'You are an autonomous software-maintenance agent. You are given a detected ' +
    'regression in a TypeScript monorepo (a divergence between a replayed scenario ' +
    'and its golden expected output). Produce a MINIMAL fix as a single unified diff ' +
    '(`git diff` format, with `diff --git`, `---`, `+++`, and `@@` hunk headers). ' +
    'Respond with ONLY the unified diff and NOTHING else — no prose, no code fences, ' +
    'no explanation. If you cannot propose a safe fix, respond with the single token ' +
    'NO_PATCH.';
  const lines = request.regressions.map(
    (r) =>
      `- op ${r.opCoord} (#${r.opIndex}) at path \`${r.path}\`: ` +
      `actual=${JSON.stringify(r.actual)} expected=${JSON.stringify(r.expected)}`,
  );
  const user =
    `Regression ${request.dhqId} in scenario \`${request.scenario}\` ` +
    `(${request.regressions.length} diverging path(s)).\n` +
    (request.repoContext.summary ? `Scenario summary: ${request.repoContext.summary}\n` : '') +
    `Project root: ${request.repoContext.projectRoot}\n\n` +
    `Diverging paths:\n${lines.join('\n')}\n\n` +
    'Produce the unified diff that resolves these divergences.';
  return { system, user };
}

/**
 * Lazily-resolved module logger (import-time side-effect-free).
 */
let cachedLogger: Logger | undefined;
async function getModuleLogger(): Promise<Logger> {
  if (cachedLogger === undefined) {
    const { getLogger } = await import('../logger.js');
    cachedLogger = getLogger('selfimprove-fix-gen');
  }
  return cachedLogger;
}

/**
 * Run the fix-generation stage: ask the injected {@link FixGenerator} for a patch,
 * validate it as a unified diff, and write it to the egress-expected patch path.
 *
 * This function NEVER throws and NEVER mutates anything but the single patch file.
 * On ANY degrade path — generator returns `'none'`, the generator throws, or the
 * returned text is not a unified diff — it writes NO file and returns
 * `{ kind: 'skipped', reason }`, so the downstream `existsSync` egress guard
 * simply skips the PR. The caller records the `reason` on the DHQ evidence.
 *
 * @param opts - See {@link GenerateFixPatchOptions}.
 * @returns A {@link FixGenResult}.
 *
 * @example
 * ```ts
 * const res = await generateFixPatch({
 *   request: { dhqId: 'DHQ-abcd1234', scenario, questionHash, regressions, repoContext },
 *   generator: createLlmFixGenerator(),
 *   cwd: projectRoot,
 * });
 * if (res.kind === 'written') { // openDraftPr will now find selfimprove-<scenario>.patch }
 * ```
 */
export async function generateFixPatch(opts: GenerateFixPatchOptions): Promise<FixGenResult> {
  const logger = opts.logger ?? (await getModuleLogger());
  const { request, generator } = opts;
  const patchPath = fixPatchPath(request.scenario, opts.cwd);

  let output: FixGenOutput;
  try {
    output = await generator.propose(request);
  } catch (err) {
    const reason = `fixgen-threw:${err instanceof Error ? err.message : String(err)}`;
    logger.warn({ dhqId: request.dhqId, scenario: request.scenario, reason }, 'fix-gen degraded');
    return { kind: 'skipped', reason };
  }

  if (output.kind === 'none') {
    logger.info(
      { dhqId: request.dhqId, scenario: request.scenario, reason: output.reason },
      'fix-gen produced no patch (graceful skip — no PR)',
    );
    return { kind: 'skipped', reason: `fixgen-none:${output.reason}` };
  }

  if (!looksLikeUnifiedDiff(output.diff)) {
    logger.warn(
      { dhqId: request.dhqId, scenario: request.scenario },
      'fix-gen output is not a unified diff (graceful skip — no PR)',
    );
    return { kind: 'skipped', reason: 'fixgen-not-a-diff' };
  }

  // Normalize a trailing newline so `git apply` accepts the hunk.
  const diff = output.diff.endsWith('\n') ? output.diff : `${output.diff}\n`;
  writeFileSync(patchPath, diff, 'utf8');
  const bytes = Buffer.byteLength(diff, 'utf8');
  logger.info(
    { dhqId: request.dhqId, scenario: request.scenario, patchPath, bytes, model: output.model },
    'fix-gen wrote candidate patch — egress will open a DRAFT PR',
  );
  return { kind: 'written', patchPath, bytes, model: output.model };
}

/**
 * Construct the REAL fix generator — the one that drives the E9 LLM chokepoint.
 *
 * Resolution funnels through {@link resolveLLMForSystem}(`'task-executor'`) →
 * {@link ModelRunner.build} → `session.send` (ONE non-streaming completion).
 * It constructs NO raw provider client, reads NO API-key env, and hardcodes no
 * model id (Gate-13). The plaintext credential is materialized ONLY at the
 * `ModelRunner` wire boundary (E10) via the sealed handle. When no credential is
 * reachable it returns `{ kind: 'none' }` — the loop degrades to "no patch", no
 * PR. This function constructs nothing at call time (lazy dynamic imports keep the
 * module import-time side-effect-free + the E9 deps off the hot import path).
 *
 * @param opts - Optional project root threaded into the resolver.
 * @returns A {@link FixGenerator} backed by the E9 chokepoint.
 *
 * @example
 * ```ts
 * const gen = createLlmFixGenerator({ projectRoot });
 * const out = await gen.propose(request); // resolves model via E9, never raw client
 * ```
 */
export function createLlmFixGenerator(opts: { projectRoot?: string } = {}): FixGenerator {
  return {
    async propose(request: FixGenRequest): Promise<FixGenOutput> {
      const logger = await getModuleLogger();
      // Lazy imports: keep E9 deps off the module import path + side-effect-free.
      const { resolveLLMForSystem } = await import('../llm/system-resolver.js');
      const { ModelRunner } = await import('../llm/model-runner.js');

      // 1. E9 resolution chokepoint. Never throws (resolver contract).
      const projectRoot = opts.projectRoot ?? request.repoContext.projectRoot;
      const resolved = await resolveLLMForSystem(FIXGEN_SYSTEM, { projectRoot });
      if (!resolved.sealedCredential && resolved.authType !== 'aws_sdk') {
        return { kind: 'none', reason: 'no-credential-resolved' };
      }

      // 2. Materialize the plaintext ONLY at the wire boundary (E10), build a
      //    clean descriptor, and construct the transport inside ModelRunner.
      const apiKey = resolved.sealedCredential
        ? (await resolved.sealedCredential.fetch()).value
        : null;
      const built = await ModelRunner.build({
        provider: resolved.provider,
        model: resolved.model,
        credential: resolved.credential
          ? {
              provider: resolved.credential.provider,
              apiKey,
              source: resolved.credential.source,
              authType: resolved.credential.authType,
            }
          : null,
        source: resolved.source,
        ...(resolved.credentialLabel !== undefined
          ? { credentialLabel: resolved.credentialLabel }
          : {}),
        apiMode: resolved.apiMode,
        baseUrl: resolved.baseUrl,
        authType: resolved.authType,
        ...(resolved.capabilities !== undefined ? { capabilities: resolved.capabilities } : {}),
      });

      // 3. ONE non-streaming completion. The system prompt is threaded onto the
      //    request via `systemSuffix` (ConcreteSession maps it to
      //    `TransportRequest.system`); the user turn carries the regression detail.
      const { system, user } = buildFixGenPrompt(request);
      try {
        const response = await built.session.send([{ role: 'user', content: user }], {
          systemSuffix: system,
        });
        const text = (response.content ?? '').trim();
        if (text.length === 0 || text === 'NO_PATCH') {
          return { kind: 'none', reason: 'model-declined' };
        }
        return { kind: 'patch', diff: stripCodeFences(text), model: response.model };
      } catch (err) {
        logger.warn(
          { system: FIXGEN_SYSTEM, err: err instanceof Error ? err.message : String(err) },
          'fix-gen LLM call failed — degrading to no-patch',
        );
        return { kind: 'none', reason: 'llm-call-failed' };
      }
    },
  };
}

/**
 * Strip a single surrounding markdown code fence (```diff … ```), if present, so a
 * model that wraps its diff still yields an applyable patch. A bare diff passes
 * through untouched.
 *
 * @param text - Candidate patch text (already trimmed).
 * @returns The fence-stripped text.
 */
export function stripCodeFences(text: string): string {
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i;
  const m = text.match(fence);
  return m?.[1] !== undefined ? m[1].trim() : text;
}
