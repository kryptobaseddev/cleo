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
 *
 * // LAFS
 * const meta = new lafs.WasmLafsMeta('tasks.list', 'http');
 * const envelope = lafs.WasmLafsEnvelope.createSuccess('{"tasks":[]}', meta);
 *
 * // Conduit
 * const msg = new conduit.WasmConduitMessage('msg-1', 'agent-a', 'Hello', '2026-03-25T00:00:00Z');
 * const cant = new conduit.WasmCantMetadata('actionable', '["@agent"]', '["T123"]', '["#tag"]');
 * ```
 */

// WASM module instances
let lafsModule: any = null;
let conduitModule: any = null;
let isInitialized = false;
let isInitializing = false;
let initPromise: Promise<void> | null = null;

/**
 * Initialize all WASM modules
 * Must be called before using any WASM classes/functions
 *
 * @example
 * ```typescript
 * import { initWasm, lafs, conduit } from '@cleocode/contracts/wasm';
 *
 * await initWasm();
 *
 * // Now you can use WASM classes
 * const meta = new lafs.WasmLafsMeta('tasks.list', 'http');
 * ```
 */
export async function initWasm(): Promise<void> {
  if (isInitialized) return;
  if (isInitializing) {
    return initPromise!;
  }

  isInitializing = true;
  initPromise = (async () => {
    try {
      // Dynamic imports to avoid loading if not needed
      const [lafs, conduit] = await Promise.all([
        import('./lafs-core/lafs_core.js'),
        import('./conduit-core/conduit_core.js'),
      ]);

      // Initialize modules
      await Promise.all([lafs.default(), conduit.default()]);

      lafsModule = lafs;
      conduitModule = conduit;
      isInitialized = true;
    } catch (_error) {
      throw new Error('WASM initialization failed. Ensure WASM files are present.');
    }
  })();

  await initPromise;
  isInitializing = false;
}

/**
 * Check if WASM is initialized and ready to use
 *
 * @returns true if WASM modules are loaded and initialized
 */
export function isWasmReady(): boolean {
  return isInitialized;
}

/**
 * LAFS Core WASM exports
 *
 * Available after calling initWasm():
 * - WasmLafsTransport - Transport type (Cli, Http, Grpc, Sdk)
 * - WasmLafsMeta - Metadata for LAFS envelopes
 * - WasmLafsEnvelope - The main LAFS response envelope
 * - createTransport() - Helper to create transport from string
 */
export const lafs = {
  /**
   * LAFS Transport enum
   * Use WasmLafsTransport.cli(), .http(), .grpc(), or .sdk()
   */
  get WasmLafsTransport() {
    if (!lafsModule) throw new Error('WASM not initialized. Call initWasm() first.');
    return lafsModule.WasmLafsTransport;
  },

  /**
   * LAFS Metadata constructor
   * new WasmLafsMeta(operation: string, transport: string)
   */
  get WasmLafsMeta() {
    if (!lafsModule) throw new Error('WASM not initialized. Call initWasm() first.');
    return lafsModule.WasmLafsMeta;
  },

  /**
   * LAFS Envelope class
   * Use WasmLafsEnvelope.createSuccess() or .createError()
   */
  get WasmLafsEnvelope() {
    if (!lafsModule) throw new Error('WASM not initialized. Call initWasm() first.');
    return lafsModule.WasmLafsEnvelope;
  },

  /**
   * Helper function to create transport from string
   * @param transport - "cli", "http", "grpc", or "sdk"
   */
  get createTransport() {
    if (!lafsModule) throw new Error('WASM not initialized. Call initWasm() first.');
    return lafsModule.create_transport;
  },
};

/**
 * Conduit Core WASM exports
 *
 * Available after calling initWasm():
 * - WasmConduitMessage - Agent-to-agent messages
 * - WasmConduitState - Connection states (Disconnected, Connecting, Connected, etc.)
 * - WasmCantMetadata - CANT parsing results
 * - parseConduitMessage() - Parse message from JSON
 * - createConduitState() - Create state from string
 */
export const conduit = {
  /**
   * Conduit Message constructor
   * new WasmConduitMessage(id, from, content, timestamp)
   */
  get WasmConduitMessage() {
    if (!conduitModule) throw new Error('WASM not initialized. Call initWasm() first.');
    return conduitModule.WasmConduitMessage;
  },

  /**
   * Conduit State enum
   * Use WasmConduitState.disconnected(), .connecting(), .connected(), etc.
   */
  get WasmConduitState() {
    if (!conduitModule) throw new Error('WASM not initialized. Call initWasm() first.');
    return conduitModule.WasmConduitState;
  },

  /**
   * CANT Metadata constructor
   * new WasmCantMetadata(directiveType, addressesJson, taskRefsJson, tagsJson)
   */
  get WasmCantMetadata() {
    if (!conduitModule) throw new Error('WASM not initialized. Call initWasm() first.');
    return conduitModule.WasmCantMetadata;
  },

  /**
   * Parse a ConduitMessage from JSON string
   * @param json - JSON string
   * @returns WasmConduitMessage or undefined
   */
  get parseConduitMessage() {
    if (!conduitModule) throw new Error('WASM not initialized. Call initWasm() first.');
    return conduitModule.parse_conduit_message;
  },

  /**
   * Create a ConduitState from string
   * @param state - "disconnected", "connecting", "connected", "reconnecting", "error"
   */
  get createConduitState() {
    if (!conduitModule) throw new Error('WASM not initialized. Call initWasm() first.');
    return conduitModule.create_conduit_state;
  },
};
