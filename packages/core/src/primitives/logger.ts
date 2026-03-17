/**
 * Re-export logger from canonical source.
 * Used by src/store/ to break store→core circular deps.
 *
 * @epic T5716
 */

export { closeLogger, getLogDir, getLogger, initLogger } from '../../../../src/core/logger.js';
export type { LoggerConfig } from '../../../../src/core/logger.js';
