/**
 * Hermes `~/.hermes/skills/.usage.json` → CLEO `skills.db` migrator.
 *
 * Reads the Hermes sidecar (one JSON object keyed by skill name), maps
 * Hermes provenance into the CLEO `source_type` enum, and inserts
 * equivalent rows into `skills.db` via the
 * {@link bulkImportFromHermes} adapter helper.
 *
 * Counter fields (`use_count`, `view_count`, `patch_count`) are
 * synthesized into `skill_usage` rows so the freshly-imported registry
 * is queryable by `cleo skills stats` immediately after migration.
 *
 * ## Provenance mapping
 *
 * The Hermes sidecar exposes `created_by` (`agent` / `null`) and a
 * separate `.bundled_manifest` file listing hub-bundled skills as
 * `<name>:<sha>` lines. The mapping is:
 *
 * | Hermes signal                   | CLEO `source_type` |
 * |---------------------------------|--------------------|
 * | `created_by == 'agent'`         | `agent-created`    |
 * | listed in `.bundled_manifest`   | `canonical`        |
 * | otherwise                       | `user`             |
 *
 * `community` is intentionally NEVER produced — Hermes' marketplace
 * concept doesn't have a 1:1 equivalent so we conservatively label
 * those as `user` and let the operator promote them later via
 * `cleo skills mark-community` (out of scope for T9691).
 *
 * @task T9691
 * @epic T9561
 * @saga T9560
 * @architecture docs/architecture/SG-CLEO-SKILLS-architecture-v3.md §4
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  SkillImportHermesRequest,
  SkillImportHermesResponse,
  SkillImportHermesRow,
} from '@cleocode/contracts';
import { withProvenance } from '../sentient/skill-provenance.js';
import type {
  NewSkillRow,
  NewSkillUsageRow,
  SkillSourceType,
} from '../store/schema/skills-schema.js';
import { upsertSkillRow } from '../store/skills-db.js';
import { insertUsage } from '../store/skills-store.js';

// ---------------------------------------------------------------------------
// Hermes sidecar shape
// ---------------------------------------------------------------------------

/**
 * One entry in `~/.hermes/skills/.usage.json`.
 *
 * Fields that are absent on a per-skill basis (e.g. fresh installs with no
 * patches yet) are null-or-zero by Hermes convention.
 */
interface HermesUsageEntry {
  archived_at: string | null;
  created_at: string;
  created_by: 'agent' | null;
  last_patched_at: string | null;
  last_used_at: string | null;
  last_viewed_at: string | null;
  patch_count: number;
  pinned: boolean;
  state: 'active' | 'stale' | 'archived';
  use_count: number;
  view_count: number;
}

/**
 * Top-level Hermes sidecar shape — a flat record keyed by skill name.
 */
type HermesUsageSidecar = Record<string, HermesUsageEntry>;

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the Hermes home dir from request overrides + `$HOME` fallback.
 *
 * Always returns an absolute path. Does NOT verify the directory exists —
 * the caller checks for the sidecar file specifically.
 */
function resolveHermesHome(overrideRoot: string | undefined): string {
  if (overrideRoot) return overrideRoot;
  const env = process.env['HERMES_HOME'];
  if (env) return env;
  return join(homedir(), '.hermes');
}

/**
 * Parse the Hermes `.bundled_manifest` into a set of bundled skill names.
 *
 * Each line is `<name>:<hash>`. Lines without a colon are skipped silently.
 * Returns an empty set if the manifest file does not exist.
 */
function readBundledManifest(skillsRoot: string): Set<string> {
  const manifestPath = join(skillsRoot, '.bundled_manifest');
  if (!existsSync(manifestPath)) return new Set();
  const raw = readFileSync(manifestPath, 'utf-8');
  const names = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    names.add(trimmed.slice(0, colon));
  }
  return names;
}

/**
 * Read + parse the Hermes `.usage.json` sidecar.
 *
 * Returns `null` if the sidecar does not exist — callers treat that as
 * "nothing to import" and short-circuit.
 *
 * @throws {Error} If the file exists but is not valid JSON.
 */
