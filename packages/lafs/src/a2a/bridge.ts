/**
 * LAFS A2A Bridge v2.0
 * 
 * Full integration with official @a2a-js/sdk for Agent-to-Agent communication.
 * Implements A2A Protocol v1.0+ specification.
 * 
 * Reference: specs/external/specification.md
 */

// ============================================================================
// Imports - Use official A2A SDK types
// ============================================================================

import {
  AGENT_CARD_PATH,
  HTTP_EXTENSION_HEADER,
} from '@a2a-js/sdk';

import type {
  Task,
  TaskState,
  TaskStatus,
  Artifact,
  Part,
  Message,
  AgentCard,
  AgentSkill,
  AgentCapabilities,
  AgentExtension,
  PushNotificationConfig,
  MessageSendConfiguration,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  SendMessageResponse,
  SendMessageSuccessResponse,
  JSONRPCErrorResponse,
  TextPart,
  DataPart,
  FilePart,
  FileWithUri,
} from '@a2a-js/sdk';

// LAFS types
import type { LAFSEnvelope, LAFSMeta } from '../types.js';

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for LAFS A2A integration
 */
export interface LafsA2AConfig {
  /** Default token budget for all operations */
  defaultBudget?: {
    maxTokens?: number;
    maxItems?: number;
    maxBytes?: number;
  };
  /** Whether to automatically wrap responses in LAFS envelopes */
  envelopeResponses?: boolean;
  /** A2A protocol version to use (default: "1.0") */
  protocolVersion?: string;
  /** Extension URIs to activate for all requests */
  defaultExtensions?: string[];
}

/**
 * Request parameters for sending messages
 */
export interface LafsSendMessageParams {
  /** Message content */
  message: {
    role: 'user' | 'agent';
    parts: Part[];
    /** Optional message metadata */
    metadata?: Record<string, unknown>;
  };
  /** A2A configuration for this request */
  configuration?: MessageSendConfiguration;
  /** Token budget override */
  budget?: {
    maxTokens?: number;
    maxItems?: number;
    maxBytes?: number;
  };
  /** Extensions to activate for this request */
  extensions?: string[];
  /** Context ID for multi-turn conversations */
  contextId?: string;
  /** Task ID for continuing existing task */
  taskId?: string;
}

// ============================================================================
// Result Wrapper
// ============================================================================

/**
 * Wrapper for A2A responses with LAFS envelope support
 */
export class LafsA2AResult {
  constructor(
    private result: SendMessageResponse,
    private config: LafsA2AConfig,
    private requestId: string
  ) {}

  /**
   * Get the raw A2A response
   */
  getA2AResult(): SendMessageResponse {
    return this.result;
  }

  /**
   * Check if result is an error
   */
  isError(): boolean {
    return 'error' in this.result;
  }

  /**
   * Get error details if result is an error
   */
  getError(): JSONRPCErrorResponse | null {
    if (this.isError()) {
      return this.result as JSONRPCErrorResponse;
    }
    return null;
  }

  /**
   * Get success result
   */
  getSuccess(): SendMessageSuccessResponse | null {
    if (!this.isError()) {
      return this.result as SendMessageSuccessResponse;
    }
    return null;
  }

  /**
   * Extract Task from response (if present)
   */
  getTask(): Task | null {
    const success = this.getSuccess();
    if (!success) return null;
    
    // Check if result is a Task (has id, contextId, status)
    const result = success.result;
    if (result && typeof result === 'object') {
      // Task objects have these properties
      if ('id' in result && 'status' in result) {
        return result as Task;
      }
    }
    return null;
  }

  /**
   * Extract Message from response (if present)
   */
  getMessage(): Message | null {
    const success = this.getSuccess();
    if (!success) return null;
    
    const result = success.result;
    if (result && typeof result === 'object') {
      // Message objects have messageId
      if ('messageId' in result && !('status' in result)) {
        return result as Message;
      }
    }
    return null;
  }

  /**
   * Check if response contains a LAFS envelope
   */
  hasLafsEnvelope(): boolean {
    return this.getLafsEnvelope() !== null;
  }

  /**
   * Extract LAFS envelope from A2A artifact
   * 
   * A2A agents can return LAFS envelopes in artifacts for structured data.
   * This method extracts the envelope from the first artifact containing one.
   */
  getLafsEnvelope(): LAFSEnvelope | null {
    const task = this.getTask();
    if (!task?.artifacts?.length) return null;

    for (const artifact of task.artifacts) {
      for (const part of artifact.parts) {
        if (this.isDataPart(part)) {
          const data = part.data;
          if (this.isLafsEnvelope(data)) {
            return data as unknown as LAFSEnvelope;
          }
        }
      }
    }

    return null;
  }

