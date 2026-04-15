import * as server from '../entries/pages/tasks/_page.server.ts.js';

export const index = 13;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/tasks/_page.svelte.js')).default;
export { server };
export const server_id = "src/routes/tasks/+page.server.ts";
export const imports = ["_app/immutable/nodes/13.D2jkRVGX.js","_app/immutable/chunks/BaLXwP8b.js","_app/immutable/chunks/ibwe1TAv.js"];
export const stylesheets = ["_app/immutable/assets/13.D-mF5Pzk.css"];
export const fonts = [];
