import type { ParsedCANTMessage } from './types';
import { cantParseWASM, initWasm, isWasmAvailable } from './wasm-loader';

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
export async function initCantParser(): Promise<void> {
  await initWasm();
}

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
export function parseCANTMessage(content: string): ParsedCANTMessage {
  // If WASM is available, use it
  if (isWasmAvailable()) {
    try {
      const wasmResult = cantParseWASM(content);
      return {
        directive: wasmResult.directive(),
        directive_type: wasmResult.directive_type() as ParsedCANTMessage['directive_type'],
        addresses: wasmResult.addresses(),
        task_refs: wasmResult.task_refs(),
        tags: wasmResult.tags(),
        header_raw: wasmResult.header_raw(),
        body: wasmResult.body(),
      };
    } catch (error) {
      console.warn('WASM parsing failed, falling back to JS:', error);
    }
  }

  // Fallback: basic JS implementation (header/body split)
  const lines = content.split('\n');
  const header = lines[0] || '';
  const body = lines.slice(1).join('\n');

  // Basic regex extraction (not as robust as WASM parser)
  const directiveMatch = header.match(/^\/([a-z][a-z0-9-]*)/);
  const addresses = [...header.matchAll(/@([a-zA-Z][a-zA-Z0-9_-]*)/g)].map((m) => m[1]);
  const taskRefs = [...content.matchAll(/T(\d+)/g)].map((m) => `T${m[1]}`);
  const tags = [...content.matchAll(/#([a-zA-Z][a-zA-Z0-9_-]*)/g)].map((m) => m[1]);

  return {
    directive: directiveMatch ? directiveMatch[1] : undefined,
    directive_type: directiveMatch ? classifyDirective(directiveMatch[1]) : 'informational',
    addresses,
    task_refs: taskRefs,
    tags,
    header_raw: header,
    body,
  };
}

/**
 * Classify a directive verb into its type
 *
 * @param verb - The directive verb (e.g., 'done', 'action', 'info')
 * @returns 'actionable', 'routing', or 'informational'
 */
function classifyDirective(verb: string): ParsedCANTMessage['directive_type'] {
  const actionable = ['claim', 'done', 'blocked', 'approve', 'decision', 'checkin'];
  const routing = ['action', 'review', 'proposal'];

  if (actionable.includes(verb)) return 'actionable';
  if (routing.includes(verb)) return 'routing';
  return 'informational';
}
