/**
 * WASM loader for cant-core
 *
 * Loads the WASM module and provides access to CANT parsing functions
 */
/** Shape of the CANT WASM module exports. */
interface CantWasmModule {
  default(): Promise<void>;
  cant_parse(content: string): unknown;
  cant_classify_directive(verb: string): string;
}
declare let wasmModule: CantWasmModule | null;
/**
 * Initialize the WASM module
 * Must be called before using any WASM functions
 */
export declare function initWasm(): Promise<void>;
/**
 * Check if WASM is available
 */
export declare function isWasmAvailable(): boolean;
/**
 * Parse a CANT message using WASM
 */
export declare function cantParseWASM(content: string): unknown;
/**
 * Classify a directive using WASM
 */
export declare function cantClassifyDirectiveWASM(verb: string): string;
export type { CantWasmModule };
export { wasmModule };
//# sourceMappingURL=wasm-loader.d.ts.map
