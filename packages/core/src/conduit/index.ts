/**
 * Conduit — High-level agent messaging for the CLEO ecosystem.
 *
 * Exports the ConduitClient (high-level messaging), the cloud-endpoint gate
 * (conduitFetch: retired SignalDock hosts are refused, T13169), HttpTransport
 * (HTTP polling to cloud), LocalTransport (offline SQLite), the
 * channel layer (LocalTuiChannelAdapter + DeliveryRouter/SessionStore),
 * and the createConduit factory.
 *
 * @module conduit
 */

export {
  assertCloudUrlAllowed,
  conduitFetch,
  E_SIGNALDOCK_RETIRED,
  isRetiredCloudUrl,
  isSignalDockRetiredError,
  RETIRED_CLOUD_HOSTS,
  retiredCloudHost,
  SignalDockRetiredError,
} from './cloud-endpoint.js';
export { ConduitClient } from './conduit-client.js';
export {
  DeliveryRouter,
  type InboundHandler,
  SessionStore,
} from './delivery-router.js';
export { createConduit, resolveTransport } from './factory.js';
export { HttpTransport } from './http-transport.js';
export { LocalTransport } from './local-transport.js';
export {
  LOCAL_TUI_CHANNEL_ID,
  LocalTuiChannelAdapter,
  type LocalTuiChannelAdapterOptions,
} from './local-tui-adapter.js';
export type { conduitCoreOps } from './ops.js';
export { SseTransport } from './sse-transport.js';
