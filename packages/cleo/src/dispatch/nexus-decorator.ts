/**
 * nexus-decorator (thin re-export shim).
 *
 * The nexus meta decorator was relocated to `@cleocode/runtime/gateway`
 * (R3-K1 · T11455 · SG-RUNTIME-UNIFICATION) — it is a pure
 * `@cleocode/contracts`-only module, so hosting it in the runtime lets the
 * `nexus` domain handler import it from the runtime layer rather than a
 * cleo-internal path. This shim re-exports the full surface so the renderer /
 * CLI import sites that reference `'./nexus-decorator.js'` compile unchanged.
 *
 * @task T9146
 * @task T11455
 * @module dispatch/nexus-decorator
 */

export {
  buildNexusMetaExtensions,
  formatSuggestedNext,
  pickDecoratorMetaExtensions,
  stampNexusMeta,
  validateSuggestedNext,
} from '@cleocode/runtime/gateway';
