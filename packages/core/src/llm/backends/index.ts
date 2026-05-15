/**
 * Backends barrel — DEPRECATED after T9286 (W1d).
 *
 * `MoonshotBackend` and `OpenAIBackend` have been removed. Constants
 * `MOONSHOT_BASE_URL`, `MOONSHOT_DEFAULT_MODEL`, and `isMoonshotModel` are
 * re-exported from their new canonical location for backward compatibility.
 *
 * `usesMaxCompletionTokens` is re-exported from `transports/openai.ts`.
 *
 * @deprecated Import directly from `provider-registry/builtin/moonshot.js`
 *   or `transports/openai.js`.
 * @task T9286 (W1d)
 */

export {
  isMoonshotModel,
  MOONSHOT_BASE_URL,
  MOONSHOT_DEFAULT_MODEL,
} from '../provider-registry/builtin/moonshot.js';

export { usesMaxCompletionTokens } from '../transports/openai.js';
