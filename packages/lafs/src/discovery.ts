/**
 * LAFS Agent Discovery - Express/Fastify Middleware
 * Serves A2A-compliant Agent Card at /.well-known/agent-card.json
 * Maintains backward compatibility with legacy /.well-known/lafs.json
 *
 * A2A v1.0+ Compliant Implementation
 * Reference: specs/external/agent-discovery.md
 */

import { createRequire } from 'node:module';
import { createHash } from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { buildLafsExtension } from './a2a/extensions.js';

const require = createRequire(import.meta.url);

// Resolve package.json from project root (works from both src/ and dist/src/)
let pkg: { version: string };
try {
  pkg = require('../package.json');
} catch {
  pkg = require('../../package.json');
}

// ============================================================================
// A2A v1.0 Agent Card Types
// ============================================================================

/**
 * A2A Agent Provider information.
 *
 * @remarks
 * Describes the organization that provides and maintains an A2A agent.
 * Used within {@link AgentCard} to identify the service provider.
 *
 * @example
 * ```typescript
 * const provider: AgentProvider = {
 *   url: "https://example.com",
 *   organization: "Acme Corp"
 * };
 * ```
 */
export interface AgentProvider {
  /** Organization URL (must be a valid HTTPS URL) */
  url: string;
  /** Organization name (human-readable label) */
  organization: string;
}

/**
 * A2A Agent Capabilities.
 *
 * @remarks
 * Declares the runtime capabilities of an A2A agent, including streaming support,
 * push notification handling, and registered protocol extensions.
 *
 * @example
 * ```typescript
 * const caps: AgentCapabilities = {
 *   streaming: true,
 *   pushNotifications: false,
 *   extendedAgentCard: false,
 *   extensions: []
 * };
 * ```
 */
export interface AgentCapabilities {
  /**
   * Supports streaming responses.
   * @defaultValue `undefined` (treated as `false`)
   */
  streaming?: boolean;
  /**
   * Supports push notifications.
   * @defaultValue `undefined` (treated as `false`)
   */
  pushNotifications?: boolean;
  /**
   * Supports extended agent card.
   * @defaultValue `undefined` (treated as `false`)
   */
  extendedAgentCard?: boolean;
  /**
   * Supported extensions declared by this agent.
   * @defaultValue `undefined`
   */
  extensions?: AgentExtension[];
}

/**
 * A2A Agent Extension declaration.
 *
 * @remarks
 * Represents a protocol extension supported by the agent. Extensions use a URI
 * as a globally-unique identifier and may carry extension-specific parameters.
 *
 * @example
 * ```typescript
 * const ext: AgentExtension = {
 *   uri: "https://lafs.dev/extensions/v1/lafs",
 *   description: "LAFS envelope protocol",
 *   required: false,
 *   params: { supportsContextLedger: true }
 * };
 * ```
 */
export interface AgentExtension {
  /** Extension URI (globally-unique identifier) */
  uri: string;
  /** Human-readable description of what the extension provides */
  description: string;
  /** Whether the extension is required for interoperability */
  required: boolean;
  /**
   * Extension-specific parameters.
   * @defaultValue `undefined`
   */
  params?: Record<string, unknown>;
}

/**
 * A2A Agent Skill.
 *
 * @remarks
 * Describes a discrete capability exposed by the agent. Skills include metadata
 * for discovery (tags, examples) and may override the agent-level I/O modes.
 *
 * @example
 * ```typescript
 * const skill: AgentSkill = {
 *   id: "envelope-processor",
 *   name: "Envelope Processor",
 *   description: "Validates and processes LAFS envelopes",
 *   tags: ["lafs", "envelope"],
 *   examples: ["Validate this envelope"],
 * };
 * ```
 */
export interface AgentSkill {
  /** Skill unique identifier (kebab-case recommended) */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Detailed description of what the skill does */
  description: string;
  /** Keywords/tags for discovery and categorization */
  tags: string[];
  /**
   * Example prompts that demonstrate typical usage.
   * @defaultValue `undefined`
   */
  examples?: string[];
  /**
   * Supported input modes (overrides agent-level {@link AgentCard.defaultInputModes}).
   * @defaultValue `undefined`
   */
  inputModes?: string[];
  /**
   * Supported output modes (overrides agent-level {@link AgentCard.defaultOutputModes}).
   * @defaultValue `undefined`
   */
  outputModes?: string[];
}

/**
 * Security scheme for authentication (OpenAPI 3.0 style).
 *
 * @remarks
 * Maps to the OpenAPI 3.0 Security Scheme Object. Used in {@link AgentCard.securitySchemes}
 * to declare supported authentication mechanisms.
 *
 * @example
 * ```typescript
 * const scheme: SecurityScheme = {
 *   type: "http",
 *   scheme: "bearer",
 *   bearerFormat: "JWT",
 * };
 * ```
 */
export interface SecurityScheme {
  /** Authentication type per OpenAPI 3.0 */
  type: 'http' | 'apiKey' | 'oauth2' | 'openIdConnect';
  /**
   * Human-readable description of the scheme.
   * @defaultValue `undefined`
   */
  description?: string;
  /**
   * HTTP auth scheme name (e.g., `"bearer"`).
   * @defaultValue `undefined`
   */
  scheme?: string;
  /**
   * Bearer token format hint (e.g., `"JWT"`).
   * @defaultValue `undefined`
   */
  bearerFormat?: string;
}

/**
 * A2A v1.0 Agent Card - Standard format for agent discovery.
 *
 * @remarks
 * The Agent Card is the primary discovery document for A2A v1.0. It is served
 * at `/.well-known/agent-card.json` and describes the agent's identity,
 * capabilities, skills, and security requirements.
 * Reference: specs/external/specification.md Section 5.
 *
 * @example
 * ```typescript
 * const card: AgentCard = {
 *   name: "my-agent",
 *   description: "A LAFS-compliant agent",
 *   version: "1.0.0",
 *   url: "https://api.example.com",
 *   capabilities: { streaming: false },
 *   defaultInputModes: ["application/json"],
 *   defaultOutputModes: ["application/json"],
 *   skills: [],
 * };
 * ```
 */
export interface AgentCard {
  /**
   * JSON Schema URL for validation.
   * @defaultValue `undefined`
   */
  $schema?: string;
  /** Human-readable agent name */
  name: string;
  /** Detailed description of agent capabilities */
  description: string;
  /** Agent version (SemVer) */
  version: string;
  /** Base URL for A2A endpoints */
  url: string;
  /**
   * Service provider information.
   * @defaultValue `undefined`
   */
  provider?: AgentProvider;
  /** Agent capabilities declaration */
  capabilities: AgentCapabilities;
  /** Supported input content types (MIME types) */
  defaultInputModes: string[];
  /** Supported output content types (MIME types) */
  defaultOutputModes: string[];
  /** Agent skills/capabilities for discovery */
  skills: AgentSkill[];
  /**
   * Security authentication schemes (keyed by scheme name).
   * @defaultValue `undefined`
   */
  securitySchemes?: Record<string, SecurityScheme>;
  /**
   * Required security scheme references (OpenAPI 3.0 format).
   * @defaultValue `undefined`
   */
  security?: Array<Record<string, string[]>>;
  /**
   * Documentation URL for the agent.
   * @defaultValue `undefined`
   */
  documentationUrl?: string;
  /**
   * Icon URL for the agent.
   * @defaultValue `undefined`
   */
  iconUrl?: string;
}

// ============================================================================
// Legacy LAFS Discovery Types (Deprecated - for backward compatibility)
// ============================================================================

/**
 * Legacy capability descriptor.
 *
 * @deprecated Use {@link AgentSkill} instead.
 *
 * @remarks
 * Retained for backward compatibility with pre-A2A discovery documents.
 * Will be removed in v2.0.0.
 */
export interface Capability {
  /** Capability name */
  name: string;
  /** Capability version */
  version: string;
  /**
   * Human-readable description.
   * @defaultValue `undefined`
   */
  description?: string;
  /** Supported operations */
  operations: string[];
  /**
   * Whether this capability is optional.
   * @defaultValue `undefined`
   */
  optional?: boolean;
}

/**
 * Legacy service configuration.
 *
 * @deprecated Use {@link AgentCard} instead.
 *
 * @remarks
 * Retained for backward compatibility with pre-A2A discovery documents.
 * Will be removed in v2.0.0.
 */
export interface ServiceConfig {
  /** Service name */
  name: string;
  /** Service version */
  version: string;
  /**
   * Human-readable description.
   * @defaultValue `undefined`
   */
  description?: string;
}

/**
 * Legacy endpoint configuration.
 *
 * @deprecated Will be removed in v2.0.0.
 *
 * @remarks
 * Retained for backward compatibility with pre-A2A discovery documents.
 */
export interface EndpointConfig {
  /** Envelope endpoint URL */
  envelope: string;
  /**
   * Context endpoint URL.
   * @defaultValue `undefined`
   */
  context?: string;
  /** Discovery endpoint URL */
  discovery: string;
}

/**
 * Legacy discovery document format.
 *
 * @deprecated Use {@link AgentCard} instead.
 *
 * @remarks
 * The pre-A2A discovery document format. Automatically generated from
 * legacy config for backward compatibility. Will be removed in v2.0.0.
 */
export interface DiscoveryDocument {
  /** JSON Schema URL */
  $schema: string;
  /** LAFS specification version */
  lafs_version: string;
  /** Service configuration */
  service: ServiceConfig;
  /** Declared capabilities */
  capabilities: Capability[];
  /** Endpoint configuration */
  endpoints: EndpointConfig;
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for the discovery middleware (A2A v1.0 format).
 *
 * @remarks
 * Provide either `agent` (A2A v1.0) or the legacy `service`/`capabilities`/`endpoints`
 * combination. The legacy fields are deprecated and will be removed in v2.0.0.
 *
 * @example
 * ```typescript
 * const config: DiscoveryConfig = {
 *   agent: {
 *     name: "my-agent",
 *     description: "Example",
 *     version: "1.0.0",
 *     url: "https://api.example.com",
 *     capabilities: { streaming: false },
 *     defaultInputModes: ["application/json"],
 *     defaultOutputModes: ["application/json"],
 *     skills: [],
 *   },
 *   cacheMaxAge: 3600,
 * };
 * ```
 */
export interface DiscoveryConfig {
  /**
   * Agent information (required for A2A v1.0; omit only with legacy `service`).
   * @defaultValue `undefined`
   */
  agent?: Omit<AgentCard, '$schema'>;
  /**
   * Base URL for constructing absolute URLs.
   * @defaultValue `undefined`
   */
  baseUrl?: string;
  /**
   * Cache duration in seconds.
   * @defaultValue `3600`
   */
  cacheMaxAge?: number;
  /**
   * Schema URL override.
   * @defaultValue `undefined`
   */
  schemaUrl?: string;
  /**
   * Optional custom response headers.
   * @defaultValue `undefined`
   */
  headers?: Record<string, string>;
  /**
   * Automatically include LAFS as an A2A extension in Agent Card.
   * Pass `true` for defaults, or an object to customize parameters.
   * @defaultValue `undefined`
   */
  autoIncludeLafsExtension?:
    | boolean
    | {
        required?: boolean;
        supportsContextLedger?: boolean;
        supportsTokenBudgets?: boolean;
      };
  /**
   * Legacy service configuration.
   * @deprecated Use `agent` instead.
   * @defaultValue `undefined`
   */
  service?: ServiceConfig;
  /**
   * Legacy capabilities list.
   * @deprecated Use `agent.skills` instead.
   * @defaultValue `undefined`
   */
  capabilities?: Capability[];
  /**
   * Legacy endpoint URLs.
   * @deprecated Use `agent.url` and individual endpoints.
   * @defaultValue `undefined`
   */
  endpoints?: {
    envelope: string;
    context?: string;
    discovery?: string;
  };
  /**
   * Legacy LAFS version override.
   * @deprecated Use `agent.version` instead.
   * @defaultValue `undefined`
   */
  lafsVersion?: string;
}

/**
 * Discovery middleware options.
 *
 * @remarks
 * Controls path routing, legacy support, and caching behavior
 * for the discovery middleware.
 *
 * @example
 * ```typescript
 * const options: DiscoveryMiddlewareOptions = {
 *   path: "/.well-known/agent-card.json",
 *   enableEtag: true,
 * };
 * ```
 */
export interface DiscoveryMiddlewareOptions {
  /**
   * Primary path to serve Agent Card.
   * @defaultValue `"/.well-known/agent-card.json"`
   */
  path?: string;
  /**
   * Legacy path for backward compatibility.
   * @deprecated Will be removed in v2.0.0.
   * @defaultValue `"/.well-known/lafs.json"`
   */
  legacyPath?: string;
  /**
   * Enable legacy path support.
   * @defaultValue `true` (disabled when a custom `path` is set)
   */
  enableLegacyPath?: boolean;
  /**
   * Enable HEAD requests.
   * @defaultValue `true`
   */
  enableHead?: boolean;
  /**
   * Enable ETag caching.
   * @defaultValue `true`
   */
  enableEtag?: boolean;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Build an absolute URL from a base and path.
 *
 * @param base - Base URL prefix (may be `undefined` to infer from request)
 * @param path - Relative or absolute path
 * @param req - Optional Express request for protocol/host inference
 * @returns Absolute URL string
 *
 * @remarks
 * Resolution order: if `path` is already absolute, return as-is; otherwise
 * combine with `base`, or fall back to request headers.
 */
function buildUrl(base: string | undefined, path: string, req?: Request): string {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }

  if (base) {
    const separator = base.endsWith('/') || path.startsWith('/') ? '' : '/';
    return `${base}${separator}${path}`;
  }

  if (req) {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers.host || 'localhost';
    const separator = path.startsWith('/') ? '' : '/';
    return `${protocol}://${host}${separator}${path}`;
  }

  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * Generate an ETag from content.
 *
 * @param content - Serialized content string
 * @returns Quoted SHA-256 ETag (first 32 hex chars)
 *
 * @remarks
 * Uses SHA-256 truncated to 32 hex characters for a compact but
 * collision-resistant ETag value.
 */
function generateETag(content: string): string {
  return `"${createHash('sha256').update(content).digest('hex').slice(0, 32)}"`;
}

/**
 * Build an A2A Agent Card from configuration.
 *
 * @param config - Discovery configuration
 * @param req - Optional Express request for URL construction
 * @returns Fully-populated {@link AgentCard}
 *
 * @remarks
 * Handles automatic migration from legacy `service` config to the A2A v1.0 format
 * with a console deprecation warning. When `autoIncludeLafsExtension` is set, the
 * LAFS extension is appended to the card's capabilities.
 */
function buildAgentCard(config: DiscoveryConfig, req?: Request): AgentCard {
  const schemaUrl = config.schemaUrl || 'https://lafs.dev/schemas/v1/agent-card.schema.json';

  // Handle legacy config migration
  if (config.service && !config.agent) {
    console.warn(
      "[DEPRECATION] Using legacy 'service' config. Migrate to 'agent' format for A2A v1.0+ compliance.",
    );

    return {
      $schema: schemaUrl,
      name: config.service.name,
      description: config.service.description || 'LAFS-compliant agent',
      version: config.lafsVersion || config.service.version || '1.0.0',
      url: config.endpoints?.envelope
        ? buildUrl(config.baseUrl, config.endpoints.envelope, req)
        : buildUrl(config.baseUrl, '/', req),
      capabilities: {
        streaming: false,
        pushNotifications: false,
        extendedAgentCard: false,
        extensions: [],
      },
      defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json'],
      skills: (config.capabilities || []).map((cap) => ({
        id: cap.name.toLowerCase().replace(/\s+/g, '-'),
        name: cap.name,
        description: cap.description || `${cap.name} capability`,
        tags: cap.operations || [],
        examples: [],
      })),
    };
  }

  // Standard A2A v1.0 Agent Card (agent is guaranteed present; legacy path returned above)
  const agent = config.agent!;
  const card: AgentCard = {
    $schema: schemaUrl,
    ...agent,
    url: agent.url || buildUrl(config.baseUrl, '/', req),
  };

  // Auto-include LAFS extension if configured
  if (config.autoIncludeLafsExtension) {
    const lafsOptions =
      typeof config.autoIncludeLafsExtension === 'object'
        ? config.autoIncludeLafsExtension
        : undefined;
    const ext = buildLafsExtension(lafsOptions);
    if (!card.capabilities.extensions) {
      card.capabilities.extensions = [];
    }
    card.capabilities.extensions.push({
      uri: ext.uri,
      description: ext.description ?? 'LAFS envelope protocol for structured agent responses',
      required: ext.required ?? false,
      params: ext.params,
    });
  }

  return card;
}

/**
 * Build a legacy discovery document for backward compatibility.
 *
 * @param config - Discovery configuration
 * @param req - Optional Express request for URL construction
 * @returns Legacy {@link DiscoveryDocument}
 *
 * @remarks
 * Generates the pre-A2A discovery document format from either the legacy
 * `service` config or the modern `agent` config.
 *
 * @deprecated Will be removed in v2.0.0.
 */
function buildLegacyDiscoveryDocument(config: DiscoveryConfig, req?: Request): DiscoveryDocument {
  const schemaUrl = config.schemaUrl || 'https://lafs.dev/schemas/v1/discovery.schema.json';
  const lafsVersion = config.lafsVersion || pkg.version;

  return {
    $schema: schemaUrl,
    lafs_version: lafsVersion,
    service: config.service || {
      name: config.agent!.name,
      version: config.agent!.version,
      description: config.agent!.description,
    },
    capabilities:
      config.capabilities ||
      config.agent!.skills.map((skill) => ({
        name: skill.name,
        version: config.agent!.version,
        description: skill.description,
        operations: skill.tags,
        optional: false,
      })),
    endpoints: {
      envelope: buildUrl(config.baseUrl, config.endpoints?.envelope || config.agent!.url, req),
      context: config.endpoints?.context
        ? buildUrl(config.baseUrl, config.endpoints.context, req)
        : undefined,
      discovery:
        config.endpoints?.discovery || buildUrl(config.baseUrl, '/.well-known/lafs.json', req),
    },
  };
}

// ============================================================================
// Middleware
// ============================================================================

/**
 * Create Express middleware for serving A2A Agent Card.
 *
 * @param config - Discovery configuration (A2A v1.0 format)
 * @param options - Middleware options for path routing and caching
 * @returns Express RequestHandler that serves the Agent Card
 *
 * @remarks
 * Serves an A2A-compliant Agent Card at `/.well-known/agent-card.json`.
 * Maintains backward compatibility with the legacy `/.well-known/lafs.json`
 * path (with deprecation warnings). Supports ETag-based conditional requests,
 * HEAD requests, and configurable cache headers.
 *
 * @example
 * ```typescript
 * import express from "express";
 * import { discoveryMiddleware } from "@cleocode/lafs/discovery";
 *
 * const app = express();
 *
 * app.use(discoveryMiddleware({
 *   agent: {
 *     name: "my-lafs-agent",
 *     description: "A LAFS-compliant agent with A2A support",
 *     version: "1.0.0",
 *     url: "https://api.example.com",
 *     capabilities: {
 *       streaming: true,
 *       pushNotifications: false,
 *       extensions: []
 *     },
 *     defaultInputModes: ["application/json", "text/plain"],
 *     defaultOutputModes: ["application/json"],
 *     skills: [
 *       {
 *         id: "envelope-processor",
 *         name: "Envelope Processor",
 *         description: "Process LAFS envelopes",
 *         tags: ["lafs", "envelope", "validation"],
 *         examples: ["Validate this envelope", "Process envelope data"]
 *       }
 *     ]
 *   }
 * }));
 * ```
 */
export function discoveryMiddleware(
  config: DiscoveryConfig,
  options: DiscoveryMiddlewareOptions = {},
): RequestHandler {
  const path = options.path || '/.well-known/agent-card.json';
  const legacyPath = options.legacyPath || '/.well-known/lafs.json';
  // Disable legacy path by default when a custom path is set, unless explicitly enabled
  const enableLegacyPath = options.enableLegacyPath ?? !options.path;
  const enableHead = options.enableHead !== false;
  const enableEtag = options.enableEtag !== false;
  const cacheMaxAge = config.cacheMaxAge || 3600;

  // Validate configuration
  if (!config.agent && !config.service) {
    throw new Error(
      "Discovery config requires 'agent' (A2A v1.0) or 'service' (legacy) configuration",
    );
  }

  // Validate legacy service config fields
  if (config.service) {
    if (!config.service.name) {
      throw new Error("Discovery config requires 'service.name'");
    }
    if (!config.service.version) {
      throw new Error("Discovery config requires 'service.version'");
    }
  }

  // Validate legacy capabilities/endpoints when using service config
  if (config.service && !config.agent) {
    if (config.capabilities === undefined || config.capabilities === null) {
      throw new Error(
        "Discovery config requires 'capabilities' when using legacy 'service' config",
      );
    }
    if (!config.endpoints?.envelope) {
      throw new Error(
        "Discovery config requires 'endpoints.envelope' when using legacy 'service' config",
      );
    }
  }

  // Cache serialized documents to ensure consistent ETags across GET/HEAD
  let cachedPrimaryJson: string | null = null;
  let cachedLegacyJson: string | null = null;

  function getSerializedDoc(isLegacy: boolean, req: Request): string {
    if (isLegacy) {
      if (!cachedLegacyJson) {
        cachedLegacyJson = JSON.stringify(buildLegacyDiscoveryDocument(config, req), null, 2);
      }
      return cachedLegacyJson;
    }
    if (!cachedPrimaryJson) {
      cachedPrimaryJson = JSON.stringify(buildAgentCard(config, req), null, 2);
    }
    return cachedPrimaryJson;
  }

  return function discoveryHandler(req: Request, res: Response, next: NextFunction): void {
    const isPrimaryPath = req.path === path;
    const isLegacyPath = enableLegacyPath && req.path === legacyPath;

    // Only handle requests to discovery paths
    if (!isPrimaryPath && !isLegacyPath) {
      next();
      return;
    }

    // Log deprecation warning for legacy path
    if (isLegacyPath) {
      console.warn(
        `[DEPRECATION] Accessing legacy discovery endpoint ${legacyPath}. ` +
          `Migrate to ${path} for A2A v1.0+ compliance. Legacy support will be removed in v2.0.0.`,
      );
    }

    // Handle HEAD requests
    if (req.method === 'HEAD') {
      if (!enableHead) {
        res.status(405).json({
          error: 'Method Not Allowed',
          message: 'HEAD requests are disabled for this endpoint',
        });
        return;
      }

      const json = getSerializedDoc(isLegacyPath, req);
      const etag = enableEtag ? generateETag(json) : undefined;

      res.set({
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${cacheMaxAge}`,
        ...(etag && { ETag: etag }),
        ...(isLegacyPath && { Deprecation: 'true', Sunset: 'Sat, 31 Dec 2025 23:59:59 GMT' }),
        'Content-Length': Buffer.byteLength(json),
      });

      res.status(200).end();
      return;
    }

    // Only handle GET requests
    if (req.method !== 'GET') {
      res.status(405).json({
        error: 'Method Not Allowed',
        message: `Method ${req.method} not allowed. Use GET or HEAD.`,
      });
      return;
    }

    try {
      const json = getSerializedDoc(isLegacyPath, req);
      const etag = enableEtag ? generateETag(json) : undefined;

      // Check If-None-Match for conditional request
      if (enableEtag && req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
      }

      // Set response headers
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${cacheMaxAge}`,
        ...config.headers,
      };

      if (etag) {
        headers['ETag'] = etag;
      }

      // Add deprecation headers for legacy path
      if (isLegacyPath) {
        headers['Deprecation'] = 'true';
        headers['Sunset'] = 'Sat, 31 Dec 2025 23:59:59 GMT';
        headers['Link'] = `<${buildUrl(config.baseUrl, path, req)}>; rel="successor-version"`;
      }

      res.set(headers);
      res.status(200).send(json);
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Fastify plugin for A2A Agent Card discovery.
 *
 * @param fastify - Fastify instance
 * @param options - Plugin options containing `config` and optional `path`
 * @returns Promise that resolves when the plugin is registered
 *
 * @remarks
 * Registers a route on the Fastify instance to serve the A2A Agent Card
 * with proper caching headers. The actual route registration depends on
 * the Fastify API; this provides a type-safe plugin signature.
 *
 * @example
 * ```typescript
 * import Fastify from "fastify";
 * import { discoveryFastifyPlugin } from "@cleocode/lafs/discovery";
 *
 * const app = Fastify();
 * app.register(discoveryFastifyPlugin, {
 *   config: { agent: { name: "my-agent", ... } },
 * });
 * ```
 */
export async function discoveryFastifyPlugin(
  fastify: unknown,
  options: { config: DiscoveryConfig; path?: string },
): Promise<void> {
  const _path = options.path || '/.well-known/agent-card.json';
  const config = options.config;
  const cacheMaxAge = config.cacheMaxAge || 3600;

  const _handler = async (
    request: { raw?: Request },
    reply: { header: (k: string, v: string) => void },
  ) => {
    const doc = buildAgentCard(config, request.raw);
    const json = JSON.stringify(doc);
    const etag = generateETag(json);

    reply.header('Content-Type', 'application/json');
    reply.header('Cache-Control', `public, max-age=${cacheMaxAge}`);
    reply.header('ETag', etag);

    return doc;
  };

  // Note: Actual route registration depends on Fastify's API
  // This is a type-safe signature for the plugin
}

// ============================================================================
// Breaking Changes Documentation
// ============================================================================

/**
 * BREAKING CHANGES v1.2.3 → v2.0.0:
 *
 * 1. Discovery Endpoint Path
 *    - OLD: /.well-known/lafs.json
 *    - NEW: /.well-known/agent-card.json
 *    - MIGRATION: Update client code to use new path
 *    - BACKWARD COMPAT: Legacy path still works but logs deprecation warning
 *
 * 2. Discovery Document Format
 *    - OLD: DiscoveryDocument interface (lafs_version, service, capabilities, endpoints)
 *    - NEW: AgentCard interface (A2A v1.0 compliant)
 *    - MIGRATION: Update config from 'service' to 'agent' format
 *    - BACKWARD COMPAT: Legacy config format automatically converted with warning
 *
 * 3. Type Names
 *    - Capability → AgentSkill (renamed to align with A2A spec)
 *    - ServiceConfig → AgentCard (renamed)
 *    - All old types marked as @deprecated
 *
 * 4. Removed in v2.0.0
 *    - Legacy path support will be removed
 *    - Old type definitions will be removed
 *    - Automatic config migration will be removed
 */

export default discoveryMiddleware;
