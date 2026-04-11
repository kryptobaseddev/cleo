/**
 * Registry module — project registration and cross-project coordination.
 *
 * ## Migration Note (T510)
 *
 * The registry implementation currently lives in `@cleocode/core` because it
 * depends heavily on core-internal modules:
 *
 * - `../errors.js` (CleoError)
 * - `../logger.js` (getLogger)
 * - `../paths.js` (getCleoHome)
 * - `../store/data-accessor.js` (getAccessor)
 * - `../store/nexus-schema.js` (Drizzle tables)
 * - `../store/nexus-sqlite.js` (getNexusDb)
 * - `../../config.js` (loadConfig — used by sharing module)
 *
 * Moving these files into `@cleocode/nexus` would either:
 *   a) Require duplicating core infrastructure, or
 *   b) Create a circular dependency: nexus → core → nexus
 *
 * The pragmatic resolution chosen for T510 is:
 *   - The code analysis subsystem (parser, outline, search, unfold) is fully
 *     self-contained and lives here in `@cleocode/nexus`.
 *   - The registry subsystem stays in `@cleocode/core/src/nexus/`.
 *   - `@cleocode/core` re-exports registry symbols from its own barrel.
 *   - Consumers that need registry symbols import from `@cleocode/core`.
 *   - Future work (separate epic) can extract the registry once core
 *     infrastructure is factored into smaller packages.
 *
 * @module registry
 */

// This module intentionally contains no runtime exports.
// Registry types and functions are exported from @cleocode/core.
//
// Example consumer pattern:
//   import { nexusRegister, nexusList } from '@cleocode/core';
//
// If registry functions are eventually extracted here, they will be
// added as named exports and the core barrel will re-export from here.
export {};
