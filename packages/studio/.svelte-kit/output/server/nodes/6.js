

export const index = 6;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/brain/observations/_page.svelte.js')).default;
export const imports = ["_app/immutable/nodes/6.Dr90kh8l.js","_app/immutable/chunks/CC_7gvW7.js","_app/immutable/chunks/ibwe1TAv.js"];
export const stylesheets = ["_app/immutable/assets/6.zwdklswq.css"];
export const fonts = [];
