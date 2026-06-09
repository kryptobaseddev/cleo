/**
 * generateOpenApi — projects the CLEO operations registry into an OpenAPI 3.1
 * document (DHQ-033/057 SDK-projection · T11918 · AC2 · M5/E-API-STANDARD-FOUNDATION
 * T11769).
 *
 * ## Why this exists
 *
 * The `/v1` REST gateway routes `POST /v1/<domain>/<operation>` for every entry
 * in the 413-row {@link OPERATIONS} registry. Downstream task T11920 generates a
 * typed SDK client; its projection source is an OpenAPI 3.1 spec. Hand-authoring
 * 413 path objects (and keeping them in lock-step with the registry) is exactly
 * the drift trap the schema-first SSoT (`inputSchema`/`outputSchema`) was built
 * to close. This builder DERIVES the whole spec from the single source of truth:
 *
 *   - paths        ← {@link OPERATIONS} (`POST /v1/<domain>/<operation>`)
 *   - requestBody  ← {@link getInputContract}(op).schema, else a JSON Schema
 *                    synthesised from `def.params` (richest available input shape)
 *   - 200 response ← {@link getOutputContract}(op).dataSchema (hand-authored
 *                    {@link OUTPUT_CONTRACTS}, else {@link deriveOutputContract})
 *
 * Because `OperationInputContract.schema` and `OperationOutputContract.dataSchema`
 * are ALREADY JSON Schema (draft-07) documents, and OpenAPI 3.1's Schema Object
 * IS a superset of JSON Schema (it adopts the JSON Schema 2020-12 vocabulary),
 * the schemas embed directly — no zod→OpenAPI conversion pass, no `zod-to-openapi`
 * dependency. Zod (v4) is the authoring substrate for the contracts upstream; by
 * the time a schema reaches this builder it is already plain JSON Schema, so this
 * module stays a zero-runtime-dependency projection over the registry.
 *
 * ## Boundary
 *
 * Lives in `core/src/runtime` (NOT `contracts`): it reads {@link getOutputContract}
 * / {@link getInputContract}, which are core-resident bodied resolvers, and it is
 * itself a bodied runtime helper (the contracts-purity Gate 10 forbids net-new
 * bodied functions in `contracts`). Import-time side-effect-free: it builds
 * nothing at module load, only when {@link generateOpenApi} is called.
 *
 * @packageDocumentation
 * @module @cleocode/core/runtime/openapi/generate-openapi
 *
 * @see {@link https://spec.openapis.org/oas/v3.1.0 | OpenAPI 3.1.0 Specification}
 * @see OperationOutputContract — the OUTPUT-side JSON Schema SSoT this projects
 * @see OperationInputContract — the INPUT-side JSON Schema SSoT this projects
 *
 * @epic T11769
 * @task T11918 — AC2: zod→OpenAPI 3.1 bridge + `cleo gateway openapi`
 */

import { type JsonSchema, OPERATIONS, type OperationDef, type ParamDef } from '@cleocode/contracts';
import { getInputContract } from '../../dispatch/contracts/input-contracts.js';
import { getOutputContract } from '../../dispatch/contracts/output-contracts.js';

// ---------------------------------------------------------------------------
// OpenAPI 3.1 document shape (minimal — only the members this builder emits)
// ---------------------------------------------------------------------------

/**
 * OpenAPI 3.1 `info` object — API identity surfaced to SDK generators and docs
 * tooling.
 *
 * @see {@link https://spec.openapis.org/oas/v3.1.0#info-object}
 */
export interface OpenApiInfo {
  /** Human-readable API title. */
  title: string;
  /**
   * Semantic version of the API surface (NOT the package version). The `/v1`
   * REST gateway is version `1.x`; defaults to `'1.0.0'`.
   */
  version: string;
  /** Optional one-line summary (OpenAPI 3.1 adds `summary` to the info object). */
  summary?: string;
  /** Optional CommonMark description. */
  description?: string;
}

/**
 * OpenAPI 3.1 Media Type object — pairs a content type with its schema.
 *
 * @see {@link https://spec.openapis.org/oas/v3.1.0#media-type-object}
 */
export interface OpenApiMediaType {
  /** The JSON Schema (2020-12 vocabulary) describing the payload. */
  schema: JsonSchema;
}

/**
 * OpenAPI 3.1 Request Body object.
 *
 * @see {@link https://spec.openapis.org/oas/v3.1.0#request-body-object}
 */
