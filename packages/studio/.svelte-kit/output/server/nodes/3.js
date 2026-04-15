import * as server from '../entries/pages/brain/_page.server.ts.js';

export const index = 3;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/brain/_page.svelte.js')).default;
export { server };
export const server_id = "src/routes/brain/+page.server.ts";
export const imports = ["_app/immutable/nodes/3.DncnlQD2.js","_app/immutable/chunks/CC_7gvW7.js","_app/immutable/chunks/ibwe1TAv.js"];
export const stylesheets = ["_app/immutable/assets/3.DUN9eWob.css"];
export const fonts = [];
