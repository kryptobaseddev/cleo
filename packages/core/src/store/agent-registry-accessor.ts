/**
 * Agent Registry Accessor — CRUD operations for agent credentials in SQLite.
 *
 * Implements the `AgentRegistryAPI` contract from `@cleocode/contracts`.
 * API keys are encrypted at rest using the crypto/credentials module.
 *
 * @see docs/specs/SIGNALDOCK-UNIFIED-AGENT-REGISTRY.md Section 3
 * @task T175
 */

import type {
  AgentCredential,
  AgentListFilter,
  AgentRegistryAPI,
  TransportConfig,
} from '@cleocode/contracts';
import { desc, eq } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { decrypt, encrypt } from '../crypto/credentials.js';
import { agentCredentials } from './tasks-schema.js';

/** Convert a database row to an AgentCredential, decrypting the API key. */
async function rowToCredential(
  row: typeof agentCredentials.$inferSelect,
  projectPath: string,
): Promise<AgentCredential> {
  const apiKey = await decrypt(row.apiKeyEncrypted, projectPath);
  return {
    agentId: row.agentId,
    displayName: row.displayName,
    apiKey,
    apiBaseUrl: row.apiBaseUrl,
    classification: row.classification ?? undefined,
    privacyTier: row.privacyTier as AgentCredential['privacyTier'],
    capabilities: JSON.parse(row.capabilities) as string[],
    skills: JSON.parse(row.skills) as string[],
    transportConfig: JSON.parse(row.transportConfig) as TransportConfig,
    isActive: row.isActive,
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : undefined,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

/** SQLite implementation of the AgentRegistryAPI. */
export class AgentRegistryAccessor implements AgentRegistryAPI {
  constructor(
    private db: NodeSQLiteDatabase,
    private projectPath: string,
  ) {}

  async register(
    credential: Omit<AgentCredential, 'createdAt' | 'updatedAt'>,
  ): Promise<AgentCredential> {
    const now = Date.now();
    const apiKeyEncrypted = await encrypt(credential.apiKey, this.projectPath);

    await this.db.insert(agentCredentials).values({
      agentId: credential.agentId,
      displayName: credential.displayName,
      apiKeyEncrypted,
      apiBaseUrl: credential.apiBaseUrl,
      classification: credential.classification ?? null,
      privacyTier: credential.privacyTier,
      capabilities: JSON.stringify(credential.capabilities),
      skills: JSON.stringify(credential.skills),
      transportConfig: JSON.stringify(credential.transportConfig),
      isActive: credential.isActive,
      lastUsedAt: credential.lastUsedAt ? new Date(credential.lastUsedAt).getTime() : null,
      createdAt: now,
      updatedAt: now,
    });

    const result = await this.get(credential.agentId);
    if (!result) throw new Error(`Failed to register agent: ${credential.agentId}`);
    return result;
  }

  async get(agentId: string): Promise<AgentCredential | null> {
    const rows = await this.db
      .select()
      .from(agentCredentials)
      .where(eq(agentCredentials.agentId, agentId));

    if (rows.length === 0) return null;
    return rowToCredential(rows[0]!, this.projectPath);
  }

  async list(filter?: AgentListFilter): Promise<AgentCredential[]> {
    const query =
      filter?.active !== undefined
        ? this.db
            .select()
            .from(agentCredentials)
            .where(eq(agentCredentials.isActive, filter.active))
        : this.db.select().from(agentCredentials);

    const rows = await query;
    return Promise.all(rows.map((row) => rowToCredential(row, this.projectPath)));
  }

  async update(
    agentId: string,
    updates: Partial<Omit<AgentCredential, 'agentId' | 'createdAt'>>,
  ): Promise<AgentCredential> {
    const now = Date.now();
    const values: Record<string, unknown> = { updatedAt: now };

    if (updates.displayName !== undefined) values['displayName'] = updates.displayName;
    if (updates.apiBaseUrl !== undefined) values['apiBaseUrl'] = updates.apiBaseUrl;
    if (updates.classification !== undefined) values['classification'] = updates.classification;
    if (updates.privacyTier !== undefined) values['privacyTier'] = updates.privacyTier;
    if (updates.capabilities !== undefined)
      values['capabilities'] = JSON.stringify(updates.capabilities);
    if (updates.skills !== undefined) values['skills'] = JSON.stringify(updates.skills);
    if (updates.transportConfig !== undefined)
      values['transportConfig'] = JSON.stringify(updates.transportConfig);
    if (updates.isActive !== undefined) values['isActive'] = updates.isActive;
    if (updates.apiKey !== undefined) {
      values['apiKeyEncrypted'] = await encrypt(updates.apiKey, this.projectPath);
    }

    await this.db.update(agentCredentials).set(values).where(eq(agentCredentials.agentId, agentId));

    const result = await this.get(agentId);
    if (!result) throw new Error(`Agent not found: ${agentId}`);
    return result;
  }

  async remove(agentId: string): Promise<void> {
    await this.db.delete(agentCredentials).where(eq(agentCredentials.agentId, agentId));
  }

  async rotateKey(agentId: string): Promise<{ agentId: string; newApiKey: string }> {
    const credential = await this.get(agentId);
    if (!credential) throw new Error(`Agent not found: ${agentId}`);

    // Call cloud API to rotate key
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

    // Re-encrypt and store locally
    await this.update(agentId, { apiKey: newApiKey });

    return { agentId, newApiKey };
  }

  async getActive(): Promise<AgentCredential | null> {
    const rows = await this.db
      .select()
      .from(agentCredentials)
      .where(eq(agentCredentials.isActive, true))
      .orderBy(desc(agentCredentials.lastUsedAt))
      .limit(1);

    if (rows.length === 0) return null;
    return rowToCredential(rows[0]!, this.projectPath);
  }

  async markUsed(agentId: string): Promise<void> {
    await this.db
      .update(agentCredentials)
      .set({ lastUsedAt: Date.now(), updatedAt: Date.now() })
      .where(eq(agentCredentials.agentId, agentId));
  }
}
