"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initCantParser = initCantParser;
exports.parseCANTMessage = parseCANTMessage;
const native_loader_1 = require("./native-loader");
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
async function initCantParser() {
    // No-op: napi-rs native addons load synchronously via require().
    // Kept for backward compatibility.
}
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
function parseCANTMessage(content) {
    // If native addon is available, use it
    if ((0, native_loader_1.isNativeAvailable)()) {
        try {
            const nativeResult = (0, native_loader_1.cantParseNative)(content);
            return {
                directive: nativeResult.directive ?? undefined,
                directive_type: (nativeResult.directiveType?.toLowerCase() ??
                    'informational'),
                addresses: nativeResult.addresses ?? [],
                task_refs: nativeResult.taskRefs ?? [],
                tags: nativeResult.tags ?? [],
                header_raw: nativeResult.headerRaw ?? '',
                body: nativeResult.body ?? '',
            };
        }
        catch (error) {
            console.warn('Native parsing failed, falling back to JS:', error);
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
function classifyDirective(verb) {
    const actionable = ['claim', 'done', 'blocked', 'approve', 'decision', 'checkin'];
    const routing = ['action', 'review', 'proposal'];
    if (actionable.includes(verb))
        return 'actionable';
    if (routing.includes(verb))
        return 'routing';
    return 'informational';
}
//# sourceMappingURL=parse.js.map