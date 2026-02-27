/**
 * Session type definitions for CLEO V2.
 *
 * All types are derived from the Drizzle schema via Zod transforms
 * in src/store/validation-schemas.ts. This file is a re-export barrel.
 *
 * @epic T4454
 */

// Domain types derived from Drizzle schema via Zod
export type {
  Session,
  SessionScope,
  SessionStats,
  SessionTaskWork,
} from '../store/validation-schemas.js';

// Status type from canonical registry
export type { SessionStatus } from '../store/status-registry.js';

// Collection wrapper
export { SessionView } from '../core/sessions/session-view.js';
