/**
 * nexus-decorator — stamps `meta._nexus` on every nexus-domain dispatch response.
 *
 * Wave 2 of the Nexus Restructure (T9146). Reads `getNexusDescriptor(opId)` from
 * the W1 SSoT (`NEXUS_SCOPE_MAP`) and injects the namespaced `_nexus` block into
 * `DispatchResponse['meta']`.
 *
 * Usage:
 * ```ts
 * const decorated = stampNexusMeta(response, operation, params);
 * ```
 *
 * The `suggestedNext` field uses a structured form (not literal display strings).
 * Display strings are derived by `formatSuggestedNext()` for human/markdown renderers.
 *
 * Typed-registry gate: `validateSuggestedNext()` fails the build (throws at import-time
 * in test mode) if any `suggestedNext.op` is absent from `NEXUS_SCOPE_MAP`.
 *
 * @task T9146
 * @module dispatch/nexus-decorator
 */

import type {
  NexusBindingSource,
  NexusOps,
  NexusScopeMeta,
  SuggestedNextOp,
} from '@cleocode/contracts';
import { getNexusDescriptor, NEXUS_SCOPE_MAP } from '@cleocode/contracts';
import type { DispatchResponse, DispatchResponseMeta } from './types.js';

// ---------------------------------------------------------------------------
// Binding-source resolution
// ---------------------------------------------------------------------------

/**
 * Resolve how the `projectId` was bound for a given operation call.
 *
 * Priority: explicit `--project-id` arg > `--path` arg > cwd resolution >
 * registry lookup > none (for global/living-brain scope ops).
 */
function resolveBindingSource(
  descriptor: ReturnType<typeof getNexusDescriptor>,
  params: Record<string, unknown>,
): NexusBindingSource {
  if (!descriptor.requiresProject) return 'none';
  if (typeof params['projectId'] === 'string' && params['projectId']) {
    return 'arg-project-id';
  }
  if (typeof params['path'] === 'string' && params['path']) {
    return 'arg-path';
  }
  // Distinguish cwd vs registry: if a projectId was resolved (e.g. by the
  // engine from cwd) it comes through as projectId in params; absence means
  // the registry was consulted.
  if (typeof params['_resolvedFrom'] === 'string') {
    return params['_resolvedFrom'] === 'cwd' ? 'cwd' : 'registry';
  }
  return 'cwd';
}

// ---------------------------------------------------------------------------
// indexFreshness
// ---------------------------------------------------------------------------

/**
 * Determine index freshness for `indexSensitive` operations.
 *
 * Only called for top-level CLI invocations (sub-calls inherit via
 * `meta.requestId` lineage to avoid per-call git-status shell-outs).
 * Returns `'unknown'` when freshness cannot be determined cheaply.
 */
