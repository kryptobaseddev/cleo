import * as server from '../entries/pages/tasks/sessions/_page.server.ts.js';

export const index = 16;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/tasks/sessions/_page.svelte.js')).default;
export { server };
export const server_id = "src/routes/tasks/sessions/+page.server.ts";
export const imports = ["_app/immutable/nodes/16.e0wEEypB.js","_app/immutable/chunks/BaLXwP8b.js","_app/immutable/chunks/ibwe1TAv.js"];
export const stylesheets = ["_app/immutable/assets/16.DWzk8nj5.css"];
export const fonts = [];