  /**
   * Get token estimate from LAFS envelope
   */
  getTokenEstimate(): { estimated: number; budget?: number; truncated?: boolean } | null {
    const envelope = this.getLafsEnvelope();
    if (!envelope?._meta) return null;
    
    // Access LAFS meta fields
    const meta = envelope._meta as LAFSMeta & { _tokenEstimate?: { estimated: number; budget?: number; truncated?: boolean } };
    return meta._tokenEstimate ?? null;
  }

  /**
   * Get task status
   */
  getTaskStatus(): TaskStatus | null {
    return this.getTask()?.status ?? null;
  }

  /**
   * Get task state
   */
  getTaskState(): TaskState | null {
    return this.getTaskStatus()?.state ?? null;
  }

  /**
   * Check if task is in a terminal state
   */
  isTerminal(): boolean {
    const state = this.getTaskState();
    if (!state) return false;
    
    const terminalStates: TaskState[] = [
      'completed',
      'failed', 
      'canceled',
      'rejected'
    ];
    return terminalStates.includes(state);
  }

  /**
   * Check if task requires input
   */
  isInputRequired(): boolean {
    return this.getTaskState() === 'input-required';
  }

  /**
   * Check if task requires authentication
   */
  isAuthRequired(): boolean {
    return this.getTaskState() === 'auth-required';
  }

  /**
   * Get all artifacts from task
   */
  getArtifacts(): Artifact[] {
    return this.getTask()?.artifacts ?? [];
  }

  private isDataPart(part: Part): part is DataPart {
    return part.kind === 'data';
  }

  private isLafsEnvelope(data: unknown): boolean {
    return (
      typeof data === 'object' &&
      data !== null &&
      '$schema' in (data as Record<string, unknown>) &&
      '_meta' in (data as Record<string, unknown>) &&
      'success' in (data as Record<string, unknown>)
    );
  }
}

// ============================================================================
// LAFS Artifact Creation Helpers
// ============================================================================

/**
 * Create a LAFS envelope artifact for A2A
 * 
 * @example
 * ```typescript
 * const envelope = createEnvelope({
 *   success: true,
 *   result: { data: '...' },
 *   meta: { operation: 'analysis.run' }
 * });
 * 
 * const artifact = createLafsArtifact(envelope);
 * task.artifacts.push(artifact);
 * ```
 */
export function createLafsArtifact(envelope: LAFSEnvelope): Artifact {
  return {
    artifactId: generateId(),
    name: 'lafs_response',
    description: 'LAFS-formatted response envelope',
    parts: [{
      kind: 'data',
      data: envelope as unknown as Record<string, unknown>,
    }],
    metadata: {
      'x-lafs-version': '2.0.0',
      'x-content-type': 'application/vnd.lafs.envelope+json',
    },
  };
}

/**
 * Create a text artifact
 */
export function createTextArtifact(text: string, name = 'text_response'): Artifact {
  const part: TextPart = {
    kind: 'text',
    text,
  };
  
  return {
    artifactId: generateId(),
    name,
    parts: [part],
  };
}

/**
 * Create a file artifact
 */
export function createFileArtifact(
  fileUrl: string,
  mediaType: string,
  filename?: string
): Artifact {
  const part: FilePart = {
    kind: 'file',
    file: {
      kind: 'uri',
      uri: fileUrl,
      mimeType: mediaType,
      ...(filename && { filename }),
    } as FileWithUri,
  };
  
  return {
    artifactId: generateId(),
    name: filename || 'file',
    parts: [part],
  };
}

function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ============================================================================
// Extension Helpers
// ============================================================================

/**
 * Check if an extension is required
 */
export function isExtensionRequired(
  agentCard: AgentCard,
  extensionUri: string
): boolean {
  return agentCard.capabilities?.extensions?.some(
    ext => ext.uri === extensionUri && ext.required
  ) ?? false;
}

/**
 * Get extension parameters
 */
export function getExtensionParams(
  agentCard: AgentCard,
  extensionUri: string
): Record<string, unknown> | undefined {
  return agentCard.capabilities?.extensions?.find(
    ext => ext.uri === extensionUri
  )?.params;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * A2A Agent Card well-known path
 * Reference: specs/external/agent-discovery.md
 */
export { AGENT_CARD_PATH };

/**
 * HTTP header for A2A Extensions
 * Reference: specs/external/extensions.md
 */
export { HTTP_EXTENSION_HEADER };

// ============================================================================
// Re-exports from A2A SDK
// ============================================================================

export type {
  Task,
  TaskState,
  TaskStatus,
  Artifact,
  Part,
  Message,
  AgentCard,
  AgentSkill,
  AgentCapabilities,
  AgentExtension,
  PushNotificationConfig,
  MessageSendConfiguration,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  SendMessageResponse,
  SendMessageSuccessResponse,
  JSONRPCErrorResponse,
  TextPart,
  DataPart,
  FilePart,
} from '@a2a-js/sdk';
