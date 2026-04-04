"use strict";
/**
 * Native addon loader for cant-core via napi-rs
 *
 * Loads the napi-rs native addon synchronously. Falls back gracefully
 * if the native addon is not available (e.g., unsupported platform).
 *
 * Replaces the previous wasm-loader.ts which used async WASM initialization.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.initWasm = exports.isWasmAvailable = void 0;
exports.isNativeAvailable = isNativeAvailable;
exports.cantParseNative = cantParseNative;
exports.cantClassifyDirectiveNative = cantClassifyDirectiveNative;
let nativeModule = null;
let loadAttempted = false;
/**
 * Attempt to load the native addon. Called lazily on first use.
 * Native addons load synchronously via require() — no async init needed.
 */
function ensureLoaded() {
    if (loadAttempted)
        return;
    loadAttempted = true;
    try {
        // Try loading the napi-rs native addon
        // The package name will be @cleocode/cant-native once published
        nativeModule = require('@cleocode/cant-native');
    }
    catch {
        try {
            // Development fallback: try loading from the crate build output
            nativeModule = require('../../crates/cant-napi');
        }
        catch {
            // Native addon not available — JS fallback will be used
            nativeModule = null;
        }
    }
}
/**
 * Check if the native addon is available
 */
function isNativeAvailable() {
    ensureLoaded();
    return nativeModule !== null;
}
/**
 * Parse a CANT message using the native addon
 */
function cantParseNative(content) {
    ensureLoaded();
    if (!nativeModule) {
        throw new Error('Native addon not available.');
    }
    return nativeModule.cantParse(content);
}
/**
 * Classify a directive using the native addon
 */
function cantClassifyDirectiveNative(verb) {
    ensureLoaded();
    if (!nativeModule) {
        throw new Error('Native addon not available.');
    }
    return nativeModule.cantClassifyDirective(verb);
}
// Backward compatibility aliases
exports.isWasmAvailable = isNativeAvailable;
const initWasm = async () => {
    ensureLoaded();
};
exports.initWasm = initWasm;
//# sourceMappingURL=native-loader.js.map