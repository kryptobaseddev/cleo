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
		client: {start:"_app/immutable/entry/start.CNSF2Fgo.js",app:"_app/immutable/entry/app.C5qmu0Ar.js",imports:["_app/immutable/entry/start.CNSF2Fgo.js","_app/immutable/chunks/es2t1aRQ.js","_app/immutable/chunks/BxdpdJ6L.js","_app/immutable/entry/app.C5qmu0Ar.js","_app/immutable/chunks/BxdpdJ6L.js","_app/immutable/chunks/B64WrFVF.js","_app/immutable/chunks/BVEOzTpX.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
		nodes: [
			__memo(() => import('./chunks/0-QAKZEec9.js')),
			__memo(() => import('./chunks/1-DMO-I80k.js')),
			__memo(() => import('./chunks/2-BX1CjRzL.js')),
			__memo(() => import('./chunks/3-DFg4WVHd.js')),
			__memo(() => import('./chunks/4-BoGt7zwD.js')),
			__memo(() => import('./chunks/5-CPBjUBih.js')),
			__memo(() => import('./chunks/6-4Bo23ovd.js')),
			__memo(() => import('./chunks/7-Ch28J5Gp.js')),
			__memo(() => import('./chunks/8-B-uSZkdp.js')),
			__memo(() => import('./chunks/9-kzRH-BKR.js')),
			__memo(() => import('./chunks/10-DtQ-3Jti.js')),
			__memo(() => import('./chunks/11-0EgkZ4V_.js')),
			__memo(() => import('./chunks/12-2CIxyeQp.js')),
			__memo(() => import('./chunks/13--9sLzS3p.js')),
			__memo(() => import('./chunks/14-D26FMHRh.js')),
			__memo(() => import('./chunks/15-DD8_Uq7o.js')),
			__memo(() => import('./chunks/16-DpzT-VPj.js'))
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
				id: "/api/brain/decisions",
				pattern: /^\/api\/brain\/decisions\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-h5xb8YLJ.js'))
			},
			{
				id: "/api/brain/graph",
				pattern: /^\/api\/brain\/graph\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-DNbonpx3.js'))
			},
			{
				id: "/api/brain/observations",
				pattern: /^\/api\/brain\/observations\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-CK3HgZ3m.js'))
			},
			{
				id: "/api/brain/quality",
				pattern: /^\/api\/brain\/quality\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-DflbsCZm.js'))
			},
			{
				id: "/api/health",
				pattern: /^\/api\/health\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-Ciwl-MiR.js'))
			},
			{
				id: "/api/nexus",
				pattern: /^\/api\/nexus\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-DaWSCUf6.js'))
			},
			{
				id: "/api/nexus/community/[id]",
				pattern: /^\/api\/nexus\/community\/([^/]+?)\/?$/,
				params: [{"name":"id","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-DRTlAUHe.js'))
			},
			{
				id: "/api/nexus/search",
				pattern: /^\/api\/nexus\/search\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-CHosoYVM.js'))
			},
			{
				id: "/api/nexus/symbol/[name]",
				pattern: /^\/api\/nexus\/symbol\/([^/]+?)\/?$/,
				params: [{"name":"name","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-CEvKCtpE.js'))
			},
			{
				id: "/api/search",
				pattern: /^\/api\/search\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-CPZ9_WGB.js'))
			},
			{
				id: "/api/tasks",
				pattern: /^\/api\/tasks\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-DBqlXoy2.js'))
			},
			{
				id: "/api/tasks/events",
				pattern: /^\/api\/tasks\/events\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-B2lI9Poi.js'))
			},
			{
				id: "/api/tasks/pipeline",
				pattern: /^\/api\/tasks\/pipeline\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-C_15_Wni.js'))
			},
			{
				id: "/api/tasks/sessions",
				pattern: /^\/api\/tasks\/sessions\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-Ck4yKoTS.js'))
			},
			{
				id: "/api/tasks/tree/[epicId]",
				pattern: /^\/api\/tasks\/tree\/([^/]+?)\/?$/,
				params: [{"name":"epicId","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-Ct-7KOM6.js'))
			},
			{
				id: "/api/tasks/[id]",
				pattern: /^\/api\/tasks\/([^/]+?)\/?$/,
				params: [{"name":"id","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-DRU3d_yY.js'))
			},
			{
				id: "/brain",
				pattern: /^\/brain\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 3 },
				endpoint: null
			},
			{
				id: "/brain/decisions",
				pattern: /^\/brain\/decisions\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 4 },
				endpoint: null
			},
			{
				id: "/brain/graph",
				pattern: /^\/brain\/graph\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 5 },
				endpoint: null
			},
			{
				id: "/brain/observations",
				pattern: /^\/brain\/observations\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 6 },
				endpoint: null
			},
			{
				id: "/brain/quality",
				pattern: /^\/brain\/quality\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 7 },
				endpoint: null
			},
			{
				id: "/nexus",
				pattern: /^\/nexus\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 8 },
				endpoint: null
			},
			{
				id: "/nexus/community/[id]",
				pattern: /^\/nexus\/community\/([^/]+?)\/?$/,
				params: [{"name":"id","optional":false,"rest":false,"chained":false}],
				page: { layouts: [0,], errors: [1,], leaf: 9 },
				endpoint: null
			},
			{
				id: "/nexus/symbol/[name]",
				pattern: /^\/nexus\/symbol\/([^/]+?)\/?$/,
				params: [{"name":"name","optional":false,"rest":false,"chained":false}],
				page: { layouts: [0,], errors: [1,], leaf: 10 },
				endpoint: null
			},
			{
				id: "/projects",
				pattern: /^\/projects\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 11 },
				endpoint: null
			},
			{
				id: "/tasks",
				pattern: /^\/tasks\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 12 },
				endpoint: null
			},
			{
				id: "/tasks/pipeline",
				pattern: /^\/tasks\/pipeline\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 14 },
				endpoint: null
			},
			{
				id: "/tasks/sessions",
				pattern: /^\/tasks\/sessions\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 15 },
				endpoint: null
			},
			{
				id: "/tasks/tree/[epicId]",
				pattern: /^\/tasks\/tree\/([^/]+?)\/?$/,
				params: [{"name":"epicId","optional":false,"rest":false,"chained":false}],
				page: { layouts: [0,], errors: [1,], leaf: 16 },
				endpoint: null
			},
			{
				id: "/tasks/[id]",
				pattern: /^\/tasks\/([^/]+?)\/?$/,
				params: [{"name":"id","optional":false,"rest":false,"chained":false}],
				page: { layouts: [0,], errors: [1,], leaf: 13 },
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
