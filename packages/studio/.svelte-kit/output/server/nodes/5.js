import * as server from '../entries/pages/tasks/_page.server.ts.js';

export const index = 5;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/tasks/_page.svelte.js')).default;
export { server };
export const server_id = "src/routes/tasks/+page.server.ts";
export const imports = ["_app/immutable/nodes/5.D7dqvIqL.js","_app/immutable/chunks/FR9iDC2_.js","_app/immutable/chunks/CFKVnMbq.js"];
export const stylesheets = ["_app/immutable/assets/5.CBMHUWtE.css"];
export const fonts = [];
