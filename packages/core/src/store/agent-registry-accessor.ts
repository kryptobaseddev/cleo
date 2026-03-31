/**
 * Agent Registry Accessor — CRUD operations for agent data in signaldock.db.
 *
 * signaldock.db is the SSoT for ALL agent data: identity, credentials,
 * capabilities, skills, transport config. No agent data lives in tasks.db.
 *
 * API keys are encrypted at rest using the crypto/credentials module.
 *
 * @see docs/specs/DATABASE-ARCHITECTURE.md
 * @task T234
 */

import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AgentCredential,
  AgentListFilter,
  AgentRegistryAPI,
  TransportConfig,
} from '@cleocode/contracts';
import { decrypt, encrypt } from '../crypto/credentials.js';
import { ensureSignaldockDb, getSignaldockDbPath } from './signaldock-sqlite.js';

const _require = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncClass } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof DatabaseSync>) => DatabaseSync;
};

/** Raw row shape from signaldock.db agents table. */
interface AgentDbRow {
  id: string;
  agent_id: string;
  name: string;
  description: string | null;
  class: string;
  privacy_tier: string;
  capabilities: string;
  skills: string;
  transport_type: string;
  api_key_encrypted: string | null;
  api_base_url: string;
  classification: string | null;
  transport_config: string;
  is_active: number;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Convert a signaldock.db row to an AgentCredential, decrypting the API key. */
async function rowToCredential(row: AgentDbRow, projectPath: string): Promise<AgentCredential> {
  const apiKey = row.api_key_encrypted ? await decrypt(row.api_key_encrypted, projectPath) : '';
  return {
    agentId: row.agent_id,
    displayName: row.name,
    apiKey,
    apiBaseUrl: row.api_base_url,
    classification: row.classification ?? undefined,
    privacyTier: row.privacy_tier as AgentCredential['privacyTier'],
    capabilities: JSON.parse(row.capabilities) as string[],
    skills: JSON.parse(row.skills) as string[],
    transportType: (row.transport_type ?? 'http') as AgentCredential['transportType'],
    transportConfig: JSON.parse(row.transport_config) as TransportConfig,
    isActive: row.is_active === 1,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at * 1000).toISOString() : undefined,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    updatedAt: new Date(row.updated_at * 1000).toISOString(),
  };
}

