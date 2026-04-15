import * as server from '../entries/pages/projects/_page.server.ts.js';

export const index = 12;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/projects/_page.svelte.js')).default;
export { server };
export const server_id = "src/routes/projects/+page.server.ts";
export const imports = ["_app/immutable/nodes/12.DMViR_1j.js","_app/immutable/chunks/ZT3WoQr4.js","_app/immutable/chunks/ltU5_Kh5.js","_app/immutable/chunks/hOfOSlm7.js","_app/immutable/chunks/ibwe1TAv.js"];
export const stylesheets = ["_app/immutable/assets/12.UOd2WnhF.css"];
export const fonts = [];
