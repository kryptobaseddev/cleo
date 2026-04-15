

export const index = 5;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/brain/graph/_page.svelte.js')).default;
export const imports = ["_app/immutable/nodes/5.Bi7Ecquf.js","_app/immutable/chunks/CC_7gvW7.js","_app/immutable/chunks/ibwe1TAv.js"];
export const stylesheets = ["_app/immutable/assets/5.dLrGvhBz.css"];
export const fonts = [];
