/**
 * Central WASM SDK for CLEO Core Contracts
 * 
 * Provides unified access to all Rust crate WASM modules:
 * - lafs-core: LAFS envelope types and validation
 * - conduit-core: Conduit wire types and CANT metadata
 * - cant-core: CANT grammar parser (via @cleocode/cant)
 * 
 * Usage:
 * ```typescript
 * import { initWasm, lafs, conduit } from '@cleocode/contracts/wasm';
 * 
 * await initWasm();
 * const envelope = lafs.createEnvelope(...);
 * const message = conduit.createMessage(...);
 * ```
 */

// WASM module instances
let lafsModule: any = null;
let conduitModule: any = null;
let isInitialized = false;

/**
 * Initialize all WASM modules
 * Must be called before using any WASM functions
 */
export async function initWasm(): Promise<void> {
  if (isInitialized) return;
  
  try {
    // Dynamic imports to avoid loading if not needed
    const lafs = await import('./lafs-core/lafs_core');
    const conduit = await import('./conduit-core/conduit_core');
    
    // Initialize modules
    await lafs.default();
    await conduit.default();
    
    lafsModule = lafs;
    conduitModule = conduit;
    isInitialized = true;
    
    console.log('[WASM] All modules initialized');
  } catch (error) {
    console.warn('[WASM] Failed to initialize:', error);
    throw new Error('WASM initialization failed. Ensure WASM files are present.');
  }
}

/**
 * Check if WASM is initialized
 */
export function isWasmReady(): boolean {
  return isInitialized;
}

/**
 * LAFS Core WASM interface
 */
export const lafs = {
  /**
   * Create a LAFS envelope
   */
  createEnvelope: (data: any, meta: any) => {
    if (!lafsModule) throw new Error('WASM not initialized');
    return lafsModule.create_envelope?.(data, meta);
  },
  
  /**
   * Create LAFS metadata
   */
  createMeta: (operation: string, transport: string) => {
    if (!lafsModule) throw new Error('WASM not initialized');
    return lafsModule.create_meta?.(operation, transport);
  }
};

/**
 * Conduit Core WASM interface
 */
export const conduit = {
  /**
   * Create a ConduitMessage
   */
  createMessage: (data: any) => {
    if (!conduitModule) throw new Error('WASM not initialized');
    return conduitModule.create_message?.(data);
  },
  
  /**
   * Parse CANT metadata
   */
  parseCantMetadata: (content: string) => {
    if (!conduitModule) throw new Error('WASM not initialized');
    return conduitModule.parse_cant_metadata?.(content);
  }
};

// Re-export types
export type { LafsEnvelope, LafsMeta } from '../lafs';
export type { ConduitMessage, ConduitState } from '../conduit';
