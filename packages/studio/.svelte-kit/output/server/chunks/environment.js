//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/app/paths/internal/server.js
var base = "";
var assets = base;
var app_dir = "_app";
var initial = {
	base,
	assets
};
initial.base;
/**
* @param {{ base: string, assets: string }} paths
*/
function override(paths) {
	base = paths.base;
	assets = paths.assets;
}
function reset() {
	base = initial.base;
	assets = initial.assets;
}
/** @param {string} path */
function set_assets(path) {
	assets = initial.assets = path;
}
/**
* `$env/dynamic/public`
* @type {Record<string, string>}
*/
var public_env = {};
/** @param {any} error */
var fix_stack_trace = (error) => error?.stack;
/** @type {(environment: Record<string, string>) => void} */
function set_private_env(environment) {}
/** @type {(environment: Record<string, string>) => void} */
function set_public_env(environment) {
	public_env = environment;
}
//#endregion
//#region \0virtual:__sveltekit/environment
var version = "1776268469157";
var prerendering = false;
function set_building() {}
function set_prerendering() {
	prerendering = true;
}
//#endregion
export { fix_stack_trace as a, set_public_env as c, base as d, override as f, version as i, app_dir as l, set_assets as m, set_building as n, public_env as o, reset as p, set_prerendering as r, set_private_env as s, prerendering as t, assets as u };