export interface OpenApiRequestBody {
  /** Content keyed by media type (always `application/json` here). */
  content: Record<string, OpenApiMediaType>;
  /** Whether the request body is required (true iff the op has required params). */
  required: boolean;
  /** Optional human description. */
  description?: string;
}

/**
 * OpenAPI 3.1 Response object.
 *
 * @see {@link https://spec.openapis.org/oas/v3.1.0#response-object}
 */
export interface OpenApiResponse {
  /** Required CommonMark description of the response. */
  description: string;
  /** Optional content keyed by media type. */
  content?: Record<string, OpenApiMediaType>;
}

/**
 * OpenAPI 3.1 Operation object — one HTTP operation on a path.
 *
 * @see {@link https://spec.openapis.org/oas/v3.1.0#operation-object}
 */
export interface OpenApiOperation {
  /** Unique, machine-friendly id (`<gateway>.<domain>.<operation>`) for SDK method naming. */
  operationId: string;
  /** Short summary (the registry `description`). */
  summary: string;
  /** Grouping tags — the canonical domain. */
  tags: string[];
  /** Request body, omitted when the op declares no input params. */
  requestBody?: OpenApiRequestBody;
  /** Responses keyed by HTTP status code (always at least `'200'`). */
  responses: Record<string, OpenApiResponse>;
  /**
   * Vendor extension carrying the CQRS gateway (`'query'` | `'mutate'`) this
   * operation routes through. The clean `/v1/<domain>/<operation>` path omits the
   * gateway for readability, so the SDK reads this extension to pick the right
   * dispatch gateway. OpenAPI tooling ignores `x-`-prefixed members it does not
   * recognise, so emitting it keeps the document valid.
   */
  'x-cleo-gateway': 'query' | 'mutate';
}

/**
 * OpenAPI 3.1 Path Item object — the set of HTTP operations on one path. The
 * CLEO `/v1` gateway only routes `POST`, so only `post` is ever populated.
 *
 * @see {@link https://spec.openapis.org/oas/v3.1.0#path-item-object}
 */
export interface OpenApiPathItem {
  /** The single `POST` operation served at this path. */
  post: OpenApiOperation;
}

/**
 * A minimal, structurally-typed OpenAPI 3.1 document — exactly the members
 * {@link generateOpenApi} emits. The `openapi` field is pinned to the `3.1.x`
 * literal family so consumers can statically assert the version.
 *
 * @see {@link https://spec.openapis.org/oas/v3.1.0#openapi-object}
 */
export interface OpenApiDocument {
  /** OpenAPI version string — always `'3.1.0'`. */
  openapi: '3.1.0';
  /** API identity. */
  info: OpenApiInfo;
  /**
   * The JSON Schema dialect every embedded Schema Object uses, declared once at
   * the document root per OpenAPI 3.1. The contracts ship draft-07 schemas,
   * which validate under the 2020-12 dialect OpenAPI 3.1 mandates.
   */
  jsonSchemaDialect: string;
  /**
   * Path → path-item map, keyed by `<pathPrefix>/<domain>/<operation>` (with a
   * trailing `/<gateway>` segment for the cross-gateway collision pairs).
   */
  paths: Record<string, OpenApiPathItem>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for {@link generateOpenApi}.
 */
export interface GenerateOpenApiOptions {
  /**
   * Semantic version stamped into `info.version`. This is the API-surface
   * version (the `/v1` gateway), NOT the npm package version.
   *
   * @default '1.0.0'
   */
  version?: string;
  /**
   * Path prefix prepended to every operation route. The SDK-facing REST surface
   * is versioned under `/v1` (T11769); each op maps to
   * `POST <pathPrefix>/<domain>/<operation>`.
   *
   * @default '/v1'
   */
  pathPrefix?: string;
}

// ---------------------------------------------------------------------------
// Input-schema derivation
// ---------------------------------------------------------------------------

/**
 * Map a {@link ParamDef.type} to its JSON Schema `type` keyword.
 *
 * `array` params are modelled as `{ type: 'array', items: { type: 'string' } }`
 * — the CLI/dispatch layer accepts array params as comma-separated or repeated
 * strings, so a string-item array is the faithful wire shape.
 *
 * @internal
 */
function paramSchema(param: ParamDef): JsonSchema {
  const base: JsonSchema = { description: param.description };
  if (param.enum !== undefined && param.enum.length > 0) {
    return { ...base, type: 'string', enum: [...param.enum] };
  }
  switch (param.type) {
    case 'number':
      return { ...base, type: 'number' };
    case 'boolean':
      return { ...base, type: 'boolean' };
    case 'array':
      return { ...base, type: 'array', items: { type: 'string' } };
    default:
      return { ...base, type: 'string' };
  }
}

/**
 * Synthesise a JSON Schema `object` from an operation's `params` (or, when
 * `params` is absent/empty, from its `requiredParams`). Hidden params are
 * excluded — they are CLI-only knobs (`--dry-run`, `--offset`) and not part of
 * the public API surface (see {@link ParamDef.hidden}).
 *
 * Returns `null` when the operation declares no API-visible input at all, so the
 * caller can omit the `requestBody` entirely.
 *
 * @internal
 */
function inputSchemaFromParams(def: OperationDef): JsonSchema | null {
  const params = (def.params ?? []).filter((p) => p.hidden !== true);
  if (params.length > 0) {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const p of params) {
      properties[p.name] = paramSchema(p);
      if (p.required) required.push(p.name);
    }
    const schema: JsonSchema = { type: 'object', properties, additionalProperties: false };
    if (required.length > 0) schema.required = required;
    return schema;
  }

