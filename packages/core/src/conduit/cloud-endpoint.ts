/**
 * Old path of the cloud messaging endpoint gate (T13169).
 *
 * The module moved to `../cloud/cloud-endpoint.ts` (T13983) because conduit
 * messaging is retiring (epic T13933) while the gate stays: it guards every
 * agent-registry cloud call and installs the retired-host `fetch` backstop on
 * every CLI command. This re-export keeps `@cleocode/core/conduit/cloud-endpoint`
 * working for one release.
 *
 * @deprecated Import from `@cleocode/core/cloud/cloud-endpoint.js`. Removal
 * target: the conduit public-API release (T13957).
 * @task T13983
 */

export * from '../cloud/cloud-endpoint.js';
