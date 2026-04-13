/**
 * Hook Handlers Index - Phase 2D of T5237
 *
 * Barrel export for all hook handlers. Importing this module will
 * auto-register all handlers with the hook registry.
 *
 * @task T166
 * @epic T134
 */

// Import handlers to trigger auto-registration on module load
import './session-hooks.js';
import './task-hooks.js';
import './error-hooks.js';
import './file-hooks.js';
import './notification-hooks.js';
import './work-capture-hooks.js';
import './agent-hooks.js';
import './context-hooks.js';
import './watchdog-hooks.js';

export { handleSubagentStart, handleSubagentStop } from './agent-hooks.js';
export { handlePostCompact, handlePreCompact } from './context-hooks.js';
export { handleError } from './error-hooks.js';
export { handleFileChange } from './file-hooks.js';
export { handleSystemNotification } from './notification-hooks.js';
// Re-export handler functions for explicit use
export { handleSessionEnd, handleSessionStart } from './session-hooks.js';
export { handleToolComplete, handleToolStart } from './task-hooks.js';
export { handleWatchdogStart, handleWatchdogStop } from './watchdog-hooks.js';
export { handleWorkPromptSubmit, handleWorkResponseComplete } from './work-capture-hooks.js';
