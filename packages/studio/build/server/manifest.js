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
		client: {start:"_app/immutable/entry/start.zh-HcglA.js",app:"_app/immutable/entry/app.dOHGKaTf.js",imports:["_app/immutable/entry/start.zh-HcglA.js","_app/immutable/chunks/ltU5_Kh5.js","_app/immutable/chunks/ZT3WoQr4.js","_app/immutable/entry/app.dOHGKaTf.js","_app/immutable/chunks/ZT3WoQr4.js","_app/immutable/chunks/DKwHt3Ho.js","_app/immutable/chunks/ibwe1TAv.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
		nodes: [
			__memo(() => import('./chunks/0-CzCkOP4c.js')),
			__memo(() => import('./chunks/1-CJTNQ65d.js')),
			__memo(() => import('./chunks/2-cR9rWr3i.js')),
			__memo(() => import('./chunks/3-Bgvy9VsB.js')),
			__memo(() => import('./chunks/4-rh6QZhJD.js')),
			__memo(() => import('./chunks/5-CRLIbFup.js')),
			__memo(() => import('./chunks/6-wSBeO7UC.js')),
			__memo(() => import('./chunks/7-CHXK06fl.js')),
			__memo(() => import('./chunks/8-DmYU4eNQ.js')),
			__memo(() => import('./chunks/9-BGRlq8Wh.js')),
			__memo(() => import('./chunks/10-BfaTf2Pd.js')),
			__memo(() => import('./chunks/11-84e_PX4v.js')),
			__memo(() => import('./chunks/12-CsQeaaj7.js')),
			__memo(() => import('./chunks/13-C55_QYTu.js')),
			__memo(() => import('./chunks/14-BR1BnPhO.js')),
			__memo(() => import('./chunks/15-Dj_GKm-Q.js')),
			__memo(() => import('./chunks/16-DoMS_X2b.js')),
			__memo(() => import('./chunks/17-CyUE5xR6.js'))
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
				endpoint: __memo(() => import('./chunks/_server.ts-7JkDyBU8.js'))
			},
			{
				id: "/api/brain/graph",
				pattern: /^\/api\/brain\/graph\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-Ah7hdjI9.js'))
			},
			{
				id: "/api/brain/observations",
				pattern: /^\/api\/brain\/observations\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-BfVFZJZg.js'))
			},
			{
				id: "/api/brain/quality",
				pattern: /^\/api\/brain\/quality\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-BtA_iRqW.js'))
			},
			{
				id: "/api/health",
				pattern: /^\/api\/health\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-BzD7Yw_n.js'))
			},
			{
				id: "/api/living-brain",
				pattern: /^\/api\/living-brain\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-CCpu-wJZ.js'))
			},
			{
				id: "/api/living-brain/node/[id]",
				pattern: /^\/api\/living-brain\/node\/([^/]+?)\/?$/,
				params: [{"name":"id","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-DrKaGqbL.js'))
			},
			{
				id: "/api/living-brain/stream",
				pattern: /^\/api\/living-brain\/stream\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-CHitXP3F.js'))
			},
			{
				id: "/api/living-brain/substrate/[name]",
				pattern: /^\/api\/living-brain\/substrate\/([^/]+?)\/?$/,
				params: [{"name":"name","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-LSRVZBpk.js'))
			},
			{
				id: "/api/nexus",
				pattern: /^\/api\/nexus\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-nRpBjQaC.js'))
			},
			{
				id: "/api/nexus/community/[id]",
				pattern: /^\/api\/nexus\/community\/([^/]+?)\/?$/,
				params: [{"name":"id","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-nEYHoDB8.js'))
			},
			{
				id: "/api/nexus/search",
				pattern: /^\/api\/nexus\/search\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-CzWrvVob.js'))
			},
			{
				id: "/api/nexus/symbol/[name]",
				pattern: /^\/api\/nexus\/symbol\/([^/]+?)\/?$/,
				params: [{"name":"name","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-C6OZ4Ejt.js'))
			},
			{
				id: "/api/project/clean",
				pattern: /^\/api\/project\/clean\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-CLkcAu1T.js'))
			},
			{
				id: "/api/project/scan",
				pattern: /^\/api\/project\/scan\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-CzBvBmU1.js'))
			},
			{
				id: "/api/project/switch",
				pattern: /^\/api\/project\/switch\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-DL36GSFr.js'))
			},
			{
				id: "/api/project/[id]",
				pattern: /^\/api\/project\/([^/]+?)\/?$/,
				params: [{"name":"id","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-C2pBWBn-.js'))
			},
			{
				id: "/api/project/[id]/index",
				pattern: /^\/api\/project\/([^/]+?)\/index\/?$/,
				params: [{"name":"id","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-dSXbK-7K.js'))
			},
			{
				id: "/api/project/[id]/reindex",
				pattern: /^\/api\/project\/([^/]+?)\/reindex\/?$/,
				params: [{"name":"id","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-BLN1xOGp.js'))
			},
			{
				id: "/api/search",
				pattern: /^\/api\/search\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-D1s-ddOO.js'))
			},
			{
				id: "/api/tasks",
				pattern: /^\/api\/tasks\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-rReR9aQL.js'))
			},
			{
				id: "/api/tasks/events",
				pattern: /^\/api\/tasks\/events\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-D07AdoQo.js'))
			},
			{
				id: "/api/tasks/pipeline",
				pattern: /^\/api\/tasks\/pipeline\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-CpGsYyCZ.js'))
			},
			{
				id: "/api/tasks/sessions",
				pattern: /^\/api\/tasks\/sessions\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-BrXpM19N.js'))
			},
			{
				id: "/api/tasks/tree/[epicId]",
				pattern: /^\/api\/tasks\/tree\/([^/]+?)\/?$/,
				params: [{"name":"epicId","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-B1YaJWKi.js'))
			},
			{
				id: "/api/tasks/[id]",
				pattern: /^\/api\/tasks\/([^/]+?)\/?$/,
				params: [{"name":"id","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-Cyw1rM9o.js'))
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
				id: "/brain/overview",
				pattern: /^\/brain\/overview\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 7 },
				endpoint: null
			},
			{
				id: "/brain/quality",
				pattern: /^\/brain\/quality\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 8 },
				endpoint: null
			},
			{
				id: "/code",
				pattern: /^\/code\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 9 },
				endpoint: null
			},
			{
				id: "/code/community/[id]",
				pattern: /^\/code\/community\/([^/]+?)\/?$/,
				params: [{"name":"id","optional":false,"rest":false,"chained":false}],
				page: { layouts: [0,], errors: [1,], leaf: 10 },
				endpoint: null
			},
			{
				id: "/code/symbol/[name]",
				pattern: /^\/code\/symbol\/([^/]+?)\/?$/,
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
