/**
 * Hook Handlers Index - Phase 2D of T5237
 *
 * Barrel export for all hook handlers. Importing this module will
 * auto-register all handlers with the hook registry.
 */

// Import handlers to trigger auto-registration on module load
import './session-hooks.js';
import './task-hooks.js';

// Re-export handler functions for explicit use
export { handleSessionStart, handleSessionEnd } from './session-hooks.js';
export { handleToolStart, handleToolComplete } from './task-hooks.js';
