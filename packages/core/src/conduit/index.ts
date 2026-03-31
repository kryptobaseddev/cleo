/**
 * Conduit — High-level agent messaging for the CLEO ecosystem.
 *
 * Exports the ConduitClient (high-level messaging), HttpTransport
 * (HTTP polling to cloud), LocalTransport (offline SQLite), and
 * createConduit factory.
 *
 * @module conduit
 */

export { ConduitClient } from './conduit-client.js';
export { createConduit, resolveTransport } from './factory.js';
export { HttpTransport } from './http-transport.js';
export { LocalTransport } from './local-transport.js';
export { SseTransport } from './sse-transport.js';