/** Open signaldock.db for read/write operations. Caller must close. */
function openDb(projectPath: string): DatabaseSync {
  const dbPath = getSignaldockDbPath(projectPath);
  const db = new DatabaseSyncClass(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

/**
 * Sync capabilities/skills to junction tables in signaldock.db.
 * Junction tables are the SSoT — JSON columns are materialized cache.
 */
function syncJunctionTables(
  db: DatabaseSync,
  agentUuid: string,
  capabilities: string[],
  skills: string[],
): void {
  db.prepare('DELETE FROM agent_capabilities WHERE agent_id = ?').run(agentUuid);
  db.prepare('DELETE FROM agent_skills WHERE agent_id = ?').run(agentUuid);
  for (const cap of capabilities) {
    const capRow = db.prepare('SELECT id FROM capabilities WHERE slug = ?').get(cap) as
      | { id: string }
      | undefined;
    if (capRow) {
      db.prepare(
        'INSERT OR IGNORE INTO agent_capabilities (agent_id, capability_id) VALUES (?, ?)',
      ).run(agentUuid, capRow.id);
    }
  }
  for (const skill of skills) {
    const skillRow = db.prepare('SELECT id FROM skills WHERE slug = ?').get(skill) as
      | { id: string }
      | undefined;
    if (skillRow) {
      db.prepare('INSERT OR IGNORE INTO agent_skills (agent_id, skill_id) VALUES (?, ?)').run(
        agentUuid,
        skillRow.id,
      );
    }
  }
}

/** signaldock.db implementation of the AgentRegistryAPI. */
export class AgentRegistryAccessor implements AgentRegistryAPI {
  constructor(private projectPath: string) {}

  /** Ensure signaldock.db exists with full schema before any operation. */
  private async ensureDb(): Promise<void> {
    await ensureSignaldockDb(this.projectPath);
  }

  async register(
    credential: Omit<AgentCredential, 'createdAt' | 'updatedAt'>,
  ): Promise<AgentCredential> {
    await this.ensureDb();
    const nowTs = Math.floor(Date.now() / 1000);
    const apiKeyEncrypted = credential.apiKey
      ? await encrypt(credential.apiKey, this.projectPath)
      : null;

    const db = openDb(this.projectPath);
    try {
      const existing = db
        .prepare('SELECT id FROM agents WHERE agent_id = ?')
        .get(credential.agentId) as { id: string } | undefined;

      if (!existing) {
        const id = crypto.randomUUID();
        db.prepare(
          `INSERT INTO agents (id, agent_id, name, class, privacy_tier, capabilities, skills,
           transport_type, api_key_encrypted, api_base_url, classification, transport_config,
           is_active, last_used_at, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'online', ?, ?)`,
        ).run(
          id,
          credential.agentId,
          credential.displayName,
          credential.classification ?? 'custom',
          credential.privacyTier,
          JSON.stringify(credential.capabilities),
          JSON.stringify(credential.skills),
          credential.transportType ?? 'http',
          apiKeyEncrypted,
          credential.apiBaseUrl,
          credential.classification ?? null,
          JSON.stringify(credential.transportConfig),
          credential.isActive ? 1 : 0,
          credential.lastUsedAt
            ? Math.floor(new Date(credential.lastUsedAt).getTime() / 1000)
            : null,
          nowTs,
          nowTs,
        );
        syncJunctionTables(db, id, credential.capabilities, credential.skills);
      } else {
        db.prepare(
          `UPDATE agents SET name = ?, class = ?, privacy_tier = ?, capabilities = ?, skills = ?,
           transport_type = ?, api_key_encrypted = ?, api_base_url = ?, classification = ?,
           transport_config = ?, is_active = ?, updated_at = ? WHERE agent_id = ?`,
        ).run(
          credential.displayName,
          credential.classification ?? 'custom',
          credential.privacyTier,
          JSON.stringify(credential.capabilities),
          JSON.stringify(credential.skills),
          credential.transportType ?? 'http',
          apiKeyEncrypted,
          credential.apiBaseUrl,
          credential.classification ?? null,
          JSON.stringify(credential.transportConfig),
          credential.isActive ? 1 : 0,
          nowTs,
          credential.agentId,
        );
        syncJunctionTables(db, existing.id, credential.capabilities, credential.skills);
      }
    } finally {
      db.close();
    }

    const result = await this.get(credential.agentId);
    if (!result) throw new Error(`Failed to register agent: ${credential.agentId}`);
    return result;
  }

  async get(agentId: string): Promise<AgentCredential | null> {
    await this.ensureDb();
    const db = openDb(this.projectPath);
    try {
      const row = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId) as
        | AgentDbRow
        | undefined;
      if (!row) return null;
      return rowToCredential(row, this.projectPath);
    } finally {
      db.close();
    }
  }

  async list(filter?: AgentListFilter): Promise<AgentCredential[]> {
    await this.ensureDb();
    const db = openDb(this.projectPath);
    try {
      const rows =
        filter?.active !== undefined
          ? (db
              .prepare('SELECT * FROM agents WHERE is_active = ?')
              .all(filter.active ? 1 : 0) as unknown as AgentDbRow[])
          : (db.prepare('SELECT * FROM agents').all() as unknown as AgentDbRow[]);
      return Promise.all(rows.map((row) => rowToCredential(row, this.projectPath)));
    } finally {
      db.close();
    }
  }

  async update(
    agentId: string,
    updates: Partial<Omit<AgentCredential, 'agentId' | 'createdAt'>>,
  ): Promise<AgentCredential> {
    const existing = await this.get(agentId);
    if (!existing) throw new Error(`Agent not found: ${agentId}`);

    const nowTs = Math.floor(Date.now() / 1000);
    const db = openDb(this.projectPath);
    try {
      const sets: string[] = ['updated_at = ?'];
      const params: unknown[] = [nowTs];

      if (updates.displayName !== undefined) {
        sets.push('name = ?');
        params.push(updates.displayName);
      }
      if (updates.apiBaseUrl !== undefined) {
        sets.push('api_base_url = ?');
        params.push(updates.apiBaseUrl);
      }
      if (updates.classification !== undefined) {
        sets.push('classification = ?');
        params.push(updates.classification);
      }
      if (updates.privacyTier !== undefined) {
        sets.push('privacy_tier = ?');
        params.push(updates.privacyTier);
      }
      if (updates.capabilities !== undefined) {
        sets.push('capabilities = ?');
        params.push(JSON.stringify(updates.capabilities));
      }
      if (updates.skills !== undefined) {
        sets.push('skills = ?');
        params.push(JSON.stringify(updates.skills));
      }
      if (updates.transportType !== undefined) {
        sets.push('transport_type = ?');
        params.push(updates.transportType);
      }
      if (updates.transportConfig !== undefined) {
        sets.push('transport_config = ?');
        params.push(JSON.stringify(updates.transportConfig));
      }
      if (updates.isActive !== undefined) {
        sets.push('is_active = ?');
        params.push(updates.isActive ? 1 : 0);
      }
      if (updates.apiKey !== undefined) {
        const encrypted = await encrypt(updates.apiKey, this.projectPath);
        sets.push('api_key_encrypted = ?');
        params.push(encrypted);
      }

      params.push(agentId);
      db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE agent_id = ?`).run(
        ...(params as Array<string | number | null>),
      );

      // Sync junction tables if capabilities or skills changed
      if (updates.capabilities !== undefined || updates.skills !== undefined) {
        const agentRow = db.prepare('SELECT id FROM agents WHERE agent_id = ?').get(agentId) as {
          id: string;
        };
        syncJunctionTables(
          db,
          agentRow.id,
          updates.capabilities ?? existing.capabilities,
          updates.skills ?? existing.skills,
        );
      }
    } finally {
      db.close();
    }

    const result = await this.get(agentId);
    if (!result) throw new Error(`Agent not found after update: ${agentId}`);
    return result;
  }

  async remove(agentId: string): Promise<void> {
    const existing = await this.get(agentId);
    if (!existing) throw new Error(`Agent not found: ${agentId}`);

    const db = openDb(this.projectPath);
    try {
      db.prepare('DELETE FROM agents WHERE agent_id = ?').run(agentId);
    } finally {
      db.close();
    }
  }

  async rotateKey(agentId: string): Promise<{ agentId: string; newApiKey: string }> {
    const credential = await this.get(agentId);
    if (!credential) throw new Error(`Agent not found: ${agentId}`);

    const response = await fetch(`${credential.apiBaseUrl}/agents/${agentId}/rotate-key`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.apiKey}`,
        'X-Agent-Id': agentId,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to rotate key on cloud: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { data?: { apiKey?: string } };
    const newApiKey = data.data?.apiKey;
    if (!newApiKey) throw new Error('Cloud API did not return a new API key');

    await this.update(agentId, { apiKey: newApiKey });
    return { agentId, newApiKey: `${newApiKey.substring(0, 8)}...rotated` };
  }

  async getActive(): Promise<AgentCredential | null> {
    await this.ensureDb();
    const db = openDb(this.projectPath);
    try {
      const row = db
        .prepare(
          'SELECT * FROM agents WHERE is_active = 1 ORDER BY last_used_at DESC, created_at DESC LIMIT 1',
        )
        .get() as AgentDbRow | undefined;
      if (!row) return null;
      return rowToCredential(row, this.projectPath);
    } finally {
      db.close();
    }
  }

  async markUsed(agentId: string): Promise<void> {
    await this.ensureDb();
    const nowTs = Math.floor(Date.now() / 1000);
    const db = openDb(this.projectPath);
    try {
      db.prepare('UPDATE agents SET last_used_at = ?, updated_at = ? WHERE agent_id = ?').run(
        nowTs,
        nowTs,
        agentId,
      );
    } finally {
      db.close();
    }
  }
}
