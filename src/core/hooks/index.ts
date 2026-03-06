/**
 * Hooks System - Barrel Export
 *
 * Central export point for the CLEO hooks system.
 * Import from here to access the hook registry, types, and handlers.
 *
 * @module @cleocode/cleo/hooks
 */

export { hooks, HookRegistry } from './registry.js';
export type * from './types.js';
export * from './handlers/index.js';
