/**
 * MCP Resource Endpoints for CLEO Memory
 *
 * Provides dynamic, read-only resource URIs that serve brain.db content
 * to any MCP-compatible provider. No file writing needed — data is
 * served directly from brain.db.
 *
 * Resource URIs:
 * - cleo://memory/recent     — Last 15 observations (compact)
 * - cleo://memory/learnings  — Active learnings with confidence scores
 * - cleo://memory/patterns   — Active patterns (follow/avoid)
 * - cleo://memory/handoff    — Last session handoff summary
 *
 * @task T5240
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { truncateToTokenBudget } from './budget.js';

/**
 * MCP Resource definition.
 */
export interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

/**
 * MCP Resource content response.
 */
export interface McpResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

/**
 * List all available CLEO memory resources.
 */
export function listMemoryResources(): McpResource[] {
  return [
    {
      uri: 'cleo://memory/recent',
      name: 'Recent Observations',
      description: 'Last 15 brain observations in compact format (~200-400 tokens)',
      mimeType: 'text/markdown',
    },
    {
      uri: 'cleo://memory/learnings',
      name: 'Active Learnings',
      description: 'Active brain learnings with confidence scores (~150-300 tokens)',
      mimeType: 'text/markdown',
    },
    {
      uri: 'cleo://memory/patterns',
      name: 'Active Patterns',
      description: 'Active patterns to follow or avoid (~100-200 tokens)',
      mimeType: 'text/markdown',
    },
    {
      uri: 'cleo://memory/handoff',
      name: 'Session Handoff',
      description: 'Last session handoff summary (~100-200 tokens)',
      mimeType: 'text/markdown',
    },
  ];
}

/**
 * Register MCP resource handlers on the server.
 *
 * @param server - MCP Server instance
 */
export function registerMemoryResources(server: Server): void {
  // ListResources handler
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = listMemoryResources();
    return {
      resources: resources.map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      })),
    };
  });

  // ReadResource handler
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const result = await readMemoryResource(uri);

    if (!result) {
      throw new Error(`Unknown resource URI: ${uri}`);
    }

    return {
      contents: [
        {
          uri: result.uri,
          mimeType: result.mimeType,
          text: result.text,
        },
      ],
    };
  });
}

/**
 * Read a CLEO memory resource by URI.
 *
 * @param uri - Resource URI (e.g. "cleo://memory/recent")
 * @param tokenBudget - Optional token budget for truncation
 * @returns Resource content or null if URI is unknown
 */
export async function readMemoryResource(
  uri: string,
  tokenBudget?: number,
): Promise<McpResourceContent | null> {
  // Handoff uses sessions data, not brain.db — handle separately
  if (uri === 'cleo://memory/handoff') {
    const text = await getSessionHandoff();
    return {
      uri,
      mimeType: 'text/markdown',
      text: truncateToTokenBudget(text, tokenBudget),
    };
  }

  const brainDbPath = join(process.cwd(), '.cleo', 'brain.db');
  if (!existsSync(brainDbPath)) {
    // Unknown URIs return null; known brain URIs get a helpful message
    const knownBrainUris = new Set([
      'cleo://memory/recent',
      'cleo://memory/learnings',
      'cleo://memory/patterns',
    ]);
    if (!knownBrainUris.has(uri)) {
      return null;
    }
    return {
      uri,
      mimeType: 'text/markdown',
      text: '# No Brain Data\n\nNo brain.db found. Run `cleo init` to initialize.',
    };
  }

  let text: string;

  switch (uri) {
    case 'cleo://memory/recent':
      text = await getRecentObservations();
      break;
    case 'cleo://memory/learnings':
      text = await getActiveLearnings();
      break;
    case 'cleo://memory/patterns':
      text = await getActivePatterns();
      break;
    default:
      return null;
  }

  return {
    uri,
    mimeType: 'text/markdown',
    text: truncateToTokenBudget(text, tokenBudget),
  };
}

/**
 * Get recent observations in compact markdown format.
 */
async function getRecentObservations(): Promise<string> {
  try {
    const { getBrainDb, getBrainNativeDb } = await import('../../store/brain-sqlite.js');
    await getBrainDb(process.cwd());
    const nativeDb = getBrainNativeDb();
    if (!nativeDb) return '# Recent Observations\n\nBrain database not available.';

    const rows = nativeDb
      .prepare(
        `SELECT id, type, title, created_at
         FROM brain_observations
         ORDER BY created_at DESC
         LIMIT 15`,
      )
      .all() as unknown as Array<{ id: string; type: string; title: string; created_at: string }>;

    if (rows.length === 0) {
      return '# Recent Observations\n\nNo observations recorded yet.';
    }

    const lines = ['# Recent Observations\n'];
    for (const row of rows) {
      const date = (row.created_at ?? '').slice(0, 10);
      const title = (row.title ?? '').substring(0, 90);
      lines.push(`- [${row.id}] ${date} (${row.type}): ${title}`);
    }

    return lines.join('\n');
  } catch {
    return '# Recent Observations\n\nUnable to read brain.db.';
  }
}

