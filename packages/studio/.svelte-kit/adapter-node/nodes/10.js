import * as server from '../entries/pages/nexus/community/_id_/_page.server.ts.js';

export const index = 10;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/nexus/community/_id_/_page.svelte.js')).default;
export { server };
export const server_id = "src/routes/nexus/community/[id]/+page.server.ts";
export const imports = ["_app/immutable/nodes/10.C7TgeLF3.js","_app/immutable/chunks/CC_7gvW7.js","_app/immutable/chunks/ibwe1TAv.js","_app/immutable/chunks/kaZQEOyy.js","_app/immutable/chunks/dVYxnWpL.js","_app/immutable/chunks/BdnaH7OR.js","_app/immutable/chunks/woD0E6xL.js"];
export const stylesheets = ["_app/immutable/assets/NexusGraph.CA44Eg2r.css","_app/immutable/assets/10.bCUSurl2.css"];
export const fonts = [];
