export const manifest = (() => {
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
		client: {start:"_app/immutable/entry/start.DEwmZnxG.js",app:"_app/immutable/entry/app.BUP-wz2W.js",imports:["_app/immutable/entry/start.DEwmZnxG.js","_app/immutable/chunks/lNG2k0Yr.js","_app/immutable/chunks/BaLXwP8b.js","_app/immutable/entry/app.BUP-wz2W.js","_app/immutable/chunks/BaLXwP8b.js","_app/immutable/chunks/DKwHt3Ho.js","_app/immutable/chunks/ibwe1TAv.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
		nodes: [
			__memo(() => import('./nodes/0.js')),
			__memo(() => import('./nodes/1.js')),
			__memo(() => import('./nodes/2.js')),
			__memo(() => import('./nodes/3.js')),
			__memo(() => import('./nodes/4.js')),
			__memo(() => import('./nodes/5.js')),
			__memo(() => import('./nodes/6.js')),
			__memo(() => import('./nodes/7.js')),
			__memo(() => import('./nodes/8.js')),
			__memo(() => import('./nodes/9.js')),
			__memo(() => import('./nodes/10.js')),
			__memo(() => import('./nodes/11.js')),
			__memo(() => import('./nodes/12.js')),
			__memo(() => import('./nodes/13.js')),
			__memo(() => import('./nodes/14.js')),
			__memo(() => import('./nodes/15.js')),
			__memo(() => import('./nodes/16.js')),
			__memo(() => import('./nodes/17.js'))
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
				endpoint: __memo(() => import('./entries/endpoints/api/brain/decisions/_server.ts.js'))
			},
			{
				id: "/api/brain/graph",
				pattern: /^\/api\/brain\/graph\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/brain/graph/_server.ts.js'))
			},
			{
				id: "/api/brain/observations",
				pattern: /^\/api\/brain\/observations\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/brain/observations/_server.ts.js'))
			},
			{
				id: "/api/brain/quality",
				pattern: /^\/api\/brain\/quality\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/brain/quality/_server.ts.js'))
			},
			{
				id: "/api/health",
				pattern: /^\/api\/health\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/health/_server.ts.js'))
			},
			{
				id: "/api/living-brain",
				pattern: /^\/api\/living-brain\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/living-brain/_server.ts.js'))
			},
			{
				id: "/api/living-brain/node/[id]",
				pattern: /^\/api\/living-brain\/node\/([^/]+?)\/?$/,
				params: [{"name":"id","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/living-brain/node/_id_/_server.ts.js'))
			},
			{
				id: "/api/living-brain/stream",
				pattern: /^\/api\/living-brain\/stream\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/living-brain/stream/_server.ts.js'))
			},
			{
				id: "/api/living-brain/substrate/[name]",
				pattern: /^\/api\/living-brain\/substrate\/([^/]+?)\/?$/,
				params: [{"name":"name","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/living-brain/substrate/_name_/_server.ts.js'))
			},
			{
				id: "/api/nexus",
				pattern: /^\/api\/nexus\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/nexus/_server.ts.js'))
			},
			{
				id: "/api/nexus/community/[id]",
				pattern: /^\/api\/nexus\/community\/([^/]+?)\/?$/,
				params: [{"name":"id","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/nexus/community/_id_/_server.ts.js'))
			},
			{
				id: "/api/nexus/search",
				pattern: /^\/api\/nexus\/search\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/nexus/search/_server.ts.js'))
			},
			{
				id: "/api/nexus/symbol/[name]",
				pattern: /^\/api\/nexus\/symbol\/([^/]+?)\/?$/,
				params: [{"name":"name","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/nexus/symbol/_name_/_server.ts.js'))
			},
			{
				id: "/api/project/switch",
				pattern: /^\/api\/project\/switch\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/project/switch/_server.ts.js'))
			},
			{
				id: "/api/search",
				pattern: /^\/api\/search\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/search/_server.ts.js'))
			},
			{
				id: "/api/tasks",
				pattern: /^\/api\/tasks\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/tasks/_server.ts.js'))
			},
			{
				id: "/api/tasks/events",
				pattern: /^\/api\/tasks\/events\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/tasks/events/_server.ts.js'))
			},
			{
				id: "/api/tasks/pipeline",
				pattern: /^\/api\/tasks\/pipeline\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/tasks/pipeline/_server.ts.js'))
			},
			{
				id: "/api/tasks/sessions",
				pattern: /^\/api\/tasks\/sessions\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/tasks/sessions/_server.ts.js'))
			},
			{
				id: "/api/tasks/tree/[epicId]",
				pattern: /^\/api\/tasks\/tree\/([^/]+?)\/?$/,
				params: [{"name":"epicId","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/tasks/tree/_epicId_/_server.ts.js'))
			},
			{
				id: "/api/tasks/[id]",
				pattern: /^\/api\/tasks\/([^/]+?)\/?$/,
				params: [{"name":"id","optional":false,"rest":false,"chained":false}],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/tasks/_id_/_server.ts.js'))
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

export const prerendered = new Set([]);

export const base = "";