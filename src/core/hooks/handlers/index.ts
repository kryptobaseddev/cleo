/**
 * Hook Handlers Index - Phase 2D of T5237
 *
 * Barrel export for all hook handlers. Importing this module will
 * auto-register all handlers with the hook registry.
 */

// Import handlers to trigger auto-registration on module load
import './session-hooks.js';
import './task-hooks.js';
import './error-hooks.js';
import './file-hooks.js';
import './mcp-hooks.js';

export { handleError } from './error-hooks.js';
export { handleFileChange } from './file-hooks.js';
export { handlePromptSubmit, handleResponseComplete } from './mcp-hooks.js';
// Re-export handler functions for explicit use
export { handleSessionEnd, handleSessionStart } from './session-hooks.js';
export { handleToolComplete, handleToolStart } from './task-hooks.js';
