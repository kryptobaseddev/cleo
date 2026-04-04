import type { ParsedCANTMessage } from './types';
export type { ParsedCANTMessage };
/**
 * Initialize the CANT parser
 *
 * With napi-rs native addons, this is a no-op (native modules load synchronously).
 * Kept for backward compatibility with code that previously called this for WASM init.
 *
 * @example
 * ```typescript
 * import { initCantParser, parseCANTMessage } from '@cleocode/cant';
 *
 * await initCantParser(); // no-op, kept for compat
 * const result = parseCANTMessage('/done @all T1234');
 * ```
 */
export declare function initCantParser(): Promise<void>;
/**
 * Parse a CANT message
 *
 * If the native addon is available, uses the Rust cant-core parser via napi-rs.
 * Falls back to a basic JavaScript implementation if the native addon is not loaded.
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
