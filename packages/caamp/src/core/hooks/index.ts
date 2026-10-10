/**
 * CAAMP Hooks Module
 *
 * Unified hook normalization layer that translates between
 * CAAMP canonical hook events and provider-native names.
 *
 * @packageDocumentation
 */

export { GENERATED_PROVIDER_HOOK_PROFILES, PROVIDER_NATIVE_EVENT_MAPS } from './generated.js';
export {
  buildHookMatrix,
  getAllCanonicalEvents,
  // Core query
  getCanonicalEvent,
  getCanonicalEventsByCategory,
  getCommonEvents,
  getHookConfigPath,
  getHookMappingsVersion,
  getHookSupport,
  getHookSystemType,
  getMappedProviderIds,
  getProviderHookProfile,
  getProviderOnlyEvents,
  // Summary & matrix
  getProviderSummary,
  getProvidersForEvent,
  getSupportedEvents,
  getUnsupportedEvents,
  // Testing
  resetHookMappings,
  resolveNativeEvent,
  // Support queries
  supportsHook,
  toCanonical,
  // Normalization
  toNative,
  toNativeBatch,
  // Multi-provider
  translateToAll,
} from './normalizer.js';
export type {
  CanonicalEventDefinition,
  CanonicalHookEvent,
  CrossProviderMatrix,
  HookCategory,
  HookHandlerType,
  HookMapping,
  HookMappingsFile,
  HookSupportResult,
  HookSystemType,
  NormalizedHookEvent,
  ProviderHookProfile,
  ProviderHookSummary,
  ProviderProjectHookCapability,
} from './types.js';
export {
  CANONICAL_HOOK_EVENTS,
  HOOK_CATEGORIES,
} from './types.js';
