/**
 * Provider-aware token measurement and persistence.
 *
 * Central SSoT for CLI/MCP/tooling token estimation with a three-layer chain:
 * 1) OTel/provider telemetry when available
 * 2) Exact tokenizer for supported models
 * 3) Heuristic fallback calibrated for JSON vs text payloads
 *
 * @task T5618
 * @why CLEO needs a provider-aware in-house token service instead of relying on a single external runtime.
 * @what Adds central token measurement, persistence, CRUD, and summary helpers for CLI, MCP, tests, and telemetry tooling.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { and, count, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { getDb } from '../../store/sqlite.js';
import { tokenUsage, type NewTokenUsageRow, type TokenUsageRow } from '../../store/tasks-schema.js';
import { getCleoHome } from '../paths.js';
import { resolveProviderFromModelRegistry } from './model-provider-registry.js';
import { detectRuntimeProviderContext } from './provider-detection.js';

export type TokenMethod = 'otel' | 'provider_api' | 'tokenizer' | 'heuristic';
export type TokenConfidence = 'real' | 'high' | 'estimated' | 'coarse';
export type TokenTransport = 'cli' | 'mcp' | 'api' | 'agent' | 'unknown';

export interface TokenExchangeInput {
  requestPayload?: unknown;
  responsePayload?: unknown;
  provider?: string;
  model?: string;
  transport?: TokenTransport;
  gateway?: string;
  domain?: string;
  operation?: string;
  sessionId?: string;
  taskId?: string;
  requestId?: string;
  cwd?: string;
  metadata?: Record<string, unknown>;
}

export interface TokenMeasurement {
  inputChars: number;
  outputChars: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  method: TokenMethod;
  confidence: TokenConfidence;
  provider: string;
  model?: string;
  requestHash?: string;
  responseHash?: string;
  metadata: Record<string, unknown>;
}

export interface TokenUsageFilters {
  provider?: string;
  transport?: TokenTransport;
  gateway?: string;
  domain?: string;
  operation?: string;
  sessionId?: string;
  taskId?: string;
  method?: TokenMethod;
  confidence?: TokenConfidence;
  requestId?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface TokenUsageSummary {
  totalRecords: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  byMethod: Array<{ method: string; count: number; totalTokens: number }>;
  byTransport: Array<{ transport: string; count: number; totalTokens: number }>;
  byOperation: Array<{ key: string; count: number; totalTokens: number }>;
}

function normalizeProvider(provider?: string, model?: string, runtimeProvider?: string): string {
  const value = (provider ?? '').trim().toLowerCase();
  const modelValue = (model ?? '').trim().toLowerCase();
  const runtimeValue = (runtimeProvider ?? '').trim().toLowerCase();

  if (value) return value;
  if (modelValue.startsWith('gpt') || modelValue.startsWith('o1') || modelValue.startsWith('o3') || modelValue.startsWith('text-embedding')) {
    return 'openai';
  }
  if (modelValue.includes('claude')) return 'anthropic';
  if (modelValue.includes('gemini')) return 'google';
  if (runtimeValue) return runtimeValue;
  return 'unknown';
}

async function resolveMeasurementProvider(input: TokenExchangeInput): Promise<{
  provider: string;
  source: string;
  candidates?: string[];
}> {
  const runtime = detectRuntimeProviderContext({ cwd: input.cwd });

  const explicit = (input.provider ?? '').trim().toLowerCase();
  if (explicit) {
    return { provider: explicit, source: 'explicit' };
  }

  const fromRegistry = await resolveProviderFromModelRegistry(input.model);
  if (fromRegistry.provider) {
    return {
      provider: fromRegistry.provider,
      source: fromRegistry.source,
      candidates: fromRegistry.candidates,
    };
  }

  const fallback = normalizeProvider(undefined, input.model, runtime.inferredModelProvider);
  return {
    provider: fallback,
    source: fallback === 'unknown' ? 'unknown' : (runtime.inferredModelProvider ? 'runtime-vendor' : 'heuristic'),
    candidates: fromRegistry.candidates,
  };
}

function buildRuntimeMetadata(input: TokenExchangeInput): Record<string, unknown> {
  const runtime = detectRuntimeProviderContext({ cwd: input.cwd });
  return {
    runtimeProviderId: runtime.runtimeProviderId,
    runtimeToolName: runtime.runtimeToolName,
    runtimeVendor: runtime.runtimeVendor,
    runtimeInstructionFile: runtime.runtimeInstructionFile,
    runtimeProjectDetected: runtime.runtimeProjectDetected,
    runtimeDetectionMethods: runtime.runtimeDetectionMethods,
    runtimeCandidates: runtime.runtimeCandidates,
  };
}

function toText(payload: unknown): string {
  if (payload === undefined || payload === null) return '';
  if (typeof payload === 'string') return payload;
  return JSON.stringify(payload);
}

function isLikelyJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return true;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function heuristicTokens(text: string): number {
  if (!text) return 0;
  const divisor = isLikelyJson(text) ? 3.5 : 4;
  return Math.max(1, Math.ceil(text.length / divisor));
}

function hashText(text: string): string | undefined {
  if (!text) return undefined;
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function getOtelDir(): string {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '';
  if (endpoint.startsWith('file://')) {
    return endpoint.slice('file://'.length);
  }
  return join(getCleoHome(), 'metrics', 'otel');
}

function readOtelJsonl(dir: string): Array<Record<string, unknown>> {
  if (!existsSync(dir)) return [];
  const entries: Array<Record<string, unknown>> = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json') && !file.endsWith('.jsonl')) continue;
    const filePath = join(dir, file);
    const raw = readFileSync(filePath, 'utf-8').trim();
    if (!raw) continue;
    for (const line of raw.split('\n')) {
      try {
        entries.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Skip malformed OTel lines.
      }
    }
  }
  return entries;
}

function readOtelTokenUsage(input: TokenExchangeInput, resolvedProvider: string, providerSource: string, providerCandidates?: string[]): TokenMeasurement | null {
  const dir = getOtelDir();
  const events = readOtelJsonl(dir);
  if (events.length === 0) return null;

  const matched = events.find((entry) => {
    const name = String(entry['name'] ?? '');
    if (name !== 'claude_code.api_request') return false;
    const attrs = (entry['attributes'] ?? {}) as Record<string, unknown>;
    if (input.requestId && attrs['request_id'] === input.requestId) return true;
    if (input.sessionId && attrs['session_id'] === input.sessionId) return true;
    return false;
  });

  if (!matched) return null;

  const attrs = (matched['attributes'] ?? {}) as Record<string, unknown>;
  const inputTokens = Number(attrs['input_tokens'] ?? 0);
  const outputTokens = Number(attrs['output_tokens'] ?? 0);
  if (inputTokens <= 0 && outputTokens <= 0) return null;

  const requestText = toText(input.requestPayload);
  const responseText = toText(input.responsePayload);
  return {
    inputChars: requestText.length,
    outputChars: responseText.length,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    method: 'otel',
    confidence: 'real',
    provider: resolvedProvider,
    model: input.model,
    requestHash: hashText(requestText),
    responseHash: hashText(responseText),
    metadata: {
      otelDir: dir,
      providerSource,
      providerCandidates,
      cacheReadInputTokens: Number(attrs['cache_read_input_tokens'] ?? 0),
      cacheCreationInputTokens: Number(attrs['cache_creation_input_tokens'] ?? 0),
      ...buildRuntimeMetadata(input),
    },
  };
}

async function tokenizerCount(text: string, provider: string, model?: string): Promise<number | null> {
  if (!text) return 0;
  if (provider !== 'openai') return null;
  try {
    const mod = await import('js-tiktoken');
    const encoding = model && 'encodingForModel' in mod
      ? (mod as { encodingForModel: (name: string) => { encode: (value: string) => number[] } }).encodingForModel(model)
      : (mod as { getEncoding: (name: string) => { encode: (value: string) => number[] } }).getEncoding('cl100k_base');
    return encoding.encode(text).length;
  } catch {
    return null;
  }
}

async function measureByTokenizer(
  input: TokenExchangeInput,
  provider: string,
  providerSource: string,
  providerCandidates?: string[],
): Promise<TokenMeasurement | null> {
  const requestText = toText(input.requestPayload);
  const responseText = toText(input.responsePayload);
  const inputTokens = await tokenizerCount(requestText, provider, input.model);
  const outputTokens = await tokenizerCount(responseText, provider, input.model);

  if (inputTokens === null || outputTokens === null) return null;

  return {
    inputChars: requestText.length,
    outputChars: responseText.length,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    method: 'tokenizer',
    confidence: 'high',
    provider,
    model: input.model,
    requestHash: hashText(requestText),
    responseHash: hashText(responseText),
    metadata: {
      tokenizer: 'js-tiktoken',
      providerSource,
      providerCandidates,
      ...buildRuntimeMetadata(input),
    },
  };
}

function measureByHeuristic(
  input: TokenExchangeInput,
  provider: string,
  providerSource: string,
  providerCandidates?: string[],
): TokenMeasurement {
  const requestText = toText(input.requestPayload);
  const responseText = toText(input.responsePayload);
  const requestKind = isLikelyJson(requestText) ? 'json' : 'text';
  const responseKind = isLikelyJson(responseText) ? 'json' : 'text';

  const inputTokens = heuristicTokens(requestText);
  const outputTokens = heuristicTokens(responseText);

  return {
    inputChars: requestText.length,
    outputChars: responseText.length,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    method: 'heuristic',
    confidence: 'estimated',
    provider,
    model: input.model,
    requestHash: hashText(requestText),
    responseHash: hashText(responseText),
    metadata: {
      requestKind,
      responseKind,
      heuristic: 'chars/3.5-json-or-4-text',
      providerSource,
      providerCandidates,
      ...buildRuntimeMetadata(input),
    },
  };
}

export async function measureTokenExchange(input: TokenExchangeInput): Promise<TokenMeasurement> {
  const providerResolution = await resolveMeasurementProvider(input);
  const otel = readOtelTokenUsage(
    input,
    providerResolution.provider,
    providerResolution.source,
    providerResolution.candidates,
  );
  if (otel) return otel;

  const tokenizer = await measureByTokenizer(
    input,
    providerResolution.provider,
    providerResolution.source,
    providerResolution.candidates,
  );
  if (tokenizer) return tokenizer;

  return measureByHeuristic(
    input,
    providerResolution.provider,
    providerResolution.source,
    providerResolution.candidates,
  );
}

function whereClauses(filters: TokenUsageFilters): Array<ReturnType<typeof eq>> {
  const clauses = [] as Array<ReturnType<typeof eq>>;
  if (filters.provider) clauses.push(eq(tokenUsage.provider, filters.provider));
  if (filters.transport) clauses.push(eq(tokenUsage.transport, filters.transport));
  if (filters.gateway) clauses.push(eq(tokenUsage.gateway, filters.gateway));
  if (filters.domain) clauses.push(eq(tokenUsage.domain, filters.domain));
  if (filters.operation) clauses.push(eq(tokenUsage.operation, filters.operation));
  if (filters.sessionId) clauses.push(eq(tokenUsage.sessionId, filters.sessionId));
  if (filters.taskId) clauses.push(eq(tokenUsage.taskId, filters.taskId));
  if (filters.method) clauses.push(eq(tokenUsage.method, filters.method));
  if (filters.confidence) clauses.push(eq(tokenUsage.confidence, filters.confidence));
  if (filters.requestId) clauses.push(eq(tokenUsage.requestId, filters.requestId));
  if (filters.since) clauses.push(gte(tokenUsage.createdAt, filters.since));
  if (filters.until) clauses.push(lte(tokenUsage.createdAt, filters.until));
  return clauses;
}

export async function recordTokenExchange(input: TokenExchangeInput): Promise<TokenUsageRow> {
  const measurement = await measureTokenExchange(input);
  const db = await getDb(input.cwd);

  const row: NewTokenUsageRow = {
    id: randomUUID(),
    provider: measurement.provider,
    model: measurement.model,
    transport: input.transport ?? 'unknown',
    gateway: input.gateway,
    domain: input.domain,
    operation: input.operation,
    sessionId: input.sessionId,
    taskId: input.taskId,
    requestId: input.requestId,
    inputChars: measurement.inputChars,
    outputChars: measurement.outputChars,
    inputTokens: measurement.inputTokens,
    outputTokens: measurement.outputTokens,
    totalTokens: measurement.totalTokens,
    method: measurement.method,
    confidence: measurement.confidence,
    requestHash: measurement.requestHash,
    responseHash: measurement.responseHash,
    metadataJson: JSON.stringify({
      ...measurement.metadata,
      ...(input.metadata ?? {}),
    }),
  };

  await db.insert(tokenUsage).values(row);
  const inserted = await db.select().from(tokenUsage).where(eq(tokenUsage.id, row.id!)).limit(1);
  return inserted[0]!;
}

export async function showTokenUsage(id: string, cwd?: string): Promise<TokenUsageRow | null> {
  const db = await getDb(cwd);
  const rows = await db.select().from(tokenUsage).where(eq(tokenUsage.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listTokenUsage(filters: TokenUsageFilters = {}, cwd?: string): Promise<{ records: TokenUsageRow[]; total: number; filtered: number }> {
  const db = await getDb(cwd);
  const clauses = whereClauses(filters);
  const where = clauses.length > 0 ? and(...clauses) : undefined;

  const totalRows = await db.select({ count: count() }).from(tokenUsage);
  const filteredRows = await db.select({ count: count() }).from(tokenUsage).where(where);

  let query = db.select().from(tokenUsage).orderBy(desc(tokenUsage.createdAt));
  if (where) query = query.where(where) as typeof query;

  const limit = typeof filters.limit === 'number' && filters.limit > 0 ? filters.limit : 20;
  const offset = typeof filters.offset === 'number' && filters.offset > 0 ? filters.offset : 0;
  const records = await query.limit(limit).offset(offset);

  return {
    records,
    total: totalRows[0]?.count ?? 0,
    filtered: filteredRows[0]?.count ?? 0,
  };
}

export async function summarizeTokenUsage(filters: TokenUsageFilters = {}, cwd?: string): Promise<TokenUsageSummary> {
  const db = await getDb(cwd);
  const clauses = whereClauses(filters);
  const where = clauses.length > 0 ? and(...clauses) : undefined;
  const rows = await db.select().from(tokenUsage).where(where).orderBy(desc(tokenUsage.createdAt));

  const byMethod = new Map<string, { count: number; totalTokens: number }>();
  const byTransport = new Map<string, { count: number; totalTokens: number }>();
  const byOperation = new Map<string, { count: number; totalTokens: number }>();

  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;

  for (const row of rows) {
    inputTokens += row.inputTokens;
    outputTokens += row.outputTokens;
    totalTokens += row.totalTokens;

    const methodStats = byMethod.get(row.method) ?? { count: 0, totalTokens: 0 };
    methodStats.count += 1;
    methodStats.totalTokens += row.totalTokens;
    byMethod.set(row.method, methodStats);

    const transportStats = byTransport.get(row.transport) ?? { count: 0, totalTokens: 0 };
    transportStats.count += 1;
    transportStats.totalTokens += row.totalTokens;
    byTransport.set(row.transport, transportStats);

    const opKey = [row.domain, row.operation].filter(Boolean).join('.') || 'unknown';
    const opStats = byOperation.get(opKey) ?? { count: 0, totalTokens: 0 };
    opStats.count += 1;
    opStats.totalTokens += row.totalTokens;
    byOperation.set(opKey, opStats);
  }

  return {
    totalRecords: rows.length,
    inputTokens,
    outputTokens,
    totalTokens,
    byMethod: Array.from(byMethod.entries()).map(([method, stats]) => ({ method, ...stats })),
    byTransport: Array.from(byTransport.entries()).map(([transport, stats]) => ({ transport, ...stats })),
    byOperation: Array.from(byOperation.entries()).map(([key, stats]) => ({ key, ...stats })),
  };
}

export async function deleteTokenUsage(id: string, cwd?: string): Promise<{ deleted: boolean; id: string }> {
  const db = await getDb(cwd);
  await db.delete(tokenUsage).where(eq(tokenUsage.id, id));
  return { deleted: true, id };
}

export async function clearTokenUsage(filters: TokenUsageFilters = {}, cwd?: string): Promise<{ deleted: number }> {
  const db = await getDb(cwd);
  const clauses = whereClauses(filters);
  const where = clauses.length > 0 ? and(...clauses) : undefined;
  const countRows = await db.select({ count: count() }).from(tokenUsage).where(where);
  await db.delete(tokenUsage).where(where);
  return { deleted: countRows[0]?.count ?? 0 };
}

export async function autoRecordDispatchTokenUsage(input: TokenExchangeInput): Promise<void> {
  try {
    await recordTokenExchange(input);
  } catch {
    // Token telemetry must never break core CLI/MCP flows.
  }
}

export async function getLatestTokenRecord(cwd?: string): Promise<TokenUsageRow | null> {
  const db = await getDb(cwd);
  const rows = await db.select().from(tokenUsage).orderBy(desc(tokenUsage.createdAt)).limit(1);
  return rows[0] ?? null;
}

export async function getTokenUsageAggregateSql(cwd?: string): Promise<Array<{ provider: string; transport: string; totalTokens: number; count: number }>> {
  const db = await getDb(cwd);
  return db
    .select({
      provider: tokenUsage.provider,
      transport: tokenUsage.transport,
      totalTokens: sql<number>`sum(${tokenUsage.totalTokens})`,
      count: sql<number>`count(*)`,
    })
    .from(tokenUsage)
    .groupBy(tokenUsage.provider, tokenUsage.transport)
    .orderBy(desc(sql<number>`sum(${tokenUsage.totalTokens})`));
}
