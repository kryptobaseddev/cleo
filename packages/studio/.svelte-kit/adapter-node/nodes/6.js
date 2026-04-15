

export const index = 6;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/brain/observations/_page.svelte.js')).default;
export const imports = ["_app/immutable/nodes/6.BDMUC3wD.js","_app/immutable/chunks/BaLXwP8b.js","_app/immutable/chunks/ibwe1TAv.js"];
export const stylesheets = ["_app/immutable/assets/6.CA0UXWid.css"];
export const fonts = [];
