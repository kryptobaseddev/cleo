/* tslint:disable */
/* eslint-disable */

/**
 * CANT metadata from parsed message.
 */
export class WasmCantMetadata {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Create new CANT metadata.
   *
   * # Arguments
   * * `directive_type` - "actionable", "routing", or "informational"
   * * `addresses` - JSON array of addresses
   * * `task_refs` - JSON array of task refs
   * * `tags` - JSON array of tags
   */
  constructor(directive_type: string, addresses: string, task_refs: string, tags: string);
  /**
   * Convert to JSON string.
   */
  toJson(): string;
  /**
   * Get addresses as JSON string.
   */
  readonly addresses_json: string;
  /**
   * Get the directive type.
   */
  readonly directive_type: string;
  /**
   * Get tags as JSON string.
   */
  readonly tags_json: string;
  /**
   * Get task refs as JSON string.
   */
  readonly task_refs_json: string;
}

/**
 * Conduit message for agent-to-agent communication.
 */
export class WasmConduitMessage {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Parse from JSON string.
   */
  static fromJson(json: string): WasmConduitMessage | undefined;
  /**
   * Create a new Conduit message.
   *
   * # Arguments
   * * `id` - Unique message ID
   * * `from` - Sender agent ID
   * * `content` - Message content
   * * `timestamp` - ISO 8601 timestamp
   */
  constructor(id: string, from: string, content: string, timestamp: string);
  /**
   * Convert to JSON string.
   */
  toJson(): string;
  /**
   * Get the message content.
   */
  readonly content: string;
  /**
   * Get the sender agent ID.
   */
  readonly from: string;
  /**
   * Get the message ID.
   */
  readonly id: string;
  /**
   * Get metadata as JSON string.
   */
  readonly metadata_json: string;
  /**
   * Get tags as JSON string.
   */
  readonly tags_json: string;
  /**
   * Get the timestamp.
   */
  readonly timestamp: string;
}

/**
 * Conduit connection state.
 */
export class WasmConduitState {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Create connected state.
   */
  static Connected(): WasmConduitState;
  /**
   * Create connecting state.
   */
  static Connecting(): WasmConduitState;
  /**
   * Create disconnected state.
   */
  static Disconnected(): WasmConduitState;
  /**
   * Create error state.
   */
  static Error(): WasmConduitState;
  /**
   * Create reconnecting state.
   */
  static Reconnecting(): WasmConduitState;
  /**
   * Get state as string.
   */
  readonly as_string: string;
}

/**
 * Helper function to create a Conduit state from string.
 *
 * # Arguments
 * * `state` - State string ("disconnected", "connecting", "connected", "reconnecting", "error")
 */
export function create_conduit_state(state: string): WasmConduitState;

/**
 * Helper function to parse a Conduit message from JSON.
 *
 * # Arguments
 * * `json` - JSON string representing a ConduitMessage
 */
export function parse_conduit_message(json: string): WasmConduitMessage | undefined;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_wasmconduitmessage_free: (a: number, b: number) => void;
  readonly wasmconduitmessage_new: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
  ) => number;
  readonly wasmconduitmessage_id: (a: number) => [number, number];
  readonly wasmconduitmessage_from: (a: number) => [number, number];
  readonly wasmconduitmessage_content: (a: number) => [number, number];
  readonly wasmconduitmessage_timestamp: (a: number) => [number, number];
  readonly wasmconduitmessage_tags_json: (a: number) => [number, number];
  readonly wasmconduitmessage_metadata_json: (a: number) => [number, number];
  readonly wasmconduitmessage_toJson: (a: number) => [number, number];
  readonly wasmconduitmessage_fromJson: (a: number, b: number) => number;
  readonly __wbg_wasmconduitstate_free: (a: number, b: number) => void;
  readonly wasmconduitstate_Disconnected: () => number;
  readonly wasmconduitstate_Connecting: () => number;
  readonly wasmconduitstate_Connected: () => number;
  readonly wasmconduitstate_Reconnecting: () => number;
  readonly wasmconduitstate_Error: () => number;
  readonly wasmconduitstate_as_string: (a: number) => [number, number];
  readonly __wbg_wasmcantmetadata_free: (a: number, b: number) => void;
  readonly wasmcantmetadata_new: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
  ) => number;
  readonly wasmcantmetadata_directive_type: (a: number) => [number, number];
  readonly wasmcantmetadata_addresses_json: (a: number) => [number, number];
  readonly wasmcantmetadata_task_refs_json: (a: number) => [number, number];
  readonly wasmcantmetadata_tags_json: (a: number) => [number, number];
  readonly wasmcantmetadata_toJson: (a: number) => [number, number];
  readonly parse_conduit_message: (a: number, b: number) => number;
  readonly create_conduit_state: (a: number, b: number) => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init(
  module_or_path?:
    | { module_or_path: InitInput | Promise<InitInput> }
    | InitInput
    | Promise<InitInput>,
): Promise<InitOutput>;
