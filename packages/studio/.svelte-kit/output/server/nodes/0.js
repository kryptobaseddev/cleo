import * as server from '../entries/pages/_layout.server.ts.js';

export const index = 0;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_layout.svelte.js')).default;
export { server };
export const server_id = "src/routes/+layout.server.ts";
export const imports = ["_app/immutable/nodes/0.DAYBsSCs.js","_app/immutable/chunks/ZT3WoQr4.js","_app/immutable/chunks/ltU5_Kh5.js","_app/immutable/chunks/ibwe1TAv.js"];
export const stylesheets = ["_app/immutable/assets/0.Dwhkaog4.css"];
export const fonts = [];
