/**
 * LAFS A2A Bridge v2.0
 *
 * Full integration with official @a2a-js/sdk for Agent-to-Agent communication.
 * Implements A2A Protocol v1.0+ specification.
 *
 * @remarks
 * Provides the core bridge between LAFS envelopes and A2A protocol types.
 * Includes a result wrapper ({@link LafsA2AResult}) for extracting typed data
 * from A2A responses, artifact creation helpers for LAFS envelopes, text, and
 * files, and extension introspection utilities.
 *
 * Reference: specs/external/specification.md
 */

// ============================================================================
// Imports - Use official A2A SDK types
// ============================================================================

import type {
  AgentCard,
  Artifact,
  DataPart,
  FilePart,
  FileWithUri,
  JSONRPCErrorResponse,
  Message,
  MessageSendConfiguration,
  Part,
  SendMessageResponse,
  SendMessageSuccessResponse,
  Task,
  TaskState,
  TaskStatus,
  TextPart,
} from '@a2a-js/sdk';
import { AGENT_CARD_PATH, HTTP_EXTENSION_HEADER } from '@a2a-js/sdk';

// LAFS types
import type { LAFSEnvelope, LAFSMeta } from '../types.js';

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for LAFS A2A integration.
 *
 * @remarks
 * Controls default token budgets, envelope wrapping behavior, protocol
 * version, and extension activation for all A2A operations.
 */
export interface LafsA2AConfig {
  /**
   * Default token budget for all operations.
   * @defaultValue undefined
   */
  defaultBudget?: {
    /** Maximum number of tokens allowed */
    maxTokens?: number;
    /** Maximum number of items allowed */
    maxItems?: number;
    /** Maximum number of bytes allowed */
    maxBytes?: number;
  };
  /**
   * Whether to automatically wrap responses in LAFS envelopes.
   * @defaultValue undefined
   */
  envelopeResponses?: boolean;
  /**
   * A2A protocol version to use.
   * @defaultValue undefined
   */
  protocolVersion?: string;
  /**
   * Extension URIs to activate for all requests.
   * @defaultValue undefined
   */
  defaultExtensions?: string[];
}

/**
 * Request parameters for sending messages.
 *
 * @remarks
 * Encapsulates the message content, A2A configuration, token budget,
 * extension activation, and conversation context for a single send
 * operation.
 */
export interface LafsSendMessageParams {
  /** Message content including role, parts, and optional metadata */
  message: {
    /** Role of the message sender */
    role: 'user' | 'agent';
    /** Content parts composing the message */
    parts: Part[];
    /**
     * Optional message metadata.
     * @defaultValue undefined
     */
    metadata?: Record<string, unknown>;
  };
  /**
   * A2A configuration for this request.
   * @defaultValue undefined
   */
  configuration?: MessageSendConfiguration;
  /**
   * Token budget override for this request.
   * @defaultValue undefined
   */
  budget?: {
    /** Maximum number of tokens allowed */
    maxTokens?: number;
    /** Maximum number of items allowed */
    maxItems?: number;
    /** Maximum number of bytes allowed */
    maxBytes?: number;
  };
  /**
   * Extensions to activate for this request.
   * @defaultValue undefined
   */
  extensions?: string[];
  /**
   * Context ID for multi-turn conversations.
   * @defaultValue undefined
   */
  contextId?: string;
  /**
   * Task ID for continuing existing task.
   * @defaultValue undefined
   */
  taskId?: string;
}

// ============================================================================
// Result Wrapper
// ============================================================================

/**
 * Wrapper for A2A responses with LAFS envelope support.
 *
 * @remarks
 * Provides typed accessors for extracting tasks, messages, LAFS envelopes,
 * token estimates, and state information from raw A2A `SendMessageResponse`
 * objects. All methods are null-safe and return `null` when the expected
 * data is not present.
 */
export class LafsA2AResult {
  /**
   * Create a LafsA2AResult wrapper.
   *
   * @param result - Raw A2A SendMessageResponse to wrap
   * @param _config - LAFS A2A configuration (reserved for future use)
   * @param _requestId - Request ID for correlation (reserved for future use)
   */
  constructor(
    private result: SendMessageResponse,
    _config: LafsA2AConfig,
    _requestId: string,
  ) {}

  /**
   * Get the raw A2A response.
   *
   * @returns The underlying SendMessageResponse object
   */
  getA2AResult(): SendMessageResponse {
    return this.result;
  }