  // Legacy ops with no `params` array but a `requiredParams` list: emit a
  // minimal object so the contract is still expressed.
  if (def.requiredParams.length > 0) {
    const properties: Record<string, JsonSchema> = {};
    for (const name of def.requiredParams) properties[name] = { type: 'string' };
    return {
      type: 'object',
      properties,
      required: [...def.requiredParams],
      additionalProperties: true,
    };
  }

  return null;
}

/**
 * Resolve the richest available JSON Schema for an operation's request body.
 *
 * Precedence: a hand-authored {@link getInputContract}(op) wins (it carries
 * curated constraints + examples); otherwise the schema is derived from the
 * operation's `params`. A `null` return means "no API-visible input" and the
 * caller omits `requestBody`.
 *
 * @internal
 */
function resolveRequestSchema(def: OperationDef): JsonSchema | null {
  const key = `${def.domain}.${def.operation}`;
  const contract = getInputContract(key);
  if (contract !== null) return contract.schema;
  return inputSchemaFromParams(def);
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build one OpenAPI 3.1 {@link OpenApiOperation} from a single registry entry.
 *
 * @param def - The registry operation definition.
 * @param operationId - The document-unique operationId assigned by the caller
 *   (the caller owns uniqueness because two registry entries can share a
 *   `<domain>.<operation>` across gateways).
 * @internal
 */
function buildOperation(def: OperationDef, operationId: string): OpenApiOperation {
  // The output contract is keyed on canonical `<domain>.<operation>` (NOT the
  // disambiguated operationId), so resolve it from the registry coordinates.
  const contractKey = `${def.domain}.${def.operation}`;
  const operation: OpenApiOperation = {
    operationId,
    summary: def.description,
    tags: [def.domain],
    'x-cleo-gateway': def.gateway,
    responses: {
      '200': buildSuccessResponse(contractKey),
    },
  };

  const requestSchema = resolveRequestSchema(def);
  if (requestSchema !== null) {
    operation.requestBody = {
      required: def.requiredParams.length > 0,
      content: { 'application/json': { schema: requestSchema } },
    };
  }

  return operation;
}

/**
 * Build the `200` response object for an operation, wrapping the resolved
 * `dataSchema` in the canonical LAFS envelope shape
 * (`{ success, data, meta }`) so the spec describes the ACTUAL wire response —
 * not just the inner `data` payload.
 *
 * @internal
 */
function buildSuccessResponse(operationId: string): OpenApiResponse {
  const output = getOutputContract(operationId);
  const dataSchema: JsonSchema = output?.dataSchema ?? {
    type: 'object',
    additionalProperties: true,
  };
  const description = output?.shapeNote ?? 'Successful LAFS response envelope.';

  const envelopeSchema: JsonSchema = {
    type: 'object',
    required: ['success', 'data', 'meta'],
    properties: {
      success: { type: 'boolean', const: true },
      data: dataSchema,
      meta: { type: 'object', additionalProperties: true, description: 'LAFS response metadata.' },
    },
    additionalProperties: true,
  };

  return {
    description,
    content: { 'application/json': { schema: envelopeSchema } },
  };
}

/**
 * Allocate a document-unique key from a desired base, appending `/2`, `/3`, …
 * (or `.2`, `.3`, … for dotted ids) only when the base is already taken.
 *
 * Used for BOTH path routes and operationIds. The CLEO operations registry is
 * NOT collision-free on `<domain>/<operation>`: 8 ops appear under both the
 * `query` AND `mutate` gateways (e.g. `admin/map`, `release/gate`), and one op
 * (`tasks/tree`) is a genuine same-gateway duplicate. OpenAPI mandates unique
 * path keys and unique operationIds, so each registry entry MUST still map to a
 * distinct slot to keep the path count equal to `OPERATIONS.length` (AC5). The
 * cross-gateway collisions are disambiguated by the caller (gateway suffix); a
 * residual exact duplicate falls back to the numeric suffix here.
 *
 * @internal
 */
function uniqueKey(base: string, taken: Set<string>, sep: string): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let n = 2;
  let candidate = `${base}${sep}${n}`;
  while (taken.has(candidate)) {
    n++;
    candidate = `${base}${sep}${n}`;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * Project the {@link OPERATIONS} registry into a complete OpenAPI 3.1 document.
 *
 * Walks every registry entry, mapping each to a `POST` path whose `requestBody`
 * is the resolved input schema and whose `200` response is the resolved output
 * schema (`deriveOutputContract` coverage), wrapped in the LAFS envelope.
 *
 * Routing: the clean form is `POST <pathPrefix>/<domain>/<operation>`. Because
 * the registry has cross-gateway collisions on `<domain>/<operation>` (the same
 * pair under both `query` and `mutate`), a colliding entry is disambiguated by
 * appending its gateway segment (`<pathPrefix>/<domain>/<operation>/<gateway>`).
 * Each operation also carries an `x-cleo-gateway` extension so the SDK knows
 * which CQRS gateway to dispatch through regardless of the path form.
 *
 * The number of paths in the returned document equals `OPERATIONS.length` (AC5):
 * every registry entry gets a unique route (and a unique operationId).
 *
 * @param options - {@link GenerateOpenApiOptions} (version, path prefix).
 * @returns A structurally-valid OpenAPI 3.1 {@link OpenApiDocument}.
 *
 * @example
 * ```ts
 * const doc = generateOpenApi();
 * doc.openapi;                                       // '3.1.0'
 * Object.keys(doc.paths).length;                     // === OPERATIONS.length
 * doc.paths['/v1/tasks/show'].post.operationId;      // 'query.tasks.show'
 * doc.paths['/v1/tasks/show'].post['x-cleo-gateway'];// 'query'
 * ```
 *
 * @task T11918 — AC1/AC2/AC5
 */
export function generateOpenApi(options: GenerateOpenApiOptions = {}): OpenApiDocument {
  const version = options.version ?? '1.0.0';
  const pathPrefix = options.pathPrefix ?? '/v1';

  // Pre-compute which `<domain>/<operation>` pairs collide across gateways so
  // only the colliding ones take the gateway-suffixed path (keeping the clean
  // `/v1/<domain>/<operation>` form for the unambiguous majority).
  const pairCounts = new Map<string, number>();
  for (const def of OPERATIONS) {
    const pair = `${def.domain}/${def.operation}`;
    pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
  }

  const paths: Record<string, OpenApiPathItem> = {};
  const takenRoutes = new Set<string>();
  const takenOperationIds = new Set<string>();

  for (const def of OPERATIONS) {
    const pair = `${def.domain}/${def.operation}`;
    const collides = (pairCounts.get(pair) ?? 0) > 1;
    const baseRoute = collides
      ? `${pathPrefix}/${def.domain}/${def.operation}/${def.gateway}`
      : `${pathPrefix}/${def.domain}/${def.operation}`;
    const route = uniqueKey(baseRoute, takenRoutes, '/');

    // operationId is always gateway-qualified so it is unique even for the
    // cross-gateway pairs; a residual same-gateway dup gets a numeric suffix.
    const operationId = uniqueKey(
      `${def.gateway}.${def.domain}.${def.operation}`,
      takenOperationIds,
      '.',
    );

    paths[route] = { post: buildOperation(def, operationId) };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'CLEO Gateway API',
      version,
      summary: 'CQRS operations gateway projected from the CLEO operations registry.',
      description:
        'Auto-generated from the canonical OPERATIONS registry. Every operation is reachable ' +
        `via POST ${pathPrefix}/<domain>/<operation> with a JSON request body and a LAFS ` +
        'response envelope. This document is the projection source for the generated SDK client.',
    },
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    paths,
  };
}
