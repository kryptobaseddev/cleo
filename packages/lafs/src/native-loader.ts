/**
 * Native addon loader for lafs-core schema validation via napi-rs.
 *
 * @remarks
 * Loads the napi-rs native addon synchronously on first use. Falls back
 * gracefully if the native addon is not available (e.g., unsupported platform,
 * Rust toolchain not installed). When unavailable, the AJV-based validator
 * in `validateEnvelope.ts` is used instead.
 *
 * Follows the same pattern as `packages/cant/src/native-loader.ts`.
 */

import { createRequire } from 'node:module';

/** Shape of a structured validation error from the native binding. */
interface NativeValidationError {
  /** JSON Pointer path to the failing property. */
  path: string;
  /** JSON Schema keyword that triggered the error. */
  keyword: string;
  /** Human-readable error message. */
  message: string;
  /** Keyword-specific parameters. */
  params: Record<string, unknown>;
}

/** Shape of the validation result from the native binding. */
export interface NativeValidationResult {
  /** Whether the envelope conforms to the schema. */
  valid: boolean;
  /** Flattened human-readable error messages. */
  errors: string[];
  /** Structured error objects. */
  structuredErrors: NativeValidationError[];
}

/** Shape of the native LAFS addon. */
interface LafsNativeModule {
  lafsValidateEnvelope(payload: string): NativeValidationResult;
}

let nativeModule: LafsNativeModule | null = null;
let loadAttempted = false;

/**
 * Attempt to load the native addon. Called lazily on first use.
 * Native addons load synchronously via require() — no async init needed.
 */
function ensureLoaded(): void {
  if (loadAttempted) return;
  loadAttempted = true;

  const req = createRequire(import.meta.url);
  try {
    nativeModule = req('@cleocode/lafs-native') as LafsNativeModule;
  } catch {
    try {
      // Development fallback: try loading from the crate build output
      nativeModule = req('../../crates/lafs-napi/index.cjs') as LafsNativeModule;
    } catch {
      // Native addon not available — AJV fallback will be used
      nativeModule = null;
    }
  }
}

/**
 * Check if the native addon is available.
 *
 * @returns `true` if the native Rust binding was loaded successfully.
 */
export function isNativeAvailable(): boolean {
  ensureLoaded();
  return nativeModule !== null;
}

/**
 * Get the native module, or `null` if unavailable.
 *
 * @returns The loaded native module, or `null` for AJV fallback.
 */
export function getNativeModule(): LafsNativeModule | null {
  ensureLoaded();
  return nativeModule;
}
