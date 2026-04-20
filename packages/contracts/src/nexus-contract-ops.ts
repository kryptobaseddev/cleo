/**
 * Contract extraction and matching types for NEXUS cross-project compatibility.
 *
 * A contract represents a callable API (HTTP endpoint, gRPC service, pub/sub topic)
 * that can be extracted from source code and matched with contracts from other projects
 * to detect compatibility and integration points.
 *
 * @task T1065 — Contract Registry
 */

/**
 * HTTP contract extracted from route analysis.
 *
 * Represents a single HTTP endpoint with its path, method, and request/response schemas.
 */
export interface HttpContract {
  /** Unique contract ID (format: `http:<projectId>::<path>::<method>`) */
  id: string;

  /** Project ID this contract belongs to */
  projectId: string;

  /** Contract type — always 'http' */
  type: 'http';

  /** HTTP method (GET, POST, PUT, DELETE, PATCH, etc.) */
  method: string;

  /** Route path (e.g., `/api/v1/tasks`) */
  path: string;

  /** Request body schema as JSON string (or '{}' if no body) */
  requestSchemaJson: string;

  /** Response body schema as JSON string */
  responseSchemaJson: string;

  /** Source symbol ID (format: `<filePath>::<functionName>`) */
  sourceSymbolId: string;

  /** Route node ID from NEXUS graph */
  routeNodeId?: string;

  /** Confidence of extraction [0..1] */
  confidence: number;

  /** Human-readable summary */
  description?: string;
}

/**
 * gRPC contract extracted from proto file analysis.
 *
 * Represents a single gRPC service method.
 * Extraction may be minimal/stub on projects without .proto files.
 */
export interface GrpcContract {
  /** Unique contract ID (format: `grpc:<projectId>::<serviceName>::<methodName>`) */
  id: string;

  /** Project ID this contract belongs to */
  projectId: string;

  /** Contract type — always 'grpc' */
  type: 'grpc';

  /** Service name (e.g., `TaskService`) */
  serviceName: string;

  /** Method name (e.g., `CreateTask`) */
  methodName: string;

  /** Request message type name */
  requestMessageType: string;

  /** Response message type name */
  responseMessageType: string;

  /** Request message schema as JSON string */
  requestSchemaJson: string;

  /** Response message schema as JSON string */
  responseSchemaJson: string;

  /** Source proto file path */
  sourceProtoFile: string;

  /** Confidence of extraction [0..1] */
  confidence: number;

  /** Human-readable summary */
  description?: string;
}

/**
 * Topic/pub-sub contract extracted from message queue code patterns.
 *
 * Represents a single publish or subscribe to a message topic.
 * Extraction may be minimal/stub on projects without pub/sub patterns.
 */
export interface TopicContract {
  /** Unique contract ID (format: `topic:<projectId>::<topicName>::<direction>`) */
  id: string;

  /** Project ID this contract belongs to */
  projectId: string;

  /** Contract type — always 'topic' */
  type: 'topic';

  /** Topic name (e.g., `task.created`) */
  topic: string;

  /** Direction: 'publish' or 'subscribe' */
  direction: 'publish' | 'subscribe';

  /** Message payload schema as JSON string */
  payloadSchemaJson: string;

  /** Source symbol ID (format: `<filePath>::<functionName>`) */
  sourceSymbolId: string;

  /** Confidence of extraction [0..1] */
  confidence: number;

  /** Human-readable summary */
  description?: string;
}

/** Union type of all contract kinds */
export type Contract = HttpContract | GrpcContract | TopicContract;

/**
 * Matching level for contract compatibility.
 *
 * - 'exact': path + method match exactly (HTTP) or full signature match (gRPC)
 * - 'name': service/method names match but signatures may differ
 * - 'fuzzy': BM25 similarity above threshold on path/schema content
 */
export type ContractMatchLevel = 'exact' | 'name' | 'fuzzy';

/**
 * Result of matching two contracts.
 *
 * Indicates compatibility between a contract in project A and project B.
 */
export interface ContractMatch {
  /** Matched contract from project A */
  contractA: Contract;

  /** Matched contract from project B */
  contractB: Contract;

  /** Matching level (exact → name → fuzzy cascade) */
  level: ContractMatchLevel;

  /** Similarity score [0..1] where 1.0 is identical */
  score: number;

  /** Human-readable explanation of the match */
  reason: string;

  /** Compatibility verdict: 'compatible', 'incompatible', 'partial' */
  compatibility: 'compatible' | 'incompatible' | 'partial';

  /** Specific incompatibilities if any (e.g., schema mismatches) */
  incompatibilities?: string[];
}

/**
 * Contract compatibility matrix between two projects.
 *
 * Result of `cleo nexus contracts show --project-a <p> --project-b <p>`.
 */
export interface ContractCompatibilityMatrix {
  /** Project A ID */
  projectAId: string;

  /** Project B ID */
  projectBId: string;

  /** All matched contracts */
  matches: ContractMatch[];

  /** Count of compatible matches */
  compatibleCount: number;

  /** Count of incompatible matches */
  incompatibleCount: number;

  /** Count of partial/unresolved matches */
  partialCount: number;

  /** Overall compatibility percentage */
  overallCompatibility: number;

  /** Recommendations for integration */
  recommendations: string[];
}

/**
 * Result of extracting contracts from a project.
 *
 * Returned by contract extractors.
 */
export interface ContractExtractionResult {
  /** Project ID */
  projectId: string;

  /** HTTP contracts found */
  httpContracts: HttpContract[];

  /** gRPC contracts found */
  grpcContracts: GrpcContract[];

  /** Topic/pub-sub contracts found */
  topicContracts: TopicContract[];

  /** Total contracts extracted */
  totalCount: number;

  /** Any extraction warnings or notes */
  notes: string[];
}

/**
 * Result of linking contracts to affected tasks.
 *
 * When a contract's source symbol is touched by a task (via task_touches_symbol edge),
 * we emit a contract_affected_by_task annotation.
 */
export interface ContractTaskLink {
  /** Contract ID */
  contractId: string;

  /** Task ID that affects this contract */
  taskId: string;

  /** Type of change (modified, added, removed) */
  changeType: 'modified' | 'added' | 'removed';

  /** Timestamp of the linkage */
  linkedAt: string;
}
