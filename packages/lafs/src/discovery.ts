/**
 * LAFS Agent Discovery - Express/Fastify Middleware
 * Serves A2A-compliant Agent Card at /.well-known/agent-card.json
 * Maintains backward compatibility with legacy /.well-known/lafs.json
 * 
 * A2A v1.0+ Compliant Implementation
 * Reference: specs/external/agent-discovery.md
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { createRequire } from "node:module";
import { createHash } from "crypto";
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
 * A2A Agent Provider information
 */
export interface AgentProvider {
  /** Organization URL */
  url: string;
  /** Organization name */
  organization: string;
}

/**
 * A2A Agent Capabilities
 */
export interface AgentCapabilities {
  /** Supports streaming responses */
  streaming?: boolean;
  /** Supports push notifications */
  pushNotifications?: boolean;
  /** Supports extended agent card */
  extendedAgentCard?: boolean;
  /** Supported extensions */
  extensions?: AgentExtension[];
}

/**
 * A2A Agent Extension declaration
 */
export interface AgentExtension {
  /** Extension URI (unique identifier) */
  uri: string;
  /** Human-readable description */
  description: string;
  /** Whether the extension is required */
  required: boolean;
  /** Extension-specific parameters */
  params?: Record<string, unknown>;
}

/**
 * A2A Agent Skill
 */
export interface AgentSkill {
  /** Skill unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Detailed description */
  description: string;
  /** Keywords/tags for the skill */
  tags: string[];
  /** Example prompts */
  examples?: string[];
  /** Supported input modes (overrides agent defaults) */
  inputModes?: string[];
  /** Supported output modes (overrides agent defaults) */
  outputModes?: string[];
}

/**
 * Security scheme for authentication (OpenAPI 3.0 style)
 */
export interface SecurityScheme {
  type: "http" | "apiKey" | "oauth2" | "openIdConnect";
  description?: string;
  scheme?: string;
  bearerFormat?: string;
}

/**
 * A2A v1.0 Agent Card - Standard format for agent discovery
 * Reference: specs/external/specification.md Section 5
 */
export interface AgentCard {
  /** JSON Schema URL */
  $schema?: string;
  /** Human-readable agent name */
  name: string;
  /** Detailed description of agent capabilities */
  description: string;
  /** Agent version (SemVer) */
  version: string;
  /** Base URL for A2A endpoints */
  url: string;
  /** Service provider information */
  provider?: AgentProvider;
  /** Agent capabilities */
  capabilities: AgentCapabilities;
  /** Supported input content types */
  defaultInputModes: string[];
  /** Supported output content types */
  defaultOutputModes: string[];
  /** Agent skills/capabilities */
  skills: AgentSkill[];
  /** Security authentication schemes */
  securitySchemes?: Record<string, SecurityScheme>;
  /** Required security schemes */
  security?: Array<Record<string, string[]>>;
  /** Documentation URL */
  documentationUrl?: string;
  /** Icon URL */
  iconUrl?: string;
}

// ============================================================================
// Legacy LAFS Discovery Types (Deprecated - for backward compatibility)
// ============================================================================

/**
 * @deprecated Use AgentSkill instead
 */
export interface Capability {
  name: string;
  version: string;
  description?: string;
  operations: string[];
  optional?: boolean;
}

/**
 * @deprecated Use AgentCard instead
 */
export interface ServiceConfig {
  name: string;
  version: string;
  description?: string;
}

/**
 * @deprecated Will be removed in v2.0.0
 */
export interface EndpointConfig {
  envelope: string;
  context?: string;
  discovery: string;
}

/**
 * @deprecated Use AgentCard instead
 */
