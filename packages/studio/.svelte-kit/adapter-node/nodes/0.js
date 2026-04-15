

export const index = 0;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_layout.svelte.js')).default;
export const imports = ["_app/immutable/nodes/0.DAr3jEYd.js","_app/immutable/chunks/CC_7gvW7.js","_app/immutable/chunks/dVYxnWpL.js","_app/immutable/chunks/ibwe1TAv.js"];
export const stylesheets = ["_app/immutable/assets/0.OHRG3u1R.css"];
export const fonts = [];
