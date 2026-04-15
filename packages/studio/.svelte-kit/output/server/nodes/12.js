import * as server from '../entries/pages/projects/_page.server.ts.js';

export const index = 12;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/projects/_page.svelte.js')).default;
export { server };
export const server_id = "src/routes/projects/+page.server.ts";
export const imports = ["_app/immutable/nodes/12.CQb6AgOX.js","_app/immutable/chunks/CC_7gvW7.js","_app/immutable/chunks/DG2EYPxa.js","_app/immutable/chunks/gdZJk5Mi.js","_app/immutable/chunks/ibwe1TAv.js"];
export const stylesheets = ["_app/immutable/assets/12.DP-hlj4s.css"];
export const fonts = [];
