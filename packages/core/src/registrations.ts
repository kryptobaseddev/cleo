/**
 * Every module-load registration CORE performs, without the rest of CORE.
 *
 * Loading the `@cleocode/core/internal` barrel defines ~1,100 modules, and a
 * few dozen of them also REGISTER something while they load: the lifecycle
 * hook handlers, the LLM credential seeders, the release invariants, the LLM
 * plugin engines, the sqlite warning filter. A CLI operation needs those
 * registrations in place before it runs; it does not need the other ~1,000
 * modules, which its own code imports when it uses them (T13126).
 *
 * This module imports exactly the modules whose evaluation registers
 * something, so loading it gives an operation the same registrations as the
 * barrel at a fraction of the load. `registrations.test.ts` scans the
 * barrel's module graph for top-level side effects and fails when one is not
 * reachable from here, so a new registration cannot silently go missing.
 *
 * @module
 * @task T13126
 */

import './lib/suppress-sqlite-warning.js';
import './hooks/handlers/index.js';
import './llm/credential-seeders/index.js';
import './llm/credential-seeders/register.js';
import './release/invariants/index.js';
import './store/sqlite-data-accessor.js';
import './store/exodus/abort-events.js';