function resolveIndexFreshness(params: Record<string, unknown>): NexusScopeMeta['indexFreshness'] {
  // If the engine already stamped freshness on the response params, use it.
  const fromParams = params['_indexFreshness'];
  if (fromParams === 'fresh' || fromParams === 'stale') return fromParams;
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Canonical command
// ---------------------------------------------------------------------------

/** Derive the canonical CLI command string from the operation key. */
function canonicalCommandFor(op: string): string {
  return `cleo nexus ${op}`;
}

// ---------------------------------------------------------------------------
// Typed-registry gate
// ---------------------------------------------------------------------------

/**
 * Assert that every `suggestedNext.op` in a list resolves to a known
 * NEXUS_SCOPE_MAP entry.
 *
 * Throws `TypeError` at runtime (caught by tests and CI) if an unknown op
 * is referenced — acting as a build-time gate when imported in test suites.
 *
 * @throws {TypeError} if any `op` is absent from `NEXUS_SCOPE_MAP`
 * @task T9146
 */
export function validateSuggestedNext(suggestions: ReadonlyArray<SuggestedNextOp>): void {
  for (const s of suggestions) {
    if (!(s.op in NEXUS_SCOPE_MAP)) {
      throw new TypeError(
        `[nexus-decorator] suggestedNext.op "${s.op}" is not a known NEXUS_SCOPE_MAP entry. ` +
          `Add it to packages/contracts/src/operations/nexus-scope-map.ts first.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Display formatter
// ---------------------------------------------------------------------------

/**
 * Derive a human-readable display string from a {@link SuggestedNextOp}.
 *
 * Example: `"cleo nexus context --project-id myproj (read-only, no confirmation needed)"`
 */
export function formatSuggestedNext(s: SuggestedNextOp): string {
  const argParts = Object.entries(s.args)
    .map(([k, v]) => `--${k} ${String(v)}`)
    .join(' ');
  const cmd = `cleo nexus ${s.op}${argParts ? ` ${argParts}` : ''}`;
  const confirm = s.requiresConfirmation ? 'confirm before running' : 'no confirmation needed';
  return `${cmd} (${s.effect}, ${confirm}) — ${s.reason}`;
}

// ---------------------------------------------------------------------------
// stampNexusMeta — core decorator
// ---------------------------------------------------------------------------

/**
 * Stamp `meta._nexus` onto a nexus-domain {@link DispatchResponse}.
 *
 * Call this after every nexus handler produces its `DispatchResponse`. The
 * function is a pure transformer — it returns a new object with `meta._nexus`
 * merged in.
 *
 * @param response  - The original dispatch response from the nexus handler.
 * @param operation - The nexus operation key (must be a `keyof NexusOps`).
 * @param params    - Raw params passed to the handler (used for binding-source resolution).
 * @param isTopLevel - Whether this is a top-level CLI invocation (not a sub-call).
 * @returns A new `DispatchResponse` with `meta._nexus` populated.
 *
 * @task T9146
 */
export function stampNexusMeta(
  response: DispatchResponse,
  operation: string,
  params: Record<string, unknown>,
  isTopLevel = true,
): DispatchResponse {
  // Unknown ops (not in NEXUS_SCOPE_MAP) fall through without decoration —
  // the handler already returned an unsupported-op error.
  if (!(operation in NEXUS_SCOPE_MAP)) {
    return response;
  }

  const descriptor = getNexusDescriptor(operation as keyof NexusOps);
  const bindingSource = resolveBindingSource(descriptor, params);

  const projectId = typeof params['projectId'] === 'string' ? params['projectId'] : undefined;
  const projectName =
    typeof params['_projectName'] === 'string' ? params['_projectName'] : undefined;
  const projectPath =
    typeof params['_projectPath'] === 'string' ? params['_projectPath'] : undefined;
  const registryPath =
    typeof params['_registryPath'] === 'string' ? params['_registryPath'] : undefined;
  const counterpartProjectId =
    descriptor.scope === 'cross' || descriptor.scope === 'hybrid'
      ? typeof params['counterpartProjectId'] === 'string'
        ? params['counterpartProjectId']
        : undefined
      : undefined;

  const indexFreshness =
    descriptor.indexSensitive && isTopLevel ? resolveIndexFreshness(params) : undefined;

  const legacyAliasFor =
    typeof params['_legacyAliasFor'] === 'string' ? params['_legacyAliasFor'] : undefined;

  const nexusMeta: NexusScopeMeta = {
    scope: descriptor.scope,
    effect: descriptor.effect,
    ...(projectId !== undefined && { projectId }),
    ...(projectName !== undefined && { projectName }),
    ...(projectPath !== undefined && { projectPath }),
    ...(registryPath !== undefined && { registryPath }),
    bindingSource,
    ...(counterpartProjectId !== undefined && { counterpartProjectId }),
    ...(indexFreshness !== undefined && { indexFreshness }),
    canonicalCommand: canonicalCommandFor(operation),
    ...(legacyAliasFor !== undefined && { legacyAliasFor }),
  };

  return {
    ...response,
    meta: {
      ...response.meta,
      _nexus: nexusMeta,
      // Stamp top-level deprecated field for alias shims (T9147)
      ...(legacyAliasFor !== undefined && {
        deprecated: {
          since: 'v2026.6.5',
          removeIn: 'v2026.8.0',
          replacement: `cleo graph ${operation}`,
        },
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// pickDecoratorMetaExtensions — forward decorator fields into CLI envelope
// ---------------------------------------------------------------------------

/**
 * Pick the decorator-stamped fields (`_nexus`, `deprecated`) from a dispatch
 * response's `meta` so they can be forwarded via `cliOutput`'s `extensions`
 * option into the emitted LAFS envelope.
 *
 * Without this, `cliOutput(response.data, ...)` discards `response.meta._nexus`
 * + `response.meta.deprecated` (T9393 defect). Canonical CLI meta fields
 * (`operation`, `requestId`, `timestamp`) are intentionally NOT forwarded —
 * those are produced by {@link createCliMeta} on the CLI side.
 *
 * @task T9393
 */
export function pickDecoratorMetaExtensions(
  responseMeta: DispatchResponseMeta | undefined,
): Record<string, unknown> {
  if (!responseMeta) return {};
  const out: Record<string, unknown> = {};
  if (responseMeta['_nexus'] !== undefined) out['_nexus'] = responseMeta['_nexus'];
  if (responseMeta['deprecated'] !== undefined) out['deprecated'] = responseMeta['deprecated'];
  return out;
}

/**
 * Build CLI envelope extensions for nexus commands that bypass the dispatcher
 * (e.g. `cleo nexus status` SSoT-EXEMPT path). Runs the same {@link stampNexusMeta}
 * logic against a synthetic response so the resulting envelope still carries
 * `meta._nexus` (and `meta.deprecated` for alias shims).
 *
 * Use this only where the command does NOT call `dispatchRaw`. When you have a
 * real dispatch response, use {@link pickDecoratorMetaExtensions} on
 * `response.meta` instead — that path already ran the decorator.
 *
 * @task T9393
 */
export function buildNexusMetaExtensions(
  operation: string,
  params: Record<string, unknown> = {},
): Record<string, unknown> {
  const synthetic: DispatchResponse = {
    success: true,
    data: undefined,
    meta: {
      gateway: 'query',
      domain: 'nexus',
      operation,
      timestamp: new Date().toISOString(),
      duration_ms: 0,
      source: 'cli',
      requestId: '',
    },
  } as DispatchResponse;
  const stamped = stampNexusMeta(synthetic, operation, params);
  return pickDecoratorMetaExtensions(stamped.meta);
}
