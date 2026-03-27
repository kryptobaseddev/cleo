// Auto-generated from error-registry.json
// Do not edit manually - run: node scripts/generate-json-types.mjs

export interface ErrorEntry {
  code: string;
  category: 'CONTRACT' | 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'SERVER' | 'TRANSPORT' | 'AUTH' | 'RATE_LIMIT' | 'TIMEOUT' | 'PAYMENT' | 'AGENT' | 'PROTOCOL' | 'HOOK';
  description: string;
  retryable: boolean;
  httpStatus: number;
  grpcStatus: string;
  cliExit: number;
  agentAction: 'stop' | 'retry' | 'retry_modified' | 'refresh_context' | 'continue' | 'escalate';
  typeUri: string;
  docUrl: string;
}

export interface ErrorRegistrySchema {
  $schema: string;
  version: string;
  codes: ErrorEntry[];
}

declare const schema: ErrorRegistrySchema;
export default schema;
