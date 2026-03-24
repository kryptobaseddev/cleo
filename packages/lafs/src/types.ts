export type LAFSTransport = "cli" | "http" | "grpc" | "sdk";

export type LAFSErrorCategory =
  | "VALIDATION"
  | "AUTH"
  | "PERMISSION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMIT"
  | "TRANSIENT"
  | "INTERNAL"
  | "CONTRACT"
  | "MIGRATION";

export interface Warning {
  code: string;
  message: string;
  deprecated?: string;
  replacement?: string;
  removeBy?: string;
}

export type MVILevel = 'minimal' | 'standard' | 'full' | 'custom';

export const MVI_LEVELS: ReadonlySet<MVILevel> = new Set<MVILevel>([
  'minimal', 'standard', 'full', 'custom',
]);

export function isMVILevel(value: unknown): value is MVILevel {
  return typeof value === 'string' && MVI_LEVELS.has(value as MVILevel);
}

export interface LAFSMeta {
  specVersion: string;
  schemaVersion: string;
  timestamp: string;
  operation: string;
  requestId: string;
  transport: LAFSTransport;
  strict: boolean;
  mvi: MVILevel;
  contextVersion: number;
  /** Session identifier for correlating multi-step agent workflows */
  sessionId?: string;
  warnings?: Warning[];
}

export type LAFSAgentAction =
  | 'retry'
  | 'retry_modified'
  | 'escalate'
  | 'stop'
  | 'wait'
  | 'refresh_context'
  | 'authenticate';

export const AGENT_ACTIONS: ReadonlySet<LAFSAgentAction> = new Set<LAFSAgentAction>([
  'retry', 'retry_modified', 'escalate', 'stop', 'wait', 'refresh_context', 'authenticate',
]);

export function isAgentAction(value: unknown): value is LAFSAgentAction {
  return typeof value === 'string' && AGENT_ACTIONS.has(value as LAFSAgentAction);
}

export interface LAFSError {
  code: string;
  message: string;
  category: LAFSErrorCategory;
  retryable: boolean;
  retryAfterMs: number | null;
  details: Record<string, unknown>;
  agentAction?: LAFSAgentAction;
  escalationRequired?: boolean;
  suggestedAction?: string;
  docUrl?: string;
}
export interface LAFSPageCursor {
  mode: "cursor";
  nextCursor: string | null;
  hasMore: boolean;
  limit?: number;
  total?: number | null;
}

export interface LAFSPageOffset {
  mode: "offset";
  limit: number;
  offset: number;
  hasMore: boolean;
  total?: number | null;
}

export interface LAFSPageNone {
  mode: "none";
}

export type LAFSPage = LAFSPageCursor | LAFSPageOffset | LAFSPageNone;

export interface ContextLedgerEntry {
  entryId: string;
  timestamp: string;
  operation: string;
  contextDelta: Record<string, unknown>;
  requestId?: string;
}

export interface ContextLedger {
  ledgerId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  entries: ContextLedgerEntry[];
  checksum: string;
  maxEntries: number;
}

export interface LAFSEnvelope {
  $schema: "https://lafs.dev/schemas/v1/envelope.schema.json";
  _meta: LAFSMeta;
  success: boolean;
  result: Record<string, unknown> | Record<string, unknown>[] | null;
  error?: LAFSError | null;
  page?: LAFSPage | null;
  _extensions?: Record<string, unknown>;
}

export interface FlagInput {
  requestedFormat?: "json" | "human";
  jsonFlag?: boolean;
  humanFlag?: boolean;
  projectDefault?: "json" | "human";
  userDefault?: "json" | "human";
  /**
   * When true, indicates the output is connected to an interactive terminal.
   * If no explicit format flag or project/user default is set, TTY terminals
   * default to `"human"` format while non-TTY (piped, CI, agents) defaults
   * to `"json"` per the LAFS protocol.
   *
   * CLI tools should pass `process.stdout.isTTY ?? false` here.
   */
  tty?: boolean;
  /** Suppress non-essential output for scripting. When true, only essential data is returned. */
  quiet?: boolean;
}

export interface ConformanceReport {
  ok: boolean;
  checks: Array<{ name: string; pass: boolean; detail?: string }>;
}

// Budget enforcement types
export type BudgetEnforcementOptions = {
  truncateOnExceed?: boolean;
  onBudgetExceeded?: (estimated: number, budget: number) => void;
};

export interface TokenEstimate {
  estimated: number;
  truncated?: boolean;
  originalEstimate?: number;
}

export interface LAFSMetaWithBudget extends LAFSMeta {
  _tokenEstimate?: TokenEstimate;
}

export interface LAFSEnvelopeWithBudget extends Omit<LAFSEnvelope, '_meta'> {
  _meta: LAFSMetaWithBudget;
}

export type MiddlewareFunction = (
  envelope: LAFSEnvelope
) => LAFSEnvelope | Promise<LAFSEnvelope>;

export type NextFunction = () => LAFSEnvelope | Promise<LAFSEnvelope>;

export type BudgetMiddleware = (
  envelope: LAFSEnvelope,
  next: NextFunction
) => Promise<LAFSEnvelope> | LAFSEnvelope;

export interface BudgetEnforcementResult {
  envelope: LAFSEnvelope;
  withinBudget: boolean;
  estimatedTokens: number;
  budget: number;
  truncated: boolean;
}
