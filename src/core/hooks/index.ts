/**
 * Hooks System - Barrel Export
 *
 * Central export point for the CLEO hooks system.
 * Import from here to access the hook registry, types, and handlers.
 *
 * @module @cleocode/cleo/hooks
 */

export * from './handlers/index.js';
export { HookRegistry, hooks } from './registry.js';
export type * from './types.js';
