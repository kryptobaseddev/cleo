/**
 * Provider SDK client registry — D-ph4-01 retired.
 *
 * All factory functions (`buildAnthropicSdkClient`, `clientForModelConfig`) and
 * per-provider client caches have been removed as part of the D-ph4-01
 * factory retirement (T9356). Transports construct their own SDK clients in
 * their constructors; `resolveLLMForRole` builds Anthropic clients directly.
 *
 * `historyAdapterForProvider` was relocated to `history-adapters.ts` (T9369).
 *
 * This file is intentionally empty after the retirement. It is retained so
 * that any future extension of the registry surface has a canonical home.
 *
 * @task T1392 (T1386-W6)
 * @task T9356 (D-ph4-01 factory retirement — final close)
 * @epic T1386
 */

// intentionally empty — all exports moved per D-ph4-01 retirement
export {};
