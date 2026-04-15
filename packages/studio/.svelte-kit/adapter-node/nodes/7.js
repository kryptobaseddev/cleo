import * as server from '../entries/pages/brain/overview/_page.server.ts.js';

export const index = 7;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/brain/overview/_page.svelte.js')).default;
export { server };
export const server_id = "src/routes/brain/overview/+page.server.ts";
export const imports = ["_app/immutable/nodes/7.CNNgkUIV.js","_app/immutable/chunks/ZT3WoQr4.js","_app/immutable/chunks/ibwe1TAv.js"];
export const stylesheets = ["_app/immutable/assets/7.Dg-h3MuC.css"];
export const fonts = [];
