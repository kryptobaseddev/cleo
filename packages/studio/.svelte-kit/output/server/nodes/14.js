import * as server from '../entries/pages/tasks/_id_/_page.server.ts.js';

export const index = 14;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/tasks/_id_/_page.svelte.js')).default;
export { server };
export const server_id = "src/routes/tasks/[id]/+page.server.ts";
export const imports = ["_app/immutable/nodes/14.B3LXKwyY.js","_app/immutable/chunks/ZT3WoQr4.js","_app/immutable/chunks/ibwe1TAv.js"];
export const stylesheets = ["_app/immutable/assets/14.DKwxyo93.css"];
export const fonts = [];
