/**
 * Role-specific accessor implementations for conduit, nexus, signaldock, and telemetry.
 *
 * These provide typed accessor interfaces over the existing role-specific DB modules.
 * The implementations are minimal — full API surfaces live in the role-specific
 * sqlite modules.
 *
 * @task T9188
 * @epic T9048
 * @see packages/contracts/src/sub-accessors.ts (accessor interfaces)
 */

import type {
  AgentRegistrySubAccessor,
  ConduitAccessor,
  NexusAccessor,
  TelemetryAccessor,
} from '@cleocode/contracts';
import { resolveOrCwd } from '../paths.js';

// ---------------------------------------------------------------------------
// ConduitAccessor
// ---------------------------------------------------------------------------

/**
 * Create a ConduitAccessor for the given project root.
 *
 * Wraps conduit-sqlite module functions behind the typed interface.
 *
 * @param projectRoot - Project root for resolving conduit.db path.
 * @returns A ConduitAccessor instance.
 * @task T9188
 */
export function createConduitAccessor(projectRoot?: string): ConduitAccessor {
  const cwd = resolveOrCwd(projectRoot);

  return {
    async publish(topic: string, payload: unknown): Promise<void> {
      const { ensureConduitDb, getConduitNativeDb } = await import('./conduit-sqlite.js');
      await ensureConduitDb(cwd);
      const db = getConduitNativeDb();
      if (!db) throw new Error('ConduitAccessor: conduit.db not initialized');

      // Best-effort publish into the prefixed conduit_messages table (T11578 ·
      // AC4). `created_at` is canonical TEXT ISO-8601 (CHECK enforces the ISO
      // GLOB), so write ISO not epoch. The conversation_id is a synthetic
      // `topic-*` value with no parent row; under FK enforcement the insert may
      // throw — the surrounding try/catch keeps publish a graceful no-op.
      try {
        const payload_str = JSON.stringify(payload);
        db.prepare(
          `INSERT OR IGNORE INTO conduit_messages (id, from_agent_id, to_agent_id, conversation_id, content, content_type, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `conduit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          'system',
          topic,
          `topic-${topic}`,
          payload_str,
          'application/json',
          'pending',
          new Date().toISOString(),
        );
      } catch {
        // conduit_messages may not exist yet (conduit not initialized) or the
        // synthetic conversation_id may violate the FK — graceful no-op.
      }
    },

    async ping(): Promise<boolean> {
      try {
        const { ensureConduitDb, getConduitNativeDb } = await import('./conduit-sqlite.js');
        await ensureConduitDb(cwd);
        const db = getConduitNativeDb();
        if (!db) return false;
        db.prepare('SELECT 1').get();
        return true;
      } catch {
        return false;
      }
    },

    async close(): Promise<void> {
      // conduit-sqlite manages its own singleton lifecycle.
    },
  };
}

// ---------------------------------------------------------------------------
// NexusAccessor
// ---------------------------------------------------------------------------

/**
 * Create a NexusAccessor for the given project root.
 *
 * Wraps nexus-sqlite module functions behind the typed interface.
 *
 * @param projectRoot - Project root (unused — nexus.db is global-scope).
 * @returns A NexusAccessor instance.
 * @task T9188
 */
export function createNexusAccessor(_projectRoot?: string): NexusAccessor {
  return {
    async ping(): Promise<boolean> {
      try {
        const { getNexusDb } = await import('./nexus-sqlite.js');
        // getNexusDb returns a Drizzle DB — use the $client for raw ping.
        const drizzleDb = await getNexusDb();
        if (!drizzleDb) return false;
        const raw = (
          drizzleDb as { $client?: { prepare?: (sql: string) => { get: () => unknown } } }
        ).$client;
        if (!raw?.prepare) return false;
        raw.prepare('SELECT 1').get();
        return true;
      } catch {
        return false;
      }
    },

    async close(): Promise<void> {
      // nexus-sqlite manages its own singleton lifecycle.
    },
  };
}

// ---------------------------------------------------------------------------
// AgentRegistrySubAccessor
// ---------------------------------------------------------------------------

/**
 * Create a AgentRegistrySubAccessor.
 *
 * Wraps signaldock-sqlite module functions behind the typed interface.
 *
 * @returns A AgentRegistrySubAccessor instance.
 * @task T9188
 */
export function createAgentRegistrySubAccessor(): AgentRegistrySubAccessor {
  return {
    async ping(): Promise<boolean> {
      try {
        const { ensureGlobalAgentRegistryDb, getGlobalAgentRegistryNativeDb } = await import(
          './agent-registry-store.js'
        );
        await ensureGlobalAgentRegistryDb();
        const db = getGlobalAgentRegistryNativeDb();
        if (!db) return false;
        db.prepare('SELECT 1').get();
        return true;
      } catch {
        return false;
      }
    },

    async close(): Promise<void> {
      // signaldock-sqlite manages its own singleton lifecycle.
    },
  };
}

// ---------------------------------------------------------------------------
// TelemetryAccessor
// ---------------------------------------------------------------------------

/**
 * Create a TelemetryAccessor.
 *
 * Telemetry DB is a future concern (no backing DB yet). This implementation
 * is a no-op stub that satisfies the interface and logs to stderr in verbose mode.
 *
 * @returns A TelemetryAccessor instance.
 * @task T9188
 */
export function createTelemetryAccessor(): TelemetryAccessor {
  return {
    async record(event: string, data?: Record<string, unknown>): Promise<void> {
      // Telemetry DB not yet implemented. Future: write to telemetry.db.
      // For now, silently no-op to avoid breaking callers.
      if (process.env['CLEO_DEBUG_TELEMETRY']) {
        process.stderr.write(`[telemetry] ${event} ${JSON.stringify(data ?? {})}\n`);
      }
    },

    async ping(): Promise<boolean> {
      // No telemetry DB yet — always pings as false.
      return false;
    },

    async close(): Promise<void> {
      // No resources to release.
    },
  };
}
