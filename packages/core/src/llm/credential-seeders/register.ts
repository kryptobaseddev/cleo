/**
 * Side-effect barrel that wires concrete credential seeders into the
 * `BUILTIN_SEEDERS` singleton (E-CONFIG-AUTH-UNIFY E2a / T9409).
 *
 * Importing this module once at any entry point triggers each concrete
 * seeder's module-load registration side effect:
 *
 * - `./env-seeder.ts` — registers one `EnvSeeder` per provider in
 *   `ENV_VARS`.
 *
 * Future tasks add more side-effect imports here (claude-code seeder,
 * cleo-pkce seeder, codex-cli seeder, gemini-cli seeder, gh-cli seeder).
 *
 * ## Why a separate barrel?
 *
 * Keeping the side-effect import out of `./index.ts` lets consumers pick
 * either the type-only surface (`import type { CredentialSeeder } from
 * './index.js'`) without paying the registration cost, OR the populated
 * registry (`import './register.js'; import { BUILTIN_SEEDERS } from
 * './index.js'`) when they actually need the seeders.
 *
 * The top-level `packages/core/src/llm/index.ts` re-exports `register.js`
 * so any consumer of `@cleocode/core/llm` automatically gets the populated
 * registry — see T9409's `llm/index.ts` patch.
 *
 * @module llm/credential-seeders/register
 * @task T9409
 */

// Side-effect import — pulls in env-seeder's module-load registration
// against `BUILTIN_SEEDERS`. The file exports the `EnvSeeder` class for
// direct construction; the registration happens during module evaluation.
import './env-seeder.js';
