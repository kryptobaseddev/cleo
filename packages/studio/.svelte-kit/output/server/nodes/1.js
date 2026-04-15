

export const index = 1;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/fallbacks/error.svelte.js')).default;
export const imports = ["_app/immutable/nodes/1.CP7WTdcb.js","_app/immutable/chunks/BaLXwP8b.js","_app/immutable/chunks/lNG2k0Yr.js","_app/immutable/chunks/ibwe1TAv.js"];
export const stylesheets = [];
export const fonts = [];