function readHermesSidecar(skillsRoot: string): HermesUsageSidecar | null {
  const sidecarPath = join(skillsRoot, '.usage.json');
  if (!existsSync(sidecarPath)) return null;
  const raw = readFileSync(sidecarPath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Hermes sidecar at ${sidecarPath} is not a JSON object`);
  }
  return parsed as HermesUsageSidecar;
}

// ---------------------------------------------------------------------------
// Provenance + state mapping
// ---------------------------------------------------------------------------

/**
 * Map Hermes provenance signals to the CLEO `SkillSourceType` enum.
 *
 * See the architecture v3 §4 table for the canonical mapping rules.
 */
function mapSourceType(
  entry: HermesUsageEntry,
  bundled: Set<string>,
  name: string,
): SkillSourceType {
  if (entry.created_by === 'agent') return 'agent-created';
  if (bundled.has(name)) return 'canonical';
  return 'user';
}

/**
 * Coerce a Hermes `state` value into the CLEO `lifecycle_state` enum.
 *
 * Hermes uses the same three labels so this is a noop in practice; we
 * keep the helper for forward-compat if either side ever extends the
 * enum.
 */
function mapLifecycleState(state: HermesUsageEntry['state']): 'active' | 'stale' | 'archived' {
  return state;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the Hermes → CLEO migration as described by {@link SkillImportHermesRequest}.
 *
 * Behaviour:
 *   1. Resolve Hermes home (request override > $HERMES_HOME > ~/.hermes).
 *   2. Read `<hermesHome>/skills/.usage.json` (skip silently if absent).
 *   3. Read `<hermesHome>/skills/.bundled_manifest` for canonical mapping.
 *   4. For each entry, derive the `skills` row + synthesize usage counters.
 *   5. Upsert atomically via `upsertSkillRow` (idempotent by `name`).
 *
 * The dry-run mode walks the same code paths but skips writes. The returned
 * response is identical in shape — callers can diff dry-run vs real-run
 * outcomes without re-invoking.
 *
 * @param request - Import request envelope.
 * @returns Per-row outcomes + summary counters.
 *
 * @task T9691
 */
export async function importFromHermes(
  request: SkillImportHermesRequest = {},
): Promise<SkillImportHermesResponse> {
  const hermesHome = resolveHermesHome(request.hermesHome);
  const skillsRoot = join(hermesHome, 'skills');
  const dryRun = request.dryRun === true;

  const sidecar = readHermesSidecar(skillsRoot);
  if (!sidecar) {
    return {
      hermesHome,
      dryRun,
      seen: 0,
      imported: 0,
      skipped: 0,
      failed: 0,
      rows: [],
      totalSynthesizedUsage: 0,
    };
  }

  const bundled = readBundledManifest(skillsRoot);
  const rows: SkillImportHermesRow[] = [];
  let imported = 0;
  const skipped = 0;
  let failed = 0;
  let totalSynthesizedUsage = 0;

  for (const [name, entry] of Object.entries(sidecar)) {
    try {
      const sourceType = mapSourceType(entry, bundled, name);
      const lifecycle = mapLifecycleState(entry.state);
      const installedAt = entry.created_at;
      const lastUpdatedAt =
        entry.last_patched_at ?? entry.last_used_at ?? entry.last_viewed_at ?? entry.created_at;
      const installPath = join(skillsRoot, name);

      const skillRow: NewSkillRow = {
        name,
        version: null,
        sourceType,
        sourceUrl: null,
        installPath,
        canonicalPath: sourceType === 'canonical' ? installPath : null,
        installedAt,
        lastUpdatedAt,
        lifecycleState: lifecycle,
        pinned: entry.pinned,
        isAgentCreated: sourceType === 'agent-created',
        archivedAt: entry.archived_at,
        archivedFromPath: entry.archived_at ? installPath : null,
      };

      if (!dryRun) {
        // Hermes-imported canonical/bundled skills land in skills.db as
        // ground-truth rows. The T9708 canonical-write guard requires every
        // canonical upsert to declare its provenance — for the importer
        // that's `pr-generator` (CI-equivalent import path).
        if (sourceType === 'canonical') {
          await withProvenance('pr-generator', () => upsertSkillRow(skillRow));
        } else {
          await upsertSkillRow(skillRow);
        }
      }

      // Synthesize per-counter `skill_usage` rows so historical activity
      // is queryable via `cleo skills stats`. We attribute the timestamp
      // to `last_used_at` / `last_viewed_at` / `last_patched_at` so they
      // sort correctly in time-windowed queries.
      const synthesisPlan: Array<{
        eventKind: 'load' | 'view' | 'patch';
        count: number;
        timestamp: string | null;
      }> = [
        { eventKind: 'load', count: entry.use_count, timestamp: entry.last_used_at },
        { eventKind: 'view', count: entry.view_count, timestamp: entry.last_viewed_at },
        { eventKind: 'patch', count: entry.patch_count, timestamp: entry.last_patched_at },
      ];

      let synthesizedForThisRow = 0;
      for (const plan of synthesisPlan) {
        if (plan.count <= 0) continue;
        const ts = plan.timestamp ?? installedAt;
        for (let i = 0; i < plan.count; i++) {
          synthesizedForThisRow++;
          if (dryRun) continue;
          const usageRow: NewSkillUsageRow = {
            skillName: name,
            eventKind: plan.eventKind,
            observedAt: ts,
            taskId: null,
            modelId: null,
            metadata: JSON.stringify({ source: 'hermes-import' }),
          };
          await insertUsage(usageRow);
        }
      }
      totalSynthesizedUsage += synthesizedForThisRow;

      rows.push({
        name,
        disposition: 'imported',
        sourceType,
        synthesizedUsageRows: synthesizedForThisRow,
        error: null,
      });
      imported++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rows.push({
        name,
        disposition: 'failed',
        sourceType: null,
        synthesizedUsageRows: 0,
        error: message,
      });
      failed++;
    }
  }

  return {
    hermesHome,
    dryRun,
    seen: rows.length,
    imported,
    skipped,
    failed,
    rows,
    totalSynthesizedUsage,
  };
}
