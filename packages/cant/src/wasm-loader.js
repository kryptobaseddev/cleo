"use strict";
/**
 * WASM loader for cant-core
 *
 * Loads the WASM module and provides access to CANT parsing functions
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.wasmModule = void 0;
exports.initWasm = initWasm;
exports.isWasmAvailable = isWasmAvailable;
exports.cantParseWASM = cantParseWASM;
exports.cantClassifyDirectiveWASM = cantClassifyDirectiveWASM;
// Dynamic import of the WASM module
let wasmModule = null;
exports.wasmModule = wasmModule;
let isInitializing = false;
let initPromise = null;
/**
 * Initialize the WASM module
 * Must be called before using any WASM functions
 */
async function initWasm() {
    if (wasmModule)
        return;
    if (isInitializing) {
        return initPromise;
    }
    isInitializing = true;
    initPromise = (async () => {
        try {
            // Try to load the WASM module
            const wasm = (await import('../wasm/cant_core'));
            await wasm.default();
            exports.wasmModule = wasmModule = wasm;
        }
        catch (_error) {
            console.warn('WASM module not available, falling back to stub implementation');
            exports.wasmModule = wasmModule = null;
        }
    })();
    await initPromise;
    isInitializing = false;
}
/**
 * Check if WASM is available
 */
function isWasmAvailable() {
    return wasmModule !== null;
}
/**
 * Parse a CANT message using WASM
 */
function cantParseWASM(content) {
    if (!wasmModule) {
        throw new Error('WASM not initialized. Call initWasm() first.');
    }
    return wasmModule.cant_parse(content);
}
/**
 * Classify a directive using WASM
 */
function cantClassifyDirectiveWASM(verb) {
    if (!wasmModule) {
        throw new Error('WASM not initialized. Call initWasm() first.');
    }
    return wasmModule.cant_classify_directive(verb);
}
//# sourceMappingURL=wasm-loader.js.map