/**
 * Re-export logger from canonical source.
 * Used by src/store/ to break store→core circular deps.
 *
 * @epic T5716
 */

export { closeLogger, getLogDir, getLogger, initLogger } from '../core/logger.js';
export type { LoggerConfig } from '../core/logger.js';
