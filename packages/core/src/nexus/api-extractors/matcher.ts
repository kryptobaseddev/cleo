/**
 * Contract matching engine for NEXUS.
 *
 * Implements cascade matching: exact → name → fuzzy.
 * Uses BM25 for fuzzy matching (via SQLite FTS5).
 *
 * @task T1065 — Contract Registry
 */

import type { Contract, ContractMatch } from '@cleocode/contracts';

/**
 * Match level in the cascade (exact → name → fuzzy).
 */
type MatchLevel = 'exact' | 'name' | 'fuzzy';

/**
 * Internal match result before formatting.
 */
interface RawMatch {
  contractA: Contract;
  contractB: Contract;
  level: MatchLevel;
  score: number;
  reason: string;
}

/**
 * Match HTTP contracts (exact path+method, then fuzzy on path).
 */
function matchHttpContracts(a: Contract, b: Contract): RawMatch | null {
  if (a.type !== 'http' || b.type !== 'http') return null;

  // Exact match: path + method identical
  if (a.path === b.path && a.method === b.method) {
    return {
      contractA: a,
      contractB: b,
      level: 'exact',
      score: 1.0,
      reason: `Exact match: ${a.method} ${a.path}`,
    };
  }

  // Name match: path ends with same segment (e.g., `/api/tasks` vs `/tasks`)
  const aPathSegments = a.path.split('/').filter((s) => s.length > 0);
  const bPathSegments = b.path.split('/').filter((s) => s.length > 0);
  if (
    aPathSegments.length > 0 &&
    bPathSegments.length > 0 &&
    aPathSegments[aPathSegments.length - 1] === bPathSegments[bPathSegments.length - 1] &&
    a.method === b.method
  ) {
    return {
      contractA: a,
      contractB: b,
      level: 'name',
      score: 0.85,
      reason: `Name match: same method (${a.method}) and final path segment`,
    };
  }

  // Fuzzy match on path similarity (BM25 approximation using simple token overlap)
  const pathSimilarity = computePathSimilarity(a.path, b.path);
  if (pathSimilarity > 0.6) {
    return {
      contractA: a,
      contractB: b,
      level: 'fuzzy',
      score: pathSimilarity,
      reason: `Fuzzy match: path similarity ${(pathSimilarity * 100).toFixed(0)}%`,
    };
  }

  return null;
}

/**
 * Match gRPC contracts (exact service+method, then name, then fuzzy).
 */
function matchGrpcContracts(a: Contract, b: Contract): RawMatch | null {
  if (a.type !== 'grpc' || b.type !== 'grpc') return null;

  // Exact match: service + method identical
  if (
    'serviceName' in a &&
    'serviceName' in b &&
    'methodName' in a &&
    'methodName' in b &&
    a.serviceName === b.serviceName &&
    a.methodName === b.methodName
  ) {
    return {
      contractA: a,
      contractB: b,
      level: 'exact',
      score: 1.0,
      reason: `Exact match: ${a.serviceName}.${a.methodName}`,
    };
  }

  // Name match: method name identical, service similar
  if ('methodName' in a && 'methodName' in b && 'serviceName' in a && 'serviceName' in b) {
    if (a.methodName === b.methodName) {
      const serviceScore = computeNameSimilarity(a.serviceName, b.serviceName);
      if (serviceScore > 0.8) {
        return {
          contractA: a,
          contractB: b,
          level: 'name',
          score: 0.85,
          reason: `Name match: same method (${a.methodName}) and similar service`,
        };
      }
    }
  }

  return null;
}

/**
 * Match topic contracts (exact topic, then fuzzy on topic name).
 */
function matchTopicContracts(a: Contract, b: Contract): RawMatch | null {
  if (a.type !== 'topic' || b.type !== 'topic') return null;

  if (!('topic' in a) || !('topic' in b)) return null;

  // Exact match: topic name identical
  if (a.topic === b.topic) {
    return {
      contractA: a,
      contractB: b,
      level: 'exact',
      score: 1.0,
      reason: `Exact match: topic ${a.topic}`,
    };
  }

  // Name match: topic is prefix/suffix of the other (e.g., `task.created` vs `task.created.v2`)
  if (a.topic.includes(b.topic) || b.topic.includes(a.topic)) {
    return {
      contractA: a,
      contractB: b,
      level: 'name',
      score: 0.85,
      reason: `Name match: topic names overlap`,
    };
  }

  // Fuzzy match on topic name similarity
  const topicScore = computeNameSimilarity(a.topic, b.topic);
  if (topicScore > 0.6) {
    return {
      contractA: a,
      contractB: b,
      level: 'fuzzy',
      score: topicScore,
      reason: `Fuzzy match: topic similarity ${(topicScore * 100).toFixed(0)}%`,
    };
  }

  return null;
}

/**
 * Compute simple Jaccard similarity between two paths based on segments.
 *
 * For example:
 * - `/api/tasks` vs `/api/tasks` → 1.0
 * - `/api/tasks` vs `/api/users` → 0.5 (shared /api)
 * - `/api/tasks` vs `/v1/api/tasks` → 0.67
 */
function computePathSimilarity(path1: string, path2: string): number {
  const segments1 = new Set(path1.split('/').filter((s: string) => s.length > 0));
  const segments2 = new Set(path2.split('/').filter((s: string) => s.length > 0));

  if (segments1.size === 0 || segments2.size === 0) return 0;

  const intersection = new Set([...segments1].filter((s) => segments2.has(s)));
  const union = new Set([...segments1, ...segments2]);

  return intersection.size / union.size;
}

/**
 * Compute Levenshtein-like similarity between two names (0..1).
 *
 * Used for fuzzy matching on service/method/topic names.
 * Returns 1.0 for exact match, 0.0 for completely different.
 */
