import { cantParseNative, isNativeAvailable } from './native-loader';
import type { ParsedCANTMessage } from './types';

export type { ParsedCANTMessage };

/**
 * Initialize the CANT parser.
 *
 * With napi-rs native addons this is a no-op — native modules load
 * synchronously. Kept for backward compatibility with code that
 * previously called this for WASM init.
 *
 * @example
 * ```typescript
 * import { initCantParser, parseCANTMessage } from '@cleocode/cant';
 *
 * await initCantParser(); // no-op, kept for compat
 * const result = parseCANTMessage('/done @all T1234');
 * ```
 */
export async function initCantParser(): Promise<void> {
  // No-op: napi-rs native addons load synchronously via require().
  // Kept for backward compatibility.
}

/**
 * Parse a CANT message via the canonical cant-core napi-rs path.
 *
 * The native addon (Rust `cant-core`) is the single source of truth for
 * CANT message parsing (E8-AC2: one canonical path). The previous
 * JS regex fallback is intentionally NOT a routine code path — if the
 * native addon is unavailable the function throws a typed error so
 * callers know they are running in a degraded environment and cannot
 * silently produce wrong results.
 *
 * In test environments where the binary is not present, mock
 * `isNativeAvailable` or use the `CLEO_CANT_ALLOW_JS_FALLBACK=1`
 * environment variable to enable the clearly-marked degraded-mode
 * branch (emits a console.warn and returns a best-effort parse).
 *
 * @param content - The CANT message content to parse.
 * @returns ParsedCANTMessage with directive, addresses, task_refs, tags.
 * @throws {Error} When the native addon is unavailable and
 *   `CLEO_CANT_ALLOW_JS_FALLBACK` is not set.
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
  // Canonical path: use the Rust cant-core parser via napi-rs.
  if (isNativeAvailable()) {
    const nativeResult = cantParseNative(content);
    return {
      directive: nativeResult.directive ?? undefined,
      directive_type: (nativeResult.directiveType?.toLowerCase() ??
        'informational') as ParsedCANTMessage['directive_type'],
      addresses: nativeResult.addresses ?? [],
      task_refs: nativeResult.taskRefs ?? [],
      tags: nativeResult.tags ?? [],
      header_raw: nativeResult.headerRaw ?? '',
      body: nativeResult.body ?? '',
    };
  }

  // ── DEGRADED MODE ────────────────────────────────────────────────────────
  // The native addon is NOT available. This is an explicit degraded-mode
  // branch guarded by an environment variable so it is never activated
  // silently in production (E8-AC2). Callers that need a best-effort parse
  // in environments without the binary (CI matrix, edge runtimes) must
  // set CLEO_CANT_ALLOW_JS_FALLBACK=1 explicitly.
  if (process.env.CLEO_CANT_ALLOW_JS_FALLBACK !== '1') {
    throw new Error(
      'cant-core native addon not available. Build it with: cargo build --release -p cant-napi\n' +
        'Or set CLEO_CANT_ALLOW_JS_FALLBACK=1 to enable the degraded JS fallback parser.',
    );
  }

  // Degraded JS fallback — header/body split with basic regex.
  // Only reached when CLEO_CANT_ALLOW_JS_FALLBACK=1.
  console.warn(
    '[cant] DEGRADED MODE: cant-core native addon unavailable; using JS regex parser. ' +
      'Results may differ from the canonical Rust parser. ' +
      'Build cant-napi to restore full fidelity.',
  );

  const lines = content.split('\n');
  const header = lines[0] ?? '';
  const body = lines.slice(1).join('\n');

  const directiveMatch = header.match(/^\/([a-z][a-z0-9-]*)/);
  const addresses = [...header.matchAll(/@([a-zA-Z][a-zA-Z0-9_-]*)/g)].map((m) => m[1] ?? '');
  const taskRefs = [...content.matchAll(/T(\d+)/g)].map((m) => `T${m[1] ?? ''}`);
  const tags = [...content.matchAll(/#([a-zA-Z][a-zA-Z0-9_-]*)/g)].map((m) => m[1] ?? '');

  return {
    directive: directiveMatch ? directiveMatch[1] : undefined,
    directive_type: directiveMatch
      ? _classifyDirectiveFallback(directiveMatch[1] ?? '')
      : 'informational',
    addresses,
    task_refs: taskRefs,
    tags,
    header_raw: header,
    body,
  };
}

/**
 * Classify a directive verb into its type.
 *
 * @internal Used only by the degraded JS fallback parser.
 * @param verb - The directive verb (e.g., 'done', 'action', 'info')
 * @returns 'actionable', 'routing', or 'informational'
 */
function _classifyDirectiveFallback(verb: string): ParsedCANTMessage['directive_type'] {
  const actionable = ['claim', 'done', 'blocked', 'approve', 'decision', 'checkin'];
  const routing = ['action', 'review', 'proposal'];

  if (actionable.includes(verb)) return 'actionable';
  if (routing.includes(verb)) return 'routing';
  return 'informational';
}
