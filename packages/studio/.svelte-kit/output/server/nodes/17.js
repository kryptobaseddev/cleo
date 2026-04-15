import * as server from '../entries/pages/tasks/tree/_epicId_/_page.server.ts.js';

export const index = 17;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/tasks/tree/_epicId_/_page.svelte.js')).default;
export { server };
export const server_id = "src/routes/tasks/tree/[epicId]/+page.server.ts";
export const imports = ["_app/immutable/nodes/17.B3HvQ5GV.js","_app/immutable/chunks/CC_7gvW7.js","_app/immutable/chunks/ibwe1TAv.js"];
export const stylesheets = ["_app/immutable/assets/17.DYClIb_H.css"];
export const fonts = [];
