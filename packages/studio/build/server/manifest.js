const manifest = (() => {
function __memo(fn) {
	let value;
	return () => value ??= (value = fn());
}

return {
	appDir: "_app",
	appPath: "_app",
	assets: new Set(["favicon.png"]),
	mimeTypes: {".png":"image/png"},
	_: {
		client: {start:"_app/immutable/entry/start.CkCATQ3h.js",app:"_app/immutable/entry/app.C_n5Td0c.js",imports:["_app/immutable/entry/start.CkCATQ3h.js","_app/immutable/chunks/9H2hkW8o.js","_app/immutable/chunks/FR9iDC2_.js","_app/immutable/entry/app.C_n5Td0c.js","_app/immutable/chunks/FR9iDC2_.js","_app/immutable/chunks/BgUy-a58.js","_app/immutable/chunks/CFKVnMbq.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
		nodes: [
			__memo(() => import('./chunks/0-ywEePHxI.js')),
			__memo(() => import('./chunks/1-DGRdApZU.js')),
			__memo(() => import('./chunks/2-BDGrNySv.js')),
			__memo(() => import('./chunks/3-C3_UDpN0.js')),
			__memo(() => import('./chunks/4-NarTRNns.js')),
			__memo(() => import('./chunks/5-BE9dTBmm.js'))
		],
		remotes: {
			
		},
		routes: [
			{
				id: "/",
				pattern: /^\/$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 2 },
				endpoint: null
			},
			{
				id: "/api/health",
				pattern: /^\/api\/health\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-DXfR_aJV.js'))
			},
			{
				id: "/brain",
				pattern: /^\/brain\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 3 },
				endpoint: null
			},
			{
				id: "/nexus",
				pattern: /^\/nexus\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 4 },
				endpoint: null
			},
			{
				id: "/tasks",
				pattern: /^\/tasks\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 5 },
				endpoint: null
			}
		],
		prerendered_routes: new Set([]),
		matchers: async () => {
			
			return {  };
		},
		server_assets: {}
	}
}
})();

const prerendered = new Set([]);

const base = "";

export { base, manifest, prerendered };
//# sourceMappingURL=manifest.js.map
