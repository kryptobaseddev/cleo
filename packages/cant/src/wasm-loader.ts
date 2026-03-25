/**
 * WASM loader for cant-core
 *
 * Loads the WASM module and provides access to CANT parsing functions
 */

// Dynamic import of the WASM module
let wasmModule: any = null;
let isInitializing = false;
let initPromise: Promise<void> | null = null;

/**
 * Initialize the WASM module
 * Must be called before using any WASM functions
 */
export async function initWasm(): Promise<void> {
  if (wasmModule) return;
  if (isInitializing) {
    return initPromise!;
  }

  isInitializing = true;
  initPromise = (async () => {
    try {
      // Try to load the WASM module
      const wasm = await import('../wasm/cant_core');
      await wasm.default();
      wasmModule = wasm;
    } catch (error) {
      console.warn('WASM module not available, falling back to stub implementation');
      wasmModule = null;
    }
  })();

  await initPromise;
  isInitializing = false;
}

/**
 * Check if WASM is available
 */
export function isWasmAvailable(): boolean {
  return wasmModule !== null;
}

/**
 * Parse a CANT message using WASM
 */
export function cantParseWASM(content: string): any {
  if (!wasmModule) {
    throw new Error('WASM not initialized. Call initWasm() first.');
  }
  return wasmModule.cant_parse(content);
}

/**
 * Classify a directive using WASM
 */
export function cantClassifyDirectiveWASM(verb: string): string {
  if (!wasmModule) {
    throw new Error('WASM not initialized. Call initWasm() first.');
  }
  return wasmModule.cant_classify_directive(verb);
}

export { wasmModule };
