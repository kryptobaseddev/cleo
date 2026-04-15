

export const index = 4;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/brain/decisions/_page.svelte.js')).default;
export const imports = ["_app/immutable/nodes/4.-v9RYDGk.js","_app/immutable/chunks/CC_7gvW7.js","_app/immutable/chunks/ibwe1TAv.js"];
export const stylesheets = ["_app/immutable/assets/4.Crrkn-dS.css"];
export const fonts = [];
