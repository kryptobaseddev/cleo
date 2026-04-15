import * as server from '../entries/pages/tasks/pipeline/_page.server.ts.js';

export const index = 15;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/tasks/pipeline/_page.svelte.js')).default;
export { server };
export const server_id = "src/routes/tasks/pipeline/+page.server.ts";
export const imports = ["_app/immutable/nodes/15.7_ebqXdP.js","_app/immutable/chunks/BaLXwP8b.js","_app/immutable/chunks/ibwe1TAv.js"];
export const stylesheets = ["_app/immutable/assets/15.DD-MRcTL.css"];
export const fonts = [];
