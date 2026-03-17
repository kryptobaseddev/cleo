/**
 * Core primitives — re-exports of foundational modules that have
 * zero store dependencies. Used by src/store/ to break circular deps.
 *
 * @epic T5716
 */

export * from './errors.js';
export * from './error-catalog.js';
export * from './logger.js';
export * from './paths.js';
export * from './platform-paths.js';
