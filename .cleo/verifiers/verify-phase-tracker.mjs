#!/usr/bin/env node
// Phase tracker verifier — asserts that the children of the phase epic are done.
// Phase trackers are container epics; pass if all children are completed/archived.
import { execSync } from "node:child_process";
const tid = process.argv[2];
if (!tid) { console.error("usage: verify-phase-tracker.mjs <epicId>"); process.exit(2); }
try {
  const out = execSync(`cleo list --parent ${tid} --limit 100`, { encoding: "utf8" });
  const data = JSON.parse(out).data || {};
  const tasks = data.tasks || [];
  const incomplete = tasks.filter(t => !["done","archived","cancelled"].includes(t.status));
  if (incomplete.length === 0) { console.log(`OK: all ${tasks.length} children of ${tid} are complete`); process.exit(0); }
  console.error(`FAIL: ${incomplete.length} children incomplete:`, incomplete.map(t => `${t.id}=${t.status}`).join(", "));
  process.exit(1);
} catch (e) { console.error("ERR:", e.message); process.exit(2); }
