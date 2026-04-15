import { g as getNexusDb } from './connections-C-btvhSI.js';
import { json } from '@sveltejs/kit';
import './cleo-home-BSckk0xW.js';
import 'node:fs';
import 'node:path';
import 'node:os';
import 'node:module';

//#region src/routes/api/nexus/search/+server.ts
/**
* GET /api/nexus/search?q=xxx
*
* Returns up to 20 symbol matches for the given query string.
* Searches label and id fields with LIKE, preferring exact label matches first.
*/
var GET = ({ url }) => {
	const db = getNexusDb();
	if (!db) return json({ error: "nexus.db not available" }, { status: 503 });
	const q = url.searchParams.get("q")?.trim() ?? "";
	if (q.length < 2) return json([]);
	const like = `%${q}%`;
	return json(db.prepare(`SELECT id, label, kind, file_path, community_id
       FROM nexus_nodes
       WHERE label LIKE ? OR id LIKE ?
       ORDER BY
         CASE WHEN label = ? THEN 0
              WHEN label LIKE ? THEN 1
              ELSE 2 END,
         length(label)
       LIMIT 20`).all(like, like, q, `${q}%`).map((row) => ({
		id: row.id,
		label: row.label,
		kind: row.kind,
		filePath: row.file_path ?? "",
		communityId: row.community_id
	})));
};

export { GET };
//# sourceMappingURL=_server.ts-CzWrvVob.js.map