  /**
   * Check if the result is an error response.
   *
   * @returns True if the response contains a JSON-RPC error
   */
  isError(): boolean {
    return 'error' in this.result;
  }

  /**
   * Get error details if the result is an error.
   *
   * @returns The JSON-RPC error response, or null if the result is a success
   */
  getError(): JSONRPCErrorResponse | null {
    if (this.isError()) {
      return this.result as JSONRPCErrorResponse;
    }
    return null;
  }

  /**
   * Get the success result.
   *
   * @returns The success response, or null if the result is an error
   */
  getSuccess(): SendMessageSuccessResponse | null {
    if (!this.isError()) {
      return this.result as SendMessageSuccessResponse;
    }
    return null;
  }

  /**
   * Extract a Task from the response (if present).
   *
   * @remarks
   * Checks the success result for an object with `id` and `status` properties,
   * which identifies it as a Task rather than a Message.
   *
   * @returns The extracted Task, or null if not present or result is an error
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
   * Extract a Message from the response (if present).
   *
   * @remarks
   * Checks the success result for an object with `messageId` but without
   * `status`, which distinguishes it from a Task.
   *
   * @returns The extracted Message, or null if not present or result is an error
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
   * Check if the response contains a LAFS envelope.
   *
   * @returns True if a LAFS envelope was found in the task's artifacts
   */
  hasLafsEnvelope(): boolean {
    return this.getLafsEnvelope() !== null;
  }

  /**
   * Extract a LAFS envelope from A2A artifact.
   *
   * @remarks
   * A2A agents can return LAFS envelopes in artifacts for structured data.
   * This method scans all artifacts for a DataPart containing an object
   * with `$schema`, `_meta`, and `success` fields (the LAFS envelope shape).
   *
   * @returns The first LAFS envelope found, or null if none present
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
   * Get token estimate from LAFS envelope.
   *
   * @remarks
   * Extracts the `_tokenEstimate` field from the LAFS envelope's `_meta`
   * section, which contains estimated token usage, budget, and truncation
   * information.
   *
   * @returns Token estimate object, or null if no envelope or no estimate present
   */
  getTokenEstimate(): { estimated: number; budget?: number; truncated?: boolean } | null {
    const envelope = this.getLafsEnvelope();
    if (!envelope?._meta) return null;

    // Access LAFS meta fields
    const meta = envelope._meta as LAFSMeta & {
      _tokenEstimate?: { estimated: number; budget?: number; truncated?: boolean };
    };
    return meta._tokenEstimate ?? null;
  }

  /**
   * Get the task status.
   *
   * @returns The task's current status, or null if no task is present
   */
  getTaskStatus(): TaskStatus | null {
    return this.getTask()?.status ?? null;
  }

  /**
   * Get the task state.
   *
   * @returns The task's current state string, or null if no task is present
   */
  getTaskState(): TaskState | null {
    return this.getTaskStatus()?.state ?? null;
  }

  /**
   * Check if the task is in a terminal state.
   *
   * @remarks
   * Terminal states are `completed`, `failed`, `canceled`, and `rejected`.
   *
   * @returns True if the task is in a terminal state, false otherwise or if no task is present
   */
  isTerminal(): boolean {
    const state = this.getTaskState();
    if (!state) return false;

    const terminalStates: TaskState[] = ['completed', 'failed', 'canceled', 'rejected'];
    return terminalStates.includes(state);
  }

  /**
   * Check if the task requires user input.
   *
   * @returns True if the task state is `input-required`
   */
  isInputRequired(): boolean {
    return this.getTaskState() === 'input-required';
  }

  /**
   * Check if the task requires authentication.
   *
   * @returns True if the task state is `auth-required`
   */
  isAuthRequired(): boolean {
    return this.getTaskState() === 'auth-required';
  }

  /**
   * Get all artifacts from the task.
   *
   * @returns Array of task artifacts, or empty array if no task or no artifacts
   */
  getArtifacts(): Artifact[] {
    return this.getTask()?.artifacts ?? [];
  }

  /** Type guard: checks whether a Part is a DataPart by inspecting its `kind` field. */
  private isDataPart(part: Part): part is DataPart {
    return part.kind === 'data';
  }