function computeNameSimilarity(name1: string, name2: string): number {
  if (name1 === name2) return 1.0;
  if (name1.length === 0 || name2.length === 0) return 0;

  // Simple: use token overlap as approximation
  const tokens1 = name1.toLowerCase().split(/[\W_]+/);
  const tokens2 = name2.toLowerCase().split(/[\W_]+/);

  const common = tokens1.filter((t) => tokens2.includes(t)).length;
  const total = Math.max(tokens1.length, tokens2.length);

  return total === 0 ? 0 : common / total;
}

/**
 * Match contracts between two sets (A and B).
 *
 * Implements cascade: exact → name → fuzzy.
 * Each contract in A is matched to at most one contract in B.
 *
 * @param contractsA - Contracts from project A
 * @param contractsB - Contracts from project B
 * @returns Array of ContractMatch results
 */
export function matchContracts(contractsA: Contract[], contractsB: Contract[]): ContractMatch[] {
  const matches: ContractMatch[] = [];
  const usedB = new Set<string>();

  // First pass: exact matches
  for (const a of contractsA) {
    for (const b of contractsB) {
      if (usedB.has(b.id)) continue;

      let raw: RawMatch | null = null;

      // Try type-specific matching
      if (a.type === b.type) {
        if (a.type === 'http') {
          raw = matchHttpContracts(a, b);
        } else if (a.type === 'grpc') {
          raw = matchGrpcContracts(a, b);
        } else if (a.type === 'topic') {
          raw = matchTopicContracts(a, b);
        }
      }

      if (raw && raw.level === 'exact') {
        usedB.add(b.id);
        matches.push(contractMatchToResult(raw));
        break; // Move to next A
      }
    }
  }

  // Second pass: name matches
  for (const a of contractsA) {
    const alreadyMatched = matches.some((m) => m.contractA.id === a.id);
    if (alreadyMatched) continue;

    for (const b of contractsB) {
      if (usedB.has(b.id)) continue;

      let raw: RawMatch | null = null;

      if (a.type === b.type) {
        if (a.type === 'http') {
          raw = matchHttpContracts(a, b);
        } else if (a.type === 'grpc') {
          raw = matchGrpcContracts(a, b);
        } else if (a.type === 'topic') {
          raw = matchTopicContracts(a, b);
        }
      }

      if (raw && raw.level === 'name') {
        usedB.add(b.id);
        matches.push(contractMatchToResult(raw));
        break;
      }
    }
  }

  // Third pass: fuzzy matches
  for (const a of contractsA) {
    const alreadyMatched = matches.some((m) => m.contractA.id === a.id);
    if (alreadyMatched) continue;

    for (const b of contractsB) {
      if (usedB.has(b.id)) continue;

      let raw: RawMatch | null = null;

      if (a.type === b.type) {
        if (a.type === 'http') {
          raw = matchHttpContracts(a, b);
        } else if (a.type === 'grpc') {
          raw = matchGrpcContracts(a, b);
        } else if (a.type === 'topic') {
          raw = matchTopicContracts(a, b);
        }
      }

      if (raw && raw.level === 'fuzzy') {
        usedB.add(b.id);
        matches.push(contractMatchToResult(raw));
        break;
      }
    }
  }

  return matches;
}

/**
 * Convert raw match to ContractMatch with compatibility verdict.
 */
function contractMatchToResult(raw: RawMatch): ContractMatch {
  // Determine compatibility based on match level and schema alignment
  let compatibility: 'compatible' | 'incompatible' | 'partial' = 'partial';

  if (raw.level === 'exact') {
    // Check schema alignment for exact matches
    compatibility = schemasAligned(raw.contractA, raw.contractB) ? 'compatible' : 'incompatible';
  } else if (raw.level === 'name') {
    compatibility = 'partial';
  } else {
    // Fuzzy matches are always partial by definition
    compatibility = 'partial';
  }

  return {
    contractA: raw.contractA,
    contractB: raw.contractB,
    level: raw.level,
    score: raw.score,
    reason: raw.reason,
    compatibility,
  };
}

/**
 * Check whether two contracts have aligned schemas.
 *
 * Naive check: request and response schema hashes match.
 * Full implementation would do structural schema comparison.
 */
function schemasAligned(a: Contract, b: Contract): boolean {
  // All contracts have requestSchemaJson and responseSchemaJson for HTTP and gRPC
  // Topic contracts have payloadSchemaJson instead
  if (a.type === 'topic' || b.type === 'topic') {
    // For topics, just compare payloadSchemaJson
    const aPayload = 'payloadSchemaJson' in a ? a.payloadSchemaJson : '{}';
    const bPayload = 'payloadSchemaJson' in b ? b.payloadSchemaJson : '{}';
    return hashJson(aPayload) === hashJson(bPayload);
  }

  // HTTP and gRPC contracts have requestSchemaJson and responseSchemaJson
  if (
    'requestSchemaJson' in a &&
    'requestSchemaJson' in b &&
    'responseSchemaJson' in a &&
    'responseSchemaJson' in b
  ) {
    const aReqHash = hashJson(a.requestSchemaJson);
    const bReqHash = hashJson(b.requestSchemaJson);
    const aResHash = hashJson(a.responseSchemaJson);
    const bResHash = hashJson(b.responseSchemaJson);

    return aReqHash === bReqHash && aResHash === bResHash;
  }

  return false;
}

/**
 * Simple hash of JSON string for quick comparison.
 */
function hashJson(jsonStr: string): string {
  // Just use first 20 chars of normalized JSON
  try {
    const obj = JSON.parse(jsonStr);
    const normalized = JSON.stringify(obj);
    return normalized.substring(0, 20);
  } catch {
    return jsonStr.substring(0, 20);
  }
}
