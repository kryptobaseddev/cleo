import * as server from '../entries/pages/code/community/_id_/_page.server.ts.js';

export const index = 10;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/code/community/_id_/_page.svelte.js')).default;
export { server };
export const server_id = "src/routes/code/community/[id]/+page.server.ts";
export const imports = ["_app/immutable/nodes/10.Bx07lqRA.js","_app/immutable/chunks/BaLXwP8b.js","_app/immutable/chunks/ibwe1TAv.js","_app/immutable/chunks/B9fs5Bq9.js","_app/immutable/chunks/lNG2k0Yr.js","_app/immutable/chunks/DdyX08XJ.js","_app/immutable/chunks/BgWknWDs.js"];
export const stylesheets = ["_app/immutable/assets/NexusGraph.eS4eJg0E.css","_app/immutable/assets/10.CVbowohj.css"];
export const fonts = [];
