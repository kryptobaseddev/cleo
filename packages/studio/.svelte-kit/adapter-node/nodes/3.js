import * as server from '../entries/pages/brain/_page.server.ts.js';

export const index = 3;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/brain/_page.svelte.js')).default;
export { server };
export const server_id = "src/routes/brain/+page.server.ts";
export const imports = ["_app/immutable/nodes/3.kuzi7ysy.js","_app/immutable/chunks/FR9iDC2_.js","_app/immutable/chunks/CFKVnMbq.js"];
export const stylesheets = ["_app/immutable/assets/3.C92tpZzl.css"];
export const fonts = [];
