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
		client: {start:"_app/immutable/entry/start.B4djkgEu.js",app:"_app/immutable/entry/app.CpVah3oA.js",imports:["_app/immutable/entry/start.B4djkgEu.js","_app/immutable/chunks/dVYxnWpL.js","_app/immutable/chunks/CC_7gvW7.js","_app/immutable/entry/app.CpVah3oA.js","_app/immutable/chunks/CC_7gvW7.js","_app/immutable/chunks/DKwHt3Ho.js","_app/immutable/chunks/ibwe1TAv.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
		nodes: [
			__memo(() => import('./chunks/0-C6_3LK8w.js')),
			__memo(() => import('./chunks/1-C6cTpjJ5.js')),
			__memo(() => import('./chunks/2-DH4G59PK.js')),
			__memo(() => import('./chunks/3-B6ur6jWD.js')),
			__memo(() => import('./chunks/4-lKfiQLl2.js')),
			__memo(() => import('./chunks/5-jaFNqXJq.js')),
			__memo(() => import('./chunks/6-QEEqIpf6.js')),
			__memo(() => import('./chunks/7-DbBue0MU.js')),
			__memo(() => import('./chunks/8-DHEmOjSc.js')),
			__memo(() => import('./chunks/9-De-b0iXE.js')),
			__memo(() => import('./chunks/10-pHOkDX2K.js')),
			__memo(() => import('./chunks/11-K345URBQ.js')),
			__memo(() => import('./chunks/12-jL00Yw-p.js')),
			__memo(() => import('./chunks/13-CbqfG5_k.js')),
			__memo(() => import('./chunks/14-R16hI9FF.js')),
			__memo(() => import('./chunks/15-CRNW9TLf.js')),
			__memo(() => import('./chunks/16-CzBz8d8f.js')),
			__memo(() => import('./chunks/17-Dqrzkmc_.js'))
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
				endpoint: __memo(() => import('./chunks/_server.ts-D-pHBL9K.js'))
			},
			{
				id: "/api/brain/graph",
				pattern: /^\/api\/brain\/graph\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-Dbt5DD0b.js'))
			},
			{
				id: "/api/brain/observations",
				pattern: /^\/api\/brain\/observations\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-F8a8rmuv.js'))
			},
			{
				id: "/api/brain/quality",
				pattern: /^\/api\/brain\/quality\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-CKI5WKmO.js'))
			},
			{
				id: "/api/health",
				pattern: /^\/api\/health\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-DUVJ0ePN.js'))
			},
			{
				id: "/api/living-brain",
				pattern: /^\/api\/living-brain\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-BBy0pSi1.js'))
			},
			{
				id: "/api/living-brain/node/[id]",
				pattern: /^\/api\/living-brain\/node\/([^/]+?)\/?$/,
				params: [{"name":"id","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-BOp9I6Wi.js'))
			},
			{
				id: "/api/living-brain/substrate/[name]",
				pattern: /^\/api\/living-brain\/substrate\/([^/]+?)\/?$/,
				params: [{"name":"name","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-D0NVM9S3.js'))
			},
			{
				id: "/api/nexus",
				pattern: /^\/api\/nexus\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-DR5nwGwj.js'))
			},
			{
				id: "/api/nexus/community/[id]",
				pattern: /^\/api\/nexus\/community\/([^/]+?)\/?$/,
				params: [{"name":"id","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-lLIaMc-o.js'))
			},
			{
				id: "/api/nexus/search",
				pattern: /^\/api\/nexus\/search\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-Bun-sYvp.js'))
			},
			{
				id: "/api/nexus/symbol/[name]",
				pattern: /^\/api\/nexus\/symbol\/([^/]+?)\/?$/,
				params: [{"name":"name","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-BWx3w2Pn.js'))
			},
			{
				id: "/api/search",
				pattern: /^\/api\/search\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-Du7Cucow.js'))
			},
			{
				id: "/api/tasks",
				pattern: /^\/api\/tasks\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-BQ2NpIlB.js'))
			},
			{
				id: "/api/tasks/events",
				pattern: /^\/api\/tasks\/events\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-JWwIIwJd.js'))
			},
			{
				id: "/api/tasks/pipeline",
				pattern: /^\/api\/tasks\/pipeline\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-BfMWVnjA.js'))
			},
			{
				id: "/api/tasks/sessions",
				pattern: /^\/api\/tasks\/sessions\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-THw-zNsa.js'))
			},
			{
				id: "/api/tasks/tree/[epicId]",
				pattern: /^\/api\/tasks\/tree\/([^/]+?)\/?$/,
				params: [{"name":"epicId","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-hxGF82VX.js'))
			},
			{
				id: "/api/tasks/[id]",
				pattern: /^\/api\/tasks\/([^/]+?)\/?$/,
				params: [{"name":"id","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-aC1XcPTF.js'))
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
				id: "/living-brain",
				pattern: /^\/living-brain\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 8 },
				endpoint: null
			},
			{
				id: "/nexus",
				pattern: /^\/nexus\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 9 },
				endpoint: null
			},
			{
				id: "/nexus/community/[id]",
				pattern: /^\/nexus\/community\/([^/]+?)\/?$/,
				params: [{"name":"id","optional":false,"rest":false,"chained":false}],
				page: { layouts: [0,], errors: [1,], leaf: 10 },
				endpoint: null
			},
			{
				id: "/nexus/symbol/[name]",
				pattern: /^\/nexus\/symbol\/([^/]+?)\/?$/,
				params: [{"name":"name","optional":false,"rest":false,"chained":false}],
				page: { layouts: [0,], errors: [1,], leaf: 11 },
				endpoint: null
			},
			{
				id: "/projects",
				pattern: /^\/projects\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 12 },
				endpoint: null
			},
			{
				id: "/tasks",
				pattern: /^\/tasks\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 13 },
				endpoint: null
			},
			{
				id: "/tasks/pipeline",
				pattern: /^\/tasks\/pipeline\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 15 },
				endpoint: null
			},
			{
				id: "/tasks/sessions",
				pattern: /^\/tasks\/sessions\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 16 },
				endpoint: null
			},
			{
				id: "/tasks/tree/[epicId]",
				pattern: /^\/tasks\/tree\/([^/]+?)\/?$/,
				params: [{"name":"epicId","optional":false,"rest":false,"chained":false}],
				page: { layouts: [0,], errors: [1,], leaf: 17 },
				endpoint: null
			},
			{
				id: "/tasks/[id]",
				pattern: /^\/tasks\/([^/]+?)\/?$/,
				params: [{"name":"id","optional":false,"rest":false,"chained":false}],
				page: { layouts: [0,], errors: [1,], leaf: 14 },
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
