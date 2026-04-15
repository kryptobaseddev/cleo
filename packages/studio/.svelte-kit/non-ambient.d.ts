
// this file is generated — do not edit it


declare module "svelte/elements" {
	export interface HTMLAttributes<T> {
		'data-sveltekit-keepfocus'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-noscroll'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-preload-code'?:
			| true
			| ''
			| 'eager'
			| 'viewport'
			| 'hover'
			| 'tap'
			| 'off'
			| undefined
			| null;
		'data-sveltekit-preload-data'?: true | '' | 'hover' | 'tap' | 'off' | undefined | null;
		'data-sveltekit-reload'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-replacestate'?: true | '' | 'off' | undefined | null;
	}
}

export {};


declare module "$app/types" {
	type MatcherParam<M> = M extends (param : string) => param is (infer U extends string) ? U : string;

	export interface AppTypes {
		RouteId(): "/" | "/api" | "/api/brain" | "/api/brain/decisions" | "/api/brain/graph" | "/api/brain/observations" | "/api/brain/quality" | "/api/health" | "/api/living-brain" | "/api/living-brain/node" | "/api/living-brain/node/[id]" | "/api/living-brain/stream" | "/api/living-brain/stream/__tests__" | "/api/living-brain/substrate" | "/api/living-brain/substrate/[name]" | "/api/nexus" | "/api/nexus/community" | "/api/nexus/community/[id]" | "/api/nexus/search" | "/api/nexus/symbol" | "/api/nexus/symbol/[name]" | "/api/project" | "/api/project/switch" | "/api/search" | "/api/tasks" | "/api/tasks/events" | "/api/tasks/pipeline" | "/api/tasks/sessions" | "/api/tasks/tree" | "/api/tasks/tree/[epicId]" | "/api/tasks/[id]" | "/brain" | "/brain/__tests__" | "/brain/decisions" | "/brain/graph" | "/brain/observations" | "/brain/overview" | "/brain/quality" | "/code" | "/code/community" | "/code/community/[id]" | "/code/symbol" | "/code/symbol/[name]" | "/projects" | "/tasks" | "/tasks/pipeline" | "/tasks/sessions" | "/tasks/tree" | "/tasks/tree/[epicId]" | "/tasks/[id]";
		RouteParams(): {
			"/api/living-brain/node/[id]": { id: string };
			"/api/living-brain/substrate/[name]": { name: string };
			"/api/nexus/community/[id]": { id: string };
			"/api/nexus/symbol/[name]": { name: string };
			"/api/tasks/tree/[epicId]": { epicId: string };
			"/api/tasks/[id]": { id: string };
			"/code/community/[id]": { id: string };
			"/code/symbol/[name]": { name: string };
			"/tasks/tree/[epicId]": { epicId: string };
			"/tasks/[id]": { id: string }
		};
		LayoutParams(): {
			"/": { id?: string; name?: string; epicId?: string };
			"/api": { id?: string; name?: string; epicId?: string };
			"/api/brain": Record<string, never>;
			"/api/brain/decisions": Record<string, never>;
			"/api/brain/graph": Record<string, never>;
			"/api/brain/observations": Record<string, never>;
			"/api/brain/quality": Record<string, never>;
			"/api/health": Record<string, never>;
			"/api/living-brain": { id?: string; name?: string };
			"/api/living-brain/node": { id?: string };
			"/api/living-brain/node/[id]": { id: string };
			"/api/living-brain/stream": Record<string, never>;
			"/api/living-brain/stream/__tests__": Record<string, never>;
			"/api/living-brain/substrate": { name?: string };
			"/api/living-brain/substrate/[name]": { name: string };
			"/api/nexus": { id?: string; name?: string };
			"/api/nexus/community": { id?: string };
			"/api/nexus/community/[id]": { id: string };
			"/api/nexus/search": Record<string, never>;
			"/api/nexus/symbol": { name?: string };
			"/api/nexus/symbol/[name]": { name: string };
			"/api/project": Record<string, never>;
			"/api/project/switch": Record<string, never>;
			"/api/search": Record<string, never>;
			"/api/tasks": { epicId?: string; id?: string };
			"/api/tasks/events": Record<string, never>;
			"/api/tasks/pipeline": Record<string, never>;
			"/api/tasks/sessions": Record<string, never>;
			"/api/tasks/tree": { epicId?: string };
			"/api/tasks/tree/[epicId]": { epicId: string };
			"/api/tasks/[id]": { id: string };
			"/brain": Record<string, never>;
			"/brain/__tests__": Record<string, never>;
			"/brain/decisions": Record<string, never>;
			"/brain/graph": Record<string, never>;
			"/brain/observations": Record<string, never>;
			"/brain/overview": Record<string, never>;
			"/brain/quality": Record<string, never>;
			"/code": { id?: string; name?: string };
			"/code/community": { id?: string };
			"/code/community/[id]": { id: string };
			"/code/symbol": { name?: string };
			"/code/symbol/[name]": { name: string };
			"/projects": Record<string, never>;
			"/tasks": { epicId?: string; id?: string };
			"/tasks/pipeline": Record<string, never>;
			"/tasks/sessions": Record<string, never>;
			"/tasks/tree": { epicId?: string };
			"/tasks/tree/[epicId]": { epicId: string };
			"/tasks/[id]": { id: string }
		};
		Pathname(): "/" | "/api/brain/decisions" | "/api/brain/graph" | "/api/brain/observations" | "/api/brain/quality" | "/api/health" | "/api/living-brain" | `/api/living-brain/node/${string}` & {} | "/api/living-brain/stream" | `/api/living-brain/substrate/${string}` & {} | "/api/nexus" | `/api/nexus/community/${string}` & {} | "/api/nexus/search" | `/api/nexus/symbol/${string}` & {} | "/api/project/switch" | "/api/search" | "/api/tasks" | "/api/tasks/events" | "/api/tasks/pipeline" | "/api/tasks/sessions" | `/api/tasks/tree/${string}` & {} | `/api/tasks/${string}` & {} | "/brain" | "/brain/decisions" | "/brain/graph" | "/brain/observations" | "/brain/overview" | "/brain/quality" | "/code" | `/code/community/${string}` & {} | `/code/symbol/${string}` & {} | "/projects" | "/tasks" | "/tasks/pipeline" | "/tasks/sessions" | `/tasks/tree/${string}` & {} | `/tasks/${string}` & {};
		ResolvedPathname(): `${"" | `/${string}`}${ReturnType<AppTypes['Pathname']>}`;
		Asset(): "/favicon.png" | string & {};
	}
}