/**
 * Cantbook stage LLM-profile resolution (T11759 · M4 cantbook done-gate).
 *
 * A `.cantbook` agentic stage can pin its LLM via `profile:` (a named
 * `llm.profiles` entry), or the inline `model:` / `provider:` escape hatch
 * ({@link PlaybookAgenticNode}). This module is the single seam the two
 * production cantbook dispatchers (`buildDefaultDispatcher` in `playbook.ts` and
 * `buildGoDispatcher` in `go-ivtr-runner.ts`) call to turn that declaration into
 * a RESOLUTION through the E9 chokepoint.
 *
 * ## Gate-13 compliance (no transport construction here)
 *
 * This helper ONLY calls {@link resolveLLMForSystem} — the single E9 resolution
 * chokepoint. It NEVER constructs a transport, an AI-SDK client, or reads a
 * credential off the wire; the returned {@link ResolvedLLMForSystem} carries the
 * provider/model/sealed-credential METADATA only. The Pi runner / model-runner
 * downstream is the sole place a client is built. Passing a resolution hint (the
 * profile + the cantbook system key) is exactly the Gate-13-allowed seam.
 *
 * ## How the cantbook node keys the resolver
 *
 * The node identity is encoded as the OPEN-axis system-of-use key
 * `cantbook:<playbook>#<nodeId>` (via {@link formatSystemKey}), and threaded as
 * `resolveLLMForSystem`'s `systemKey` option so it drives the
 * `llm.systems[key]` granular-override tier + audit identity. The flat `system`
 * argument stays the resolvable `'task-executor'` background label (the same one
 * the Pi runner uses), and the node's `profile:` flows through `opts.profile` as
 * the highest-priority pin. When the node declares neither `profile` nor
 * `model`/`provider`, callers should skip this helper — the resolution is
 * unchanged.
 *
 * @module playbooks/cantbook-profile
 * @task T11759
 * @epic T10403
 */

import type { ResolveLLMForSystemOptions, SystemOfUseLabel } from '@cleocode/contracts';
import { formatSystemKey } from '../llm/system-key.js';
import { type ResolvedLLMForSystem, resolveLLMForSystem } from '../llm/system-resolver.js';

/**
 * The flat background {@link SystemOfUseLabel} a cantbook stage resolves its LLM
 * through. Mirrors the Pi runner's default (`'task-executor'`) so a stage with
 * NO profile pin resolves to the same background lane the runner already uses.
 */
const CANTBOOK_BASE_SYSTEM: SystemOfUseLabel = 'task-executor';

/** The per-stage LLM pin a `.cantbook` agentic node may declare (T11759). */
export interface CantbookProfilePin {
  /** Named `llm.profiles` profile to pin (highest priority when resolvable). */
  readonly profile?: string;
  /** Inline model id escape hatch (resolution hint only — no transport built). */
  readonly model?: string;
  /** Inline provider transport escape hatch (resolution hint only). */
  readonly provider?: string;
}

/** Inputs to {@link resolveCantbookNodeProfile}. */
export interface ResolveCantbookNodeProfileInput {
  /** The playbook (`.cantbook`) name — the first segment of the node identity. */
  readonly playbookName: string;
  /** The agentic node id — the second segment of the node identity. */
  readonly nodeId: string;
  /** The node's declared LLM pin (`profile` / `model` / `provider`). */
  readonly pin: CantbookProfilePin;
  /** Project root for config + credential resolution (defaults to cwd inside E9). */
  readonly projectRoot?: string;
}

/**
 * Build the canonical OPEN-axis system-of-use key for a cantbook node
 * (`cantbook:<playbook>#<nodeId>`).
 *
 * Exported so the dispatchers + tests assert the exact key the resolver is
 * threaded with WITHOUT re-implementing the encoding.
 *
 * @param playbookName - The `.cantbook` name.
 * @param nodeId - The agentic node id.
 * @returns The encoded `cantbook:<playbook>#<nodeId>` key.
 * @task T11759
 */
export function cantbookNodeSystemKey(playbookName: string, nodeId: string): string {
  return formatSystemKey({ kind: 'cantbook-node', id: `${playbookName}#${nodeId}` });
}

/**
 * `true` when a node's pin actually declares an LLM override (so the dispatcher
 * should resolve via {@link resolveCantbookNodeProfile}); `false` when it is the
 * empty/unset pin and the default resolution path applies unchanged.
 *
 * @param pin - The node's declared pin (may be all-undefined).
 * @returns Whether any of `profile` / `model` / `provider` is set.
 * @task T11759
 */
export function hasCantbookProfilePin(pin: CantbookProfilePin): boolean {
  return pin.profile !== undefined || pin.model !== undefined || pin.provider !== undefined;
}

/**
 * Resolve a cantbook stage's pinned LLM through the E9 chokepoint
 * ({@link resolveLLMForSystem}).
 *
 * Threads the node identity as the `cantbook:<playbook>#<nodeId>` system key and
 * the node's `profile:` as the highest-priority pin. Inline `model:` / `provider:`
 * are NOT consumed by the resolver tiers directly (those are not config keys) —
 * they ride back on the returned envelope as the caller-supplied hint so the
 * dispatcher can surface them to the spawn / model-runner boundary. This function
 * NEVER constructs a transport (Gate-13): it only resolves metadata.
 *
 * @param input - Playbook name + node id + the declared pin + project root.
 * @returns The {@link ResolvedLLMForSystem} envelope (metadata only; never throws).
 * @task T11759
 */
export async function resolveCantbookNodeProfile(
  input: ResolveCantbookNodeProfileInput,
): Promise<ResolvedLLMForSystem> {
  const systemKey = cantbookNodeSystemKey(input.playbookName, input.nodeId);
  const opts: ResolveLLMForSystemOptions = { systemKey };
  if (input.projectRoot !== undefined) opts.projectRoot = input.projectRoot;
  if (input.pin.profile !== undefined) opts.profile = input.pin.profile;
  // `resolveLLMForSystem` is the single E9 chokepoint — it owns config tiers,
  // CredentialPool binding, and the sealed-handle. No client is built here.
  return resolveLLMForSystem(CANTBOOK_BASE_SYSTEM, opts);
}
