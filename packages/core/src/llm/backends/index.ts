/**
 * Backends barrel — provider backend implementations.
 *
 * AnthropicBackend has been migrated to transports/anthropic.ts (T9285 W1c).
 *
 * @task T1386
 */

export {
  isMoonshotModel,
  MOONSHOT_BASE_URL,
  MOONSHOT_DEFAULT_MODEL,
  MoonshotBackend,
} from './moonshot.js';