  /** Heuristic check: returns true if the data object looks like a LAFS envelope (has `$schema`, `_meta`, `success`). */
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
 * Create a LAFS envelope artifact for A2A.
 *
 * @remarks
 * Wraps a LAFS envelope in an A2A Artifact with a DataPart. The artifact
 * is tagged with LAFS version and content type metadata for identification
 * by consumers.
 *
 * @param envelope - LAFS envelope to wrap as an artifact
 * @returns A2A Artifact containing the envelope as a DataPart
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
    parts: [
      {
        kind: 'data',
        data: envelope as unknown as Record<string, unknown>,
      },
    ],
    metadata: {
      'x-lafs-version': '2.0.0',
      'x-content-type': 'application/vnd.lafs.envelope+json',
    },
  };
}

/**
 * Create a text artifact.
 *
 * @remarks
 * Wraps a plain text string in an A2A Artifact with a TextPart.
 *
 * @param text - Text content for the artifact
 * @param name - Display name for the artifact
 * @returns A2A Artifact containing the text as a TextPart
 *
 * @example
 * ```typescript
 * const artifact = createTextArtifact('Hello, world!', 'greeting');
 * ```
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
 * Create a file artifact.
 *
 * @remarks
 * Wraps a file URI in an A2A Artifact with a FilePart. The media type
 * and optional filename are included for proper content handling by
 * consumers.
 *
 * @param fileUrl - URI pointing to the file resource
 * @param mediaType - MIME type of the file (e.g., `application/pdf`)
 * @param filename - Optional display filename for the artifact
 * @returns A2A Artifact containing the file reference as a FilePart
 *
 * @example
 * ```typescript
 * const artifact = createFileArtifact(
 *   'https://example.com/report.pdf',
 *   'application/pdf',
 *   'report.pdf',
 * );
 * ```
 */
export function createFileArtifact(
  fileUrl: string,
  mediaType: string,
  filename?: string,
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
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ============================================================================
// Extension Helpers
// ============================================================================

/**
 * Check if an extension is required in an Agent Card.
 *
 * @remarks
 * Scans the agent card's declared extensions for one matching the given
 * URI with `required: true`.
 *
 * @param agentCard - Agent Card to inspect
 * @param extensionUri - URI of the extension to check
 * @returns True if the extension is declared as required
 *
 * @example
 * ```typescript
 * if (isExtensionRequired(agentCard, LAFS_EXTENSION_URI)) {
 *   console.log('LAFS extension is mandatory for this agent');
 * }
 * ```
 */
export function isExtensionRequired(agentCard: AgentCard, extensionUri: string): boolean {
  return (
    agentCard.capabilities?.extensions?.some((ext) => ext.uri === extensionUri && ext.required) ??
    false
  );
}

/**
 * Get extension parameters from an Agent Card.
 *
 * @remarks
 * Finds the extension matching the given URI and returns its `params` object.
 *
 * @param agentCard - Agent Card to inspect
 * @param extensionUri - URI of the extension to look up
 * @returns The extension's params object, or undefined if not found
 *
 * @example
 * ```typescript
 * const params = getExtensionParams(agentCard, LAFS_EXTENSION_URI);
 * if (params?.supportsTokenBudgets) {
 *   // Enable budget tracking
 * }
 * ```
 */
export function getExtensionParams(
  agentCard: AgentCard,
  extensionUri: string,
): Record<string, unknown> | undefined {
  return agentCard.capabilities?.extensions?.find((ext) => ext.uri === extensionUri)?.params;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * A2A Agent Card well-known path.
 *
 * @remarks
 * The standard path `/.well-known/agent-card.json` where A2A Agent Cards
 * are published. Re-exported from the A2A SDK.
 *
 * Reference: specs/external/agent-discovery.md
 */
/**
 * HTTP header for A2A Extensions.
 *
 * @remarks
 * Used to communicate extension activation between client and agent.
 * Re-exported from the A2A SDK.
 *
 * Reference: specs/external/extensions.md
 */
export { AGENT_CARD_PATH, HTTP_EXTENSION_HEADER };

// ============================================================================
// Re-exports from A2A SDK
// ============================================================================

export type {
  AgentCapabilities,
  AgentCard,
  AgentExtension,
  AgentSkill,
  Artifact,
  DataPart,
  FilePart,
  JSONRPCErrorResponse,
  Message,
  MessageSendConfiguration,
  Part,
  PushNotificationConfig,
  SendMessageResponse,
  SendMessageSuccessResponse,
  Task,
  TaskArtifactUpdateEvent,
  TaskState,
  TaskStatus,
  TaskStatusUpdateEvent,
  TextPart,
} from '@a2a-js/sdk';
