

export const index = 5;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/brain/graph/_page.svelte.js')).default;
export const imports = ["_app/immutable/nodes/5.DutNHg-K.js","_app/immutable/chunks/BxdpdJ6L.js","_app/immutable/chunks/BVEOzTpX.js"];
export const stylesheets = ["_app/immutable/assets/5.dLrGvhBz.css"];
export const fonts = [];
