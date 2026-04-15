

export const index = 4;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/brain/decisions/_page.svelte.js')).default;
export const imports = ["_app/immutable/nodes/4.iVz_fhPe.js","_app/immutable/chunks/BxdpdJ6L.js","_app/immutable/chunks/BVEOzTpX.js"];
export const stylesheets = ["_app/immutable/assets/4.Crrkn-dS.css"];
export const fonts = [];
