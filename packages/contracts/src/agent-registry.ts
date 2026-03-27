/**
 * Agent Registry — Credential management and lifecycle for registered agents.
 *
 * Provides typed CRUD operations for agent credentials stored in the
 * local project database (`.cleo/tasks.db`). API keys are encrypted at
 * rest using AES-256-GCM with a machine-bound key.
 *
 * @see docs/specs/SIGNALDOCK-UNIFIED-AGENT-REGISTRY.md Section 3
 * @module agent-registry
 */

// ============================================================================
// Transport configuration
// ============================================================================

/** Transport-specific configuration stored per agent credential. */
export interface TransportConfig {
  /** Polling interval in milliseconds (for HTTP polling transport). */
  pollIntervalMs?: number;
  /** SSE endpoint URL (for Server-Sent Events transport). */
  sseEndpoint?: string;
  /** WebSocket URL (for WebSocket transport). */
  wsUrl?: string;
  /** HTTP polling endpoint path (for HTTP polling transport). */
  pollEndpoint?: string;
}

// ============================================================================
// Agent credential
// ============================================================================

/** A registered agent's credentials and profile. */
export interface AgentCredential {
  /** Unique agent identifier (e.g. 'cleo-core', 'forge-ts-opus'). */
  agentId: string;
  /** Human-readable display name. */
  displayName: string;
  /** API key for authentication (`sk_live_*`). Stored encrypted at rest. */
  apiKey: string;
  /** Base URL of the messaging API. Interim: api.clawmsgr.com. Target: api.signaldock.io. */
  apiBaseUrl: string;
  /** Agent classification from the registry (e.g. 'code_dev', 'orchestrator'). */
  classification?: string;
  /** Privacy tier controlling discoverability. */
  privacyTier: 'public' | 'discoverable' | 'private';
  /** Agent capabilities (e.g. ['chat', 'tools', 'code-execution']). */
  capabilities: string[];
  /** Agent skills (e.g. ['coding', 'review', 'testing']). */
  skills: string[];
  /** Transport-specific configuration. */
  transportConfig: TransportConfig;
  /** Whether this agent is currently active. */
  isActive: boolean;
  /** ISO 8601 timestamp of last use (polling, sending, etc.). */
  lastUsedAt?: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last update timestamp. */
  updatedAt: string;
}

// ============================================================================
// Registry API
// ============================================================================

/** Filter options for listing agent credentials. */
export interface AgentListFilter {
  /** Filter by active/inactive status. */
  active?: boolean;
}

/** CRUD and lifecycle operations for agent credentials. */
export interface AgentRegistryAPI {
  /** Register a new agent credential. */
  register(credential: Omit<AgentCredential, 'createdAt' | 'updatedAt'>): Promise<AgentCredential>;

  /** Get a single agent credential by ID. Returns null if not found. */
  get(agentId: string): Promise<AgentCredential | null>;

  /** List agent credentials with optional filtering. */
  list(filter?: AgentListFilter): Promise<AgentCredential[]>;

  /** Update fields on an existing agent credential. */
  update(
    agentId: string,
    updates: Partial<Omit<AgentCredential, 'agentId' | 'createdAt'>>,
  ): Promise<AgentCredential>;

  /** Remove an agent credential permanently. */
  remove(agentId: string): Promise<void>;

  /** Rotate an agent's API key (generates new key on cloud, re-encrypts locally). */
  rotateKey(agentId: string): Promise<{ agentId: string; newApiKey: string }>;

  /** Get the most recently used active agent credential. Returns null if none. */
  getActive(): Promise<AgentCredential | null>;

  /** Mark an agent as recently used (updates `lastUsedAt`). */
  markUsed(agentId: string): Promise<void>;
}
