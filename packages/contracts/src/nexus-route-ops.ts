/**
 * Route and API shape analysis contracts for NEXUS.
 *
 * Routes are first-class nodes in the code graph (kind: 'route').
 * This module defines the query results for route mapping and shape checking.
 *
 * @task T1064 — Route-Map and Shape-Check Commands
 */

/**
 * A single route handler entry from `route-map`.
 *
 * Maps a route node to its handler functions and downstream dependencies.
 */
export interface RouteMapEntry {
  /** Route node ID (format: `<filePath>::<routeName>`). */
  routeId: string;

  /** Route handler function symbol ID. */
  handlerId: string;

  /** Human-readable handler name. */
  handlerName: string;

  /** File path of the handler (relative to project root). */
  handlerFile: string;

  /** Source language (typescript, python, etc.). */
  language: string;

  /** Route metadata from metaJson (method, path, etc.). */
  routeMeta: {
    /** HTTP method (GET, POST, PUT, DELETE, PATCH). */
    method?: string;

    /** Route path pattern (e.g., `/api/v1/tasks`). */
    path?: string;

    /** Additional metadata fields. */
    [key: string]: unknown;
  };

  /** Symbols/modules fetched by this handler (external dependencies). */
  fetchedDeps: Array<{
    /** Dependency target symbol or module name. */
    target: string;

    /** Relation type (fetches, imports, calls). */
    relationType: string;

    /** Confidence score [0..1]. */
    confidence: number;
  }>;

  /** Count of downstream callers of this handler. */
  callerCount: number;
}

/**
 * Result of `route-map` command — all routes with handlers and deps.
 */
export interface RouteMapResult {
  /** Project ID the routes belong to. */
  projectId: string;

  /** All routes with their handlers and dependencies. */
  routes: RouteMapEntry[];

  /** Count of route nodes analyzed. */
  routeCount: number;

  /** Count of handler functions found. */
  handlerCount: number;

  /** External dependencies (distinct modules/specs fetched). */
  distinctDeps: string[];
}

/**
 * Shape compatibility verdict from `shape-check`.
 */
export type ShapeCheckStatus = 'compatible' | 'incompatible' | 'partial' | 'unknown';

/**
 * A single caller of a route handler and its expected response shape.
 */
export interface ShapeCheckCaller {
  /** Caller symbol ID. */
  callerId: string;

  /** Caller name. */
  callerName: string;

  /** File path of the caller. */
  callerFile: string;

  /** Inferred expected response shape (from return type or usage). */
  expectedShape: string;

  /** Compatibility status versus the route's declared shape. */
  status: ShapeCheckStatus;

  /** Human-readable diagnosis. */
  diagnosis: string;
}

/**
 * Result of `shape-check` command — route's shape vs all callers.
 */
export interface ShapeCheckResult {
  /** Route symbol ID being checked. */
  routeId: string;

  /** Route handler symbol ID. */
  handlerId: string;

  /** Declared response shape from meta_json or return type. */
  declaredShape: string;

  /** All callers and their expected shapes. */
  callers: ShapeCheckCaller[];

  /** Count of compatible callers. */
  compatibleCount: number;

  /** Count of incompatible callers. */
  incompatibleCount: number;

  /** Overall compatibility status. */
  overallStatus: ShapeCheckStatus;

  /** Recommendation. */
  recommendation: string;
}
