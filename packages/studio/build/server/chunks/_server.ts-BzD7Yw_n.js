import { c as getDbStatus } from './connections-C-btvhSI.js';
import { json } from '@sveltejs/kit';
import './cleo-home-BSckk0xW.js';
import 'node:fs';
import 'node:path';
import 'node:os';
import 'node:module';

//#region src/routes/api/health/+server.ts
/**
* Health check endpoint for the CLEO Studio server.
* GET /api/health → { ok: true, version: string, databases: {...} }
*/
var GET = ({ locals }) => {
	const dbStatus = getDbStatus(locals.projectCtx);
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
//# sourceMappingURL=_server.ts-BzD7Yw_n.js.map