export interface DiscoveryDocument {
  $schema: string;
  lafs_version: string;
  service: ServiceConfig;
  capabilities: Capability[];
  endpoints: EndpointConfig;
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for the discovery middleware (A2A v1.0 format)
 */
export interface DiscoveryConfig {
  /** Agent information (required for A2A v1.0; omit only with legacy 'service') */
  agent?: Omit<AgentCard, '$schema'>;
  /** Base URL for constructing absolute URLs */
  baseUrl?: string;
  /** Cache duration in seconds (default: 3600) */
  cacheMaxAge?: number;
  /** Schema URL override */
  schemaUrl?: string;
  /** Optional custom headers */
  headers?: Record<string, string>;
  /**
   * Automatically include LAFS as an A2A extension in Agent Card.
   * Pass `true` for defaults, or an object to customize parameters.
   */
  autoIncludeLafsExtension?: boolean | {
    required?: boolean;
    supportsContextLedger?: boolean;
    supportsTokenBudgets?: boolean;
  };
  /**
   * @deprecated Use 'agent' instead
   */
  service?: ServiceConfig;
  /**
   * @deprecated Use 'agent.skills' instead
   */
  capabilities?: Capability[];
  /**
   * @deprecated Use 'agent.url' and individual endpoints
   */
  endpoints?: {
    envelope: string;
    context?: string;
    discovery?: string;
  };
  /**
   * @deprecated Use 'agent.version' instead
   */
  lafsVersion?: string;
}

/**
 * Discovery middleware options
 */
export interface DiscoveryMiddlewareOptions {
  /** 
   * Primary path to serve Agent Card (default: /.well-known/agent-card.json)
   */
  path?: string;
  /**
   * Legacy path for backward compatibility (default: /.well-known/lafs.json)
   * @deprecated Will be removed in v2.0.0
   */
  legacyPath?: string;
  /** Enable legacy path support (default: true) */
  enableLegacyPath?: boolean;
  /** Enable HEAD requests (default: true) */
  enableHead?: boolean;
  /** Enable ETag caching (default: true) */
  enableEtag?: boolean;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Build absolute URL from base and path
 */
function buildUrl(base: string | undefined, path: string, req?: Request): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  
  if (base) {
    const separator = base.endsWith("/") || path.startsWith("/") ? "" : "/";
    return `${base}${separator}${path}`;
  }
  
