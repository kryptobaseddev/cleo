import type { ParsedCANTMessage } from './types';
export type { ParsedCANTMessage };
/**
 * Initialize the CANT parser (loads WASM module)
 * Must be called before using parseCANTMessage
 *
 * @example
 * ```typescript
 * import { initCantParser, parseCANTMessage } from '@cleocode/cant';
 *
 * await initCantParser();
 * const result = parseCANTMessage('/done @all T1234');
 * ```
 */
export declare function initCantParser(): Promise<void>;
/**
 * Parse a CANT message
 *
 * If WASM is available, uses the Rust cant-core parser.
 * Falls back to a basic JavaScript implementation if WASM is not loaded.
 *
 * @param content - The CANT message content to parse
 * @returns ParsedCANTMessage with directive, addresses, task_refs, tags
 *
 * @example
 * ```typescript
 * const result = parseCANTMessage('/done @all T1234 #shipped');
 * console.log(result.directive); // 'done'
 * console.log(result.addresses); // ['all']
 * console.log(result.task_refs); // ['T1234']
 * console.log(result.tags); // ['shipped']
 * ```
 */
export declare function parseCANTMessage(content: string): ParsedCANTMessage;
//# sourceMappingURL=parse.d.ts.map
