/**
 * Dependency-free leaf holding the implicit fallback model literal.
 *
 * Hoisted out of `./role-resolver.ts` (T11359 follow-up) to break a circular
 * import. `config.ts` reads {@link IMPLICIT_FALLBACK_MODEL} eagerly while
 * initializing its module-level `DEFAULTS` const, but `role-resolver.ts` pulls
 * a heavy runtime import chain (credentials / credentials-store / transports)
 * that participates in a cycle with `config.ts`. When the relocation in T11359
 * changed module-init order so `config.js` evaluated ahead of `role-resolver.js`
 * within that cycle, the eager read crashed with
 * `ReferenceError: Cannot access 'IMPLICIT_FALLBACK_MODEL' before initialization`
 * (a temporal-dead-zone error the type checker cannot catch — only the
 * Build & Verify runtime smoke does). A leaf module with ZERO local imports
 * always finishes initialization first, so `config.ts` can import the literal
 * directly and read it safely regardless of cycle order.
 *
 * The literal lives here (and ONLY under `packages/core/src/llm/`) so the T9255
 * grep guard stays clean. `role-resolver.ts` re-exports it for back-compat with
 * existing `from './role-resolver.js'` consumers.
 *
 * @task T9255
 * @task T11359
 */
export const IMPLICIT_FALLBACK_MODEL = 'claude-haiku-4-5-20251001';
