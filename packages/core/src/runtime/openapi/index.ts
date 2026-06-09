/**
 * OpenAPI 3.1 projection — public surface.
 *
 * Re-exports the {@link generateOpenApi} builder and its OpenAPI 3.1 document
 * types. The builder projects the canonical {@link OPERATIONS} registry into an
 * OpenAPI 3.1 spec consumed by `cleo gateway openapi` and the downstream
 * generated SDK client (T11920).
 *
 * @packageDocumentation
 * @module @cleocode/core/runtime/openapi
 *
 * @epic T11769
 * @task T11918
 */

export {
  type GenerateOpenApiOptions,
  generateOpenApi,
  type OpenApiDocument,
  type OpenApiInfo,
  type OpenApiMediaType,
  type OpenApiOperation,
  type OpenApiPathItem,
  type OpenApiRequestBody,
  type OpenApiResponse,
} from './generate-openapi.js';
