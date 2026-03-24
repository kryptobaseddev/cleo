/**
 * CAAMP Hooks Module
 *
 * Unified hook normalization layer that translates between
 * CAAMP canonical hook events and provider-native names.
 *
 * @packageDocumentation
 */

export type {
  CanonicalHookEvent,
  CanonicalEventDefinition,
  HookCategory,
  HookSystemType,
  HookHandlerType,
  HookMapping,
  ProviderHookProfile,
  NormalizedHookEvent,
  HookSupportResult,
  ProviderHookSummary,
  CrossProviderMatrix,
  HookMappingsFile,
} from "./types.js";

export {
  CANONICAL_HOOK_EVENTS,
  HOOK_CATEGORIES,
} from "./types.js";

export {
  // Core query
  getCanonicalEvent,
  getAllCanonicalEvents,
  getCanonicalEventsByCategory,
  getProviderHookProfile,
  getMappedProviderIds,

  // Normalization
  toNative,
  toCanonical,
  toNativeBatch,

  // Support queries
  supportsHook,
  getHookSupport,
  getSupportedEvents,
  getUnsupportedEvents,
  getProvidersForEvent,
  getCommonEvents,

  // Summary & matrix
  getProviderSummary,
  buildHookMatrix,
  getHookSystemType,
  getHookConfigPath,
  getProviderOnlyEvents,

  // Multi-provider
  translateToAll,
  resolveNativeEvent,
  getHookMappingsVersion,

  // Testing
  resetHookMappings,
} from "./normalizer.js";
