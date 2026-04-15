import * as server from '../entries/pages/living-brain/_page.server.ts.js';

export const index = 8;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/living-brain/_page.svelte.js')).default;
export { server };
export const server_id = "src/routes/living-brain/+page.server.ts";
export const imports = ["_app/immutable/nodes/8.CMhwj32N.js","_app/immutable/chunks/CC_7gvW7.js","_app/immutable/chunks/woD0E6xL.js","_app/immutable/chunks/ibwe1TAv.js"];
export const stylesheets = ["_app/immutable/assets/8.BLO6eOrj.css"];
export const fonts = [];
