

export const index = 8;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/brain/quality/_page.svelte.js')).default;
export const imports = ["_app/immutable/nodes/8.DQGmW7nQ.js","_app/immutable/chunks/ZT3WoQr4.js","_app/immutable/chunks/ibwe1TAv.js"];
export const stylesheets = ["_app/immutable/assets/8.BDXI0NlP.css"];
export const fonts = [];