  if (req) {
    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const host = req.headers.host || "localhost";
    const separator = path.startsWith("/") ? "" : "/";
    return `${protocol}://${host}${separator}${path}`;
  }
  
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * Generate ETag from content
 */
function generateETag(content: string): string {
  return `"${createHash("sha256").update(content).digest("hex").slice(0, 32)}"`;
}

/**
 * Build A2A Agent Card from configuration
 */
function buildAgentCard(
  config: DiscoveryConfig,
  req?: Request
): AgentCard {
  const schemaUrl = config.schemaUrl || "https://lafs.dev/schemas/v1/agent-card.schema.json";
  
  // Handle legacy config migration
  if (config.service && !config.agent) {
    console.warn("[DEPRECATION] Using legacy 'service' config. Migrate to 'agent' format for A2A v1.0+ compliance.");
    
    return {
      $schema: schemaUrl,
      name: config.service.name,
      description: config.service.description || "LAFS-compliant agent",
      version: config.lafsVersion || config.service.version || "1.0.0",
      url: config.endpoints?.envelope 
        ? buildUrl(config.baseUrl, config.endpoints.envelope, req)
        : buildUrl(config.baseUrl, "/", req),
      capabilities: {
        streaming: false,
        pushNotifications: false,
        extendedAgentCard: false,
        extensions: []
      },
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
      skills: (config.capabilities || []).map(cap => ({
        id: cap.name.toLowerCase().replace(/\s+/g, "-"),
        name: cap.name,
        description: cap.description || `${cap.name} capability`,
        tags: cap.operations || [],
        examples: []
      }))
    };
  }
  
  // Standard A2A v1.0 Agent Card (agent is guaranteed present; legacy path returned above)
  const agent = config.agent!;
  const card: AgentCard = {
    $schema: schemaUrl,
    ...agent,
    url: agent.url || buildUrl(config.baseUrl, "/", req)
  };

  // Auto-include LAFS extension if configured
  if (config.autoIncludeLafsExtension) {
    const lafsOptions = typeof config.autoIncludeLafsExtension === 'object'
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
 * Build legacy discovery document for backward compatibility
 * @deprecated Will be removed in v2.0.0
 */
function buildLegacyDiscoveryDocument(
  config: DiscoveryConfig,
  req?: Request
): DiscoveryDocument {
  const schemaUrl = config.schemaUrl || "https://lafs.dev/schemas/v1/discovery.schema.json";
  const lafsVersion = config.lafsVersion || pkg.version;
  
  return {
    $schema: schemaUrl,
    lafs_version: lafsVersion,
    service: config.service || {
      name: config.agent!.name,
      version: config.agent!.version,
      description: config.agent!.description
    },
    capabilities: config.capabilities || config.agent!.skills.map(skill => ({
      name: skill.name,
      version: config.agent!.version,
      description: skill.description,
      operations: skill.tags,
      optional: false
    })),
    endpoints: {
      envelope: buildUrl(config.baseUrl, config.endpoints?.envelope || config.agent!.url, req),
      context: config.endpoints?.context ? buildUrl(config.baseUrl, config.endpoints.context, req) : undefined,
      discovery: config.endpoints?.discovery || buildUrl(config.baseUrl, "/.well-known/lafs.json", req)
    }
  };
}

// ============================================================================
// Middleware
// ============================================================================

/**
 * Create Express middleware for serving A2A Agent Card
 * 
 * Serves A2A-compliant Agent Card at /.well-known/agent-card.json
 * Maintains backward compatibility with legacy /.well-known/lafs.json
 * 
 * @param config - Discovery configuration (A2A v1.0 format)
 * @param options - Middleware options
 * @returns Express RequestHandler
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
  options: DiscoveryMiddlewareOptions = {}
): RequestHandler {
  const path = options.path || "/.well-known/agent-card.json";
  const legacyPath = options.legacyPath || "/.well-known/lafs.json";
  // Disable legacy path by default when a custom path is set, unless explicitly enabled
  const enableLegacyPath = options.enableLegacyPath ?? !options.path;
  const enableHead = options.enableHead !== false;
  const enableEtag = options.enableEtag !== false;
  const cacheMaxAge = config.cacheMaxAge || 3600;
  
  // Validate configuration
  if (!config.agent && !config.service) {
    throw new Error("Discovery config requires 'agent' (A2A v1.0) or 'service' (legacy) configuration");
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
      throw new Error("Discovery config requires 'capabilities' when using legacy 'service' config");
    }
    if (!config.endpoints?.envelope) {
      throw new Error("Discovery config requires 'endpoints.envelope' when using legacy 'service' config");
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

  return function discoveryHandler(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const isPrimaryPath = req.path === path;
    const isLegacyPath = enableLegacyPath && req.path === legacyPath;

    // Only handle requests to discovery paths
    if (!isPrimaryPath && !isLegacyPath) {
      next();
      return;
    }

    // Log deprecation warning for legacy path
    if (isLegacyPath) {
      console.warn(`[DEPRECATION] Accessing legacy discovery endpoint ${legacyPath}. ` +
        `Migrate to ${path} for A2A v1.0+ compliance. Legacy support will be removed in v2.0.0.`);
    }

    // Handle HEAD requests
    if (req.method === "HEAD") {
      if (!enableHead) {
        res.status(405).json({
          error: "Method Not Allowed",
          message: "HEAD requests are disabled for this endpoint"
        });
        return;
      }

      const json = getSerializedDoc(isLegacyPath, req);
      const etag = enableEtag ? generateETag(json) : undefined;

      res.set({
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${cacheMaxAge}`,
        ...(etag && { "ETag": etag }),
        ...(isLegacyPath && { "Deprecation": "true", "Sunset": "Sat, 31 Dec 2025 23:59:59 GMT" }),
        "Content-Length": Buffer.byteLength(json)
      });

      res.status(200).end();
      return;
    }

    // Only handle GET requests
    if (req.method !== "GET") {
      res.status(405).json({
        error: "Method Not Allowed",
        message: `Method ${req.method} not allowed. Use GET or HEAD.`
      });
      return;
    }

    try {
      const json = getSerializedDoc(isLegacyPath, req);
      const etag = enableEtag ? generateETag(json) : undefined;
      
      // Check If-None-Match for conditional request
      if (enableEtag && req.headers["if-none-match"] === etag) {
        res.status(304).end();
        return;
      }
      
      // Set response headers
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${cacheMaxAge}`,
        ...config.headers
      };
      
      if (etag) {
        headers["ETag"] = etag;
      }
      
      // Add deprecation headers for legacy path
      if (isLegacyPath) {
        headers["Deprecation"] = "true";
        headers["Sunset"] = "Sat, 31 Dec 2025 23:59:59 GMT";
        headers["Link"] = `<${buildUrl(config.baseUrl, path, req)}>; rel="successor-version"`;
      }
      
      res.set(headers);
      res.status(200).send(json);
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Fastify plugin for A2A Agent Card discovery
 * 
 * @param fastify - Fastify instance
 * @param options - Plugin options
 */
export async function discoveryFastifyPlugin(
  fastify: unknown,
  options: { config: DiscoveryConfig; path?: string }
): Promise<void> {
  const path = options.path || "/.well-known/agent-card.json";
  const config = options.config;
  const cacheMaxAge = config.cacheMaxAge || 3600;
  
  const handler = async (request: { raw?: Request }, reply: { header: (k: string, v: string) => void }) => {
    const doc = buildAgentCard(config, request.raw);
    const json = JSON.stringify(doc);
    const etag = generateETag(json);
    
    reply.header("Content-Type", "application/json");
    reply.header("Cache-Control", `public, max-age=${cacheMaxAge}`);
    reply.header("ETag", etag);
    
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
