import { c as getDbStatus } from './connections-BR9V-1fV.js';
import { json } from '@sveltejs/kit';
import './cleo-home-hJ0l__SG.js';
import 'node:fs';
import 'node:os';
import 'node:path';
import 'node:module';

//#region src/routes/api/health/+server.ts
/**
* Health check endpoint for the CLEO Studio server.
* GET /api/health → { ok: true, version: string, databases: {...} }
*/
var GET = () => {
	const dbStatus = getDbStatus();
	return json({
		ok: true,
		service: "cleo-studio",
		version: "2026.4.47",
		databases: {
			nexus: dbStatus.nexus ? "available" : "not found",
			brain: dbStatus.brain ? "available" : "not found",
			tasks: dbStatus.tasks ? "available" : "not found"
		},
		paths: {
			nexus: dbStatus.nexusPath,
			brain: dbStatus.brainPath,
			tasks: dbStatus.tasksPath
		}
	});
};

export { GET };
//# sourceMappingURL=_server.ts-DUVJ0ePN.js.map
