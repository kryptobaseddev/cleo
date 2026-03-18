/**
 * Re-export sequence utilities from canonical source.
 * Used by src/store/ to break store→core circular deps.
 *
 * @epic T5716
 */

export { checkSequence, repairSequence } from '../core/sequence/index.js';
