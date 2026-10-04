/**
 * `@cleocode/adapters/heavy-command-hook`: project-level delivery of CLEO's
 * heavy-command hook (T13124). A light entry point: `@cleocode/core` loads it
 * at run time for `cleo init`, `cleo upgrade`, `cleo doctor` and the session
 * briefing without pulling in every provider adapter.
 *
 * @packageDocumentation
 * @task T13124
 */

export type { HeavyHookDetection } from './providers/shared/heavy-command-hook-delivery.js';
export {
  detectHeavyHookProvider,
  HEAVY_HOOK_DELIVERY_PROVIDERS,
  HEAVY_HOOK_FIX_COMMAND,
  heavyHookDeliveryApi,
  heavyHookTarget,
  inspectProjectHeavyCommandHooks,
  probeHeavyHookCli,
  syncProjectHeavyCommandHooks,
} from './providers/shared/heavy-command-hook-delivery.js';
