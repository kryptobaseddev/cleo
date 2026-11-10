/**
 * Lead tool strip — the spawn-time guard of the lead/worker split (epic T14351).
 *
 * A lead spawn carries {@link SpawnContext.leadDeniedTools}. A provider that
 * can remove those tools from the spawned agent declares
 * `leadToolStrip: 'enforced'` and strips them; every other provider is
 * `'unsupported'` (also the meaning of an absent declaration), and a lead
 * spawn there is refused with `E_LEAD_TOOLS_UNSTRIPPED` before anything runs.
 * Worker spawns carry no denied tools and pass through unchanged.
 *
 * @task T14357
 * @epic T14351
 */

import type { LeadDeniedTool, LeadToolStripSupport, SpawnContext } from '@cleocode/contracts';
import { E_LEAD_TOOLS_UNSTRIPPED, ExitCode } from '@cleocode/contracts';

/**
 * Thrown when a lead spawn reaches a provider that cannot strip the lead's
 * denied tools. Exit code aligns with {@link ExitCode.SPAWN_VALIDATION_FAILED} (63).
 *
 * @task T14357
 */
export class LeadToolsUnstrippedError extends Error {
  /** Stable LAFS error code string for envelope emission. */
  readonly code = E_LEAD_TOOLS_UNSTRIPPED;
  /** Numeric exit code aligned with {@link ExitCode.SPAWN_VALIDATION_FAILED} (63). */
  readonly exitCode: ExitCode = ExitCode.SPAWN_VALIDATION_FAILED;

  /**
   * @param providerId - Provider that refused the lead spawn.
   * @param deniedTools - Tools the lead had to lose.
   */
  constructor(
    public readonly providerId: string,
    public readonly deniedTools: readonly LeadDeniedTool[],
  ) {
    super(
      `${E_LEAD_TOOLS_UNSTRIPPED}: provider '${providerId}' cannot strip the lead's denied ` +
        `tools [${deniedTools.join(', ')}]. Spawn the lead on a provider that enforces the ` +
        `strip (claude-code, claude-sdk) or turn off orchestrate.leadWorker.v1.`,
    );
    this.name = 'LeadToolsUnstrippedError';
  }
}

/**
 * Denied tools of a lead spawn, or `null` for a worker spawn.
 *
 * @param context - Spawn context.
 * @returns The non-empty denied-tool list, or `null` when the spawn is not a lead spawn.
 */
export function leadDeniedTools(context: SpawnContext): readonly LeadDeniedTool[] | null {
  const denied = context.leadDeniedTools;
  return denied !== undefined && denied.length > 0 ? denied : null;
}

/**
 * Refuse a lead spawn on a provider that cannot strip its denied tools.
 * No-op for worker spawns and for providers that enforce the strip.
 *
 * @param providerId - Provider performing the spawn.
 * @param support - The provider's strip capability.
 * @param context - Spawn context.
 * @throws {LeadToolsUnstrippedError} When the spawn is a lead spawn and `support` is `'unsupported'`.
 */
export function assertLeadToolsStrippable(
  providerId: string,
  support: LeadToolStripSupport,
  context: SpawnContext,
): void {
  const denied = leadDeniedTools(context);
  if (denied !== null && support !== 'enforced') {
    throw new LeadToolsUnstrippedError(providerId, denied);
  }
}
