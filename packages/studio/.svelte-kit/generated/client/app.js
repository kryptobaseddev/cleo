export { matchers } from './matchers.js';

export const nodes = [
	() => import('./nodes/0'),
	() => import('./nodes/1'),
	() => import('./nodes/2'),
	() => import('./nodes/3'),
	() => import('./nodes/4'),
	() => import('./nodes/5'),
	() => import('./nodes/6'),
	() => import('./nodes/7'),
	() => import('./nodes/8'),
	() => import('./nodes/9'),
	() => import('./nodes/10'),
	() => import('./nodes/11'),
	() => import('./nodes/12'),
	() => import('./nodes/13'),
	() => import('./nodes/14'),
	() => import('./nodes/15'),
	() => import('./nodes/16'),
	() => import('./nodes/17')
];

export const server_loads = [];

export const dictionary = {
		"/": [~2],
		"/brain": [~3],
		"/brain/decisions": [4],
		"/brain/graph": [5],
		"/brain/observations": [6],
		"/brain/quality": [7],
		"/living-brain": [~8],
		"/nexus": [~9],
		"/nexus/community/[id]": [~10],
		"/nexus/symbol/[name]": [~11],
		"/projects": [~12],
		"/tasks": [~13],
		"/tasks/pipeline": [~15],
		"/tasks/sessions": [~16],
		"/tasks/tree/[epicId]": [~17],
		"/tasks/[id]": [~14]
	};

export const hooks = {
	handleError: (({ error }) => { console.error(error) }),
	
	reroute: (() => {}),
	transport: {}
};

export const decoders = Object.fromEntries(Object.entries(hooks.transport).map(([k, v]) => [k, v.decode]));
export const encoders = Object.fromEntries(Object.entries(hooks.transport).map(([k, v]) => [k, v.encode]));

export const hash = false;

export const decode = (type, value) => decoders[type](value);

export { default as root } from '../root.js';