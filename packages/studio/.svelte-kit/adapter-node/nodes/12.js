import * as server from '../entries/pages/projects/_page.server.ts.js';

export const index = 12;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/projects/_page.svelte.js')).default;
export { server };
export const server_id = "src/routes/projects/+page.server.ts";
export const imports = ["_app/immutable/nodes/12.DC3JOT7D.js","_app/immutable/chunks/BaLXwP8b.js","_app/immutable/chunks/lNG2k0Yr.js","_app/immutable/chunks/DdyX08XJ.js","_app/immutable/chunks/ibwe1TAv.js"];
export const stylesheets = ["_app/immutable/assets/12.DP-hlj4s.css"];
export const fonts = [];
