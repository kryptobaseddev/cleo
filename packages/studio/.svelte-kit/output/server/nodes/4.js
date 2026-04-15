import * as server from '../entries/pages/nexus/_page.server.ts.js';

export const index = 4;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/nexus/_page.svelte.js')).default;
export { server };
export const server_id = "src/routes/nexus/+page.server.ts";
export const imports = ["_app/immutable/nodes/4.CzC-ygOU.js","_app/immutable/chunks/FR9iDC2_.js","_app/immutable/chunks/CFKVnMbq.js"];
export const stylesheets = ["_app/immutable/assets/4.BOrZ0clC.css"];
export const fonts = [];
