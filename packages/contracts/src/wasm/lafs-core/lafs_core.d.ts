/* tslint:disable */
/* eslint-disable */

/**
 * LAFS envelope - the main response type.
 */
export class WasmLafsEnvelope {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Create an error envelope.
   *
   * # Arguments
   * * `code` - Error code string
   * * `message` - Error message
   * * `meta` - LAFS metadata
   */
  static createError(code: string, message: string, meta: WasmLafsMeta): WasmLafsEnvelope;
  /**
   * Create a success envelope.
   *
   * # Arguments
   * * `data` - JSON string of the result data
   * * `meta` - LAFS metadata
   */
  static createSuccess(data: string, meta: WasmLafsMeta): WasmLafsEnvelope;
  /**
   * Get the error as a JSON string.
   */
  readonly error_json: string;
  /**
   * Get the metadata as a JSON string.
   */
  readonly meta_json: string;
  /**
   * Get the result as a JSON string.
   */
  readonly result_json: string;
  /**
   * Check if the envelope represents success.
   */
  readonly success: boolean;
}

/**
 * LAFS metadata for envelope.
 */
export class WasmLafsMeta {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Create new LAFS metadata.
   *
   * # Arguments
   * * `operation` - The operation name (e.g., "tasks.list")
   * * `transport` - Transport type string ("cli", "http", "grpc", "sdk")
   */
  constructor(operation: string, transport: string);
  /**
   * Get the operation name.
   */
  readonly operation: string;
  /**
   * Get the schema version.
   */
  readonly schema_version: string;
  /**
   * Get the LAFS spec version.
   */
  readonly spec_version: string;
  /**
   * Get the transport type as a string.
   */
  readonly transport: string;
}

/**
 * The transport mechanism used to deliver a LAFS envelope.
 */
export class WasmLafsTransport {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Create a CLI transport variant.
   */
  static Cli(): WasmLafsTransport;
  /**
   * Create a gRPC transport variant.
   */
  static Grpc(): WasmLafsTransport;
  /**
   * Create an HTTP transport variant.
   */
  static Http(): WasmLafsTransport;
  /**
   * Create an SDK transport variant.
   */
  static Sdk(): WasmLafsTransport;
  /**
   * Get the transport as a string.
   */
  readonly as_string: string;
}

/**
 * Helper function to create a transport enum.
 *
 * # Arguments
 * * `transport` - Transport type string ("cli", "http", "grpc", "sdk")
 */
export function create_transport(transport: string): WasmLafsTransport;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_wasmlafstransport_free: (a: number, b: number) => void;
  readonly wasmlafstransport_Cli: () => number;
  readonly wasmlafstransport_Http: () => number;
  readonly wasmlafstransport_Grpc: () => number;
  readonly wasmlafstransport_Sdk: () => number;
  readonly wasmlafstransport_as_string: (a: number) => [number, number];
  readonly __wbg_wasmlafsmeta_free: (a: number, b: number) => void;
  readonly wasmlafsmeta_new: (a: number, b: number, c: number, d: number) => number;
  readonly wasmlafsmeta_spec_version: (a: number) => [number, number];
  readonly wasmlafsmeta_schema_version: (a: number) => [number, number];
  readonly wasmlafsmeta_operation: (a: number) => [number, number];
  readonly wasmlafsmeta_transport: (a: number) => [number, number];
  readonly __wbg_wasmlafsenvelope_free: (a: number, b: number) => void;
  readonly wasmlafsenvelope_createSuccess: (a: number, b: number, c: number) => number;
  readonly wasmlafsenvelope_createError: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
  ) => number;
  readonly wasmlafsenvelope_success: (a: number) => number;
  readonly wasmlafsenvelope_result_json: (a: number) => [number, number];
  readonly wasmlafsenvelope_error_json: (a: number) => [number, number];
  readonly wasmlafsenvelope_meta_json: (a: number) => [number, number];
  readonly create_transport: (a: number, b: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
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