/**
 * Get active learnings in compact markdown format.
 */
async function getActiveLearnings(): Promise<string> {
  try {
    const { getBrainDb, getBrainNativeDb } = await import('../../store/brain-sqlite.js');
    await getBrainDb(process.cwd());
    const nativeDb = getBrainNativeDb();
    if (!nativeDb) return '# Active Learnings\n\nBrain database not available.';

    const rows = nativeDb
      .prepare(
        `SELECT id, insight, confidence, created_at
         FROM brain_learnings
         ORDER BY confidence DESC, created_at DESC
         LIMIT 15`,
      )
      .all() as unknown as Array<{ id: string; insight: string; confidence: number; created_at: string }>;

    if (rows.length === 0) {
      return '# Active Learnings\n\nNo learnings recorded yet.';
    }

    const lines = ['# Active Learnings\n'];
    for (const row of rows) {
      const conf = typeof row.confidence === 'number' ? row.confidence.toFixed(2) : String(row.confidence);
      lines.push(`- [${row.id}] (confidence: ${conf}) ${(row.insight ?? '').substring(0, 120)}`);
    }

    return lines.join('\n');
  } catch {
    return '# Active Learnings\n\nUnable to read brain.db.';
  }
}

/**
 * Get active patterns in compact markdown format.
 */
async function getActivePatterns(): Promise<string> {
  try {
    const { getBrainDb, getBrainNativeDb } = await import('../../store/brain-sqlite.js');
    await getBrainDb(process.cwd());
    const nativeDb = getBrainNativeDb();
    if (!nativeDb) return '# Active Patterns\n\nBrain database not available.';

    const rows = nativeDb
      .prepare(
        `SELECT id, pattern, type, impact, extracted_at
         FROM brain_patterns
         ORDER BY extracted_at DESC
         LIMIT 30`,
      )
      .all() as unknown as Array<{ id: string; pattern: string; type: string; impact: string; extracted_at: string }>;

    if (rows.length === 0) {
      return '# Active Patterns\n\nNo patterns recorded yet.';
    }

    const followTypes = new Set(['success', 'workflow', 'optimization']);
    const followRows = rows.filter((r) => followTypes.has(r.type));
    const avoidRows = rows.filter((r) => !followTypes.has(r.type));

    const lines = ['# Active Patterns\n'];

    if (followRows.length > 0) {
      lines.push('## Follow\n');
      for (const row of followRows) {
        lines.push(`- [${row.id}] (${row.type}, ${row.impact ?? 'medium'}): ${(row.pattern ?? '').substring(0, 120)}`);
      }
      lines.push('');
    }

    if (avoidRows.length > 0) {
      lines.push('## Avoid\n');
      for (const row of avoidRows) {
        lines.push(`- [${row.id}] AVOID (${row.type}, ${row.impact ?? 'medium'}): ${(row.pattern ?? '').substring(0, 120)}`);
      }
    }

    return lines.join('\n');
  } catch {
    return '# Active Patterns\n\nUnable to read brain.db.';
  }
}

/**
 * Get session handoff in compact markdown format.
 */
async function getSessionHandoff(): Promise<string> {
  try {
    const { getLastHandoff } = await import('../../core/sessions/handoff.js');
    const result = await getLastHandoff(process.cwd());

    if (!result) {
      return '# Session Handoff\n\nNo prior session handoff available.';
    }

    const { sessionId, handoff: h } = result;
    const lines = ['# Session Handoff\n'];

    lines.push(`- **Session**: ${sessionId}`);
    if (h.lastTask) lines.push(`- **Last task**: ${h.lastTask}`);
    if (h.tasksCompleted.length > 0) lines.push(`- **Completed**: ${h.tasksCompleted.join(', ')}`);
    if (h.tasksCreated.length > 0) lines.push(`- **Created**: ${h.tasksCreated.join(', ')}`);
    if (h.nextSuggested.length > 0) lines.push(`- **Next suggested**: ${h.nextSuggested.join(', ')}`);
    if (h.openBlockers.length > 0) lines.push(`- **Open blockers**: ${h.openBlockers.join(', ')}`);
    if (h.note) lines.push(`- **Note**: ${h.note}`);

    return lines.join('\n');
  } catch {
    return '# Session Handoff\n\nUnable to retrieve handoff data.';
  }
}

export { estimateTokens, truncateToTokenBudget } from './budget.js';
