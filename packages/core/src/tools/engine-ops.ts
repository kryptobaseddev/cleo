/**
 * Tools Engine Operations — business logic layer.
 *
 * Contains all tools domain logic migrated from
 * `packages/cleo/src/dispatch/engines/tools-engine.ts` (ENG-MIG-8 / T1575).
 *
 * Sub-domains:
 *   issue.*      - Issue diagnostics
 *   skill.*      - Skill discovery, dispatch, catalog, precedence
 *   provider.*   - CAAMP provider registry
 *   adapter.*    - Provider adapter management
 *
 * Each exported function returns `EngineResult` and is importable from
 * `@cleocode/core/internal` so the CLI dispatch layer can call them without
 * any intermediate engine file.
 *
 * @task T1575 — ENG-MIG-8
 * @epic T1566
 */

import {
  buildInjectionContent,
  catalog,
  checkAllInjections,
  checkAllSkillUpdates,
  detectAllProviders,
  discoverSkill,
  discoverSkills,
  getAllProviders,
  getCanonicalSkillsDir,
  getInstalledProviders,
  getTrackedSkills,
  injectAll,
  installSkill,
  removeSkill,
  type SkillRowData,
} from '@cleocode/caamp';
import type {
  SkillImportHermesRequest,
  SkillImportHermesResponse,
  SkillPruneTelemetryRequest,
  SkillPruneTelemetryResponse,
  SkillStatsRequest,
  SkillStatsResponse,
} from '@cleocode/contracts';
import { AdapterManager } from '../adapters/index.js';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { type HookEvent, isProviderHookEvent } from '../hooks/types.js';
import { collectDiagnostics } from '../issue/diagnostics.js';
import { paginate } from '../pagination.js';
import {
  type DoctorDiagnoseReport,
  diagnoseSkillStore,
  renderDoctorDiagnoseReport,
} from '../skills/doctor.js';
import { upsertSkillRow } from '../store/skills-db.js';

/** Shape for provider hook info returned by queryHookProviders. */
interface ProviderHookInfo {
  id: string;
  name: string | undefined;
  supportedHooks: string[];
}

// ---------------------------------------------------------------------------
// Catalog availability constants
// ---------------------------------------------------------------------------

/** Human-readable message when the skill catalog is not registered. */
const CATALOG_UNAVAILABLE_MSG =
  'Skill catalog not available. The CAAMP skill library could not be loaded. ' +
  'Run `cleo init` to set up the skill library, or set CAAMP_SKILL_LIBRARY env var.';

/** Error options for catalog-unavailable responses (fix hint + alternatives). */
const CATALOG_UNAVAILABLE_OPTS = {
  fix: 'cleo init',
  alternatives: [
    { action: 'Set env var', command: 'export CAAMP_SKILL_LIBRARY=/path/to/skills' },
    { action: 'Use filesystem-based commands', command: 'cleo skills list' },
  ],
};

// ---------------------------------------------------------------------------
// Issue operations
// ---------------------------------------------------------------------------

/**
 * Collect issue diagnostics.
 */
export function toolsIssueDiagnostics(): EngineResult<ReturnType<typeof collectDiagnostics>> {
  try {
    const diag = collectDiagnostics();
    return engineSuccess(diag);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Skill query operations
// ---------------------------------------------------------------------------

/**
 * List all discovered skills.
 */
export async function toolsSkillList(
  limit?: number,
  offset?: number,
): Promise<
  EngineResult<{
    skills: Awaited<ReturnType<typeof discoverSkills>>;
    count: number;
    total: number;
    filtered: number;
    page: ReturnType<typeof paginate>['page'];
  }>
> {
  try {
    const skills = await discoverSkills(getCanonicalSkillsDir());
    const page = paginate(skills, limit, offset);
    return {
      success: true,
      data: {
        skills: page.items as Awaited<ReturnType<typeof discoverSkills>>,
        count: skills.length,
        total: skills.length,
        filtered: skills.length,
        page: page.page,
      },
      page: page.page,
    };
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Show a single skill by name.
 */
export async function toolsSkillShow(
  name: string,
): Promise<EngineResult<{ skill: Awaited<ReturnType<typeof discoverSkill>> }>> {
  try {
    const skill = await discoverSkill(`${getCanonicalSkillsDir()}/${name}`);
    if (!skill) {
      return engineError('E_NOT_FOUND', `Skill not found: ${name}`);
    }
    return engineSuccess({ skill });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Find skills matching a query string.
 */
export async function toolsSkillFind(
  query?: string,
): Promise<
  EngineResult<{ skills: Awaited<ReturnType<typeof discoverSkills>>; count: number; query: string }>
> {
  try {
    const q = (query ?? '').toLowerCase();
    const skills = await discoverSkills(getCanonicalSkillsDir());
    const filtered = q
      ? skills.filter(
          (s: { name: string; metadata: { description: string } }) =>
            s.name.toLowerCase().includes(q) || s.metadata.description.toLowerCase().includes(q),
        )
      : skills;
    return engineSuccess({ skills: filtered, count: filtered.length, query: q });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Federated find — multi-source skill query (T9731).
 *
 * Always queries local skills + canonical marketplace. When `federated`
 * is `true`, also fans out to every peer in `~/.cleo/federation.json`.
 *
 * Returns ranked results plus per-source warnings so callers can surface
 * network-failure context in the CLI.
 *
 * @param query - Search query (case-insensitive).
 * @param federated - OPT-IN flag for federation fan-out (default `false`).
 * @param limit - Maximum number of results returned (default `25`).
 */
export async function toolsSkillFederatedFind(
  query?: string,
  federated: boolean = false,
  limit: number = 25,
): Promise<
  EngineResult<{
    results: import('../skills/federated-search.js').FederatedSearchResult[];
    warnings: string[];
    count: number;
    query: string;
    federated: boolean;
  }>
> {
  try {
    const { federatedSearch } = await import('../skills/federated-search.js');
    const q = (query ?? '').trim();
    const response = await federatedSearch({
      query: q,
      includeFederated: federated,
      perSourceLimit: limit,
    });
    const limited = [...response.results].slice(0, limit);
    return engineSuccess({
      results: limited,
      warnings: [...response.warnings],
      count: limited.length,
      query: q,
      federated,
    });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Get dispatch matrix entries for a skill.
 */
export function toolsSkillDispatch(name: string): EngineResult<{
  skill: string;
  dispatch: {
    byTaskType: string[];
    byKeyword: string[];
    byProtocol: string[];
  };
}> {
  try {
    if (!catalog.isCatalogAvailable()) {
      return engineError('E_CONFIG_ERROR', CATALOG_UNAVAILABLE_MSG, CATALOG_UNAVAILABLE_OPTS);
    }
    const matrix = catalog.getDispatchMatrix();
    const entry = {
      byTaskType: Object.entries(matrix.by_task_type)
        .filter(([, skill]) => skill === name)
        .map(([k]) => k),
      byKeyword: Object.entries(matrix.by_keyword)
        .filter(([, skill]) => skill === name)
        .map(([k]) => k),
      byProtocol: Object.entries(matrix.by_protocol)
        .filter(([, skill]) => skill === name)
        .map(([k]) => k),
    };
    return engineSuccess({ skill: name, dispatch: entry });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Verify a skill's installation and catalog status.
 */
export async function toolsSkillVerify(name: string): Promise<
  EngineResult<{
    skill: string;
    installed: boolean;
    inCatalog: boolean;
    installPath: string | null;
  }>
> {
  try {
    if (!catalog.isCatalogAvailable()) {
      return engineError('E_CONFIG_ERROR', CATALOG_UNAVAILABLE_MSG, CATALOG_UNAVAILABLE_OPTS);
    }
    const installed = await discoverSkill(`${getCanonicalSkillsDir()}/${name}`);
    const catalogEntry = catalog.getSkill(name);
    return engineSuccess({
      skill: name,
      installed: !!installed,
      inCatalog: !!catalogEntry,
      installPath: installed ? `${getCanonicalSkillsDir()}/${name}` : null,
    });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Get dependency tree for a skill.
 */
export function toolsSkillDependencies(name: string): EngineResult<{
  skill: string;
  direct: ReturnType<typeof catalog.getSkillDependencies>;
  tree: ReturnType<typeof catalog.resolveDependencyTree>;
}> {
  try {
    if (!catalog.isCatalogAvailable()) {
      return engineError('E_CONFIG_ERROR', CATALOG_UNAVAILABLE_MSG, CATALOG_UNAVAILABLE_OPTS);
    }
    const direct = catalog.getSkillDependencies(name);
    const tree = catalog.resolveDependencyTree([name]);
    return engineSuccess({ skill: name, direct, tree });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Get spawn-capable providers by capability.
 */
export async function toolsSkillSpawnProviders(
  capability?:
    | 'supportsSubagents'
    | 'supportsProgrammaticSpawn'
    | 'supportsInterAgentComms'
    | 'supportsParallelSpawn',
): Promise<EngineResult<{ providers: unknown[]; capability: string; count: number }>> {
  try {
    const { getProvidersBySpawnCapability } = await import('@cleocode/caamp');
    const cap = capability ?? 'supportsSubagents';
    const providers = getProvidersBySpawnCapability(cap);
    return engineSuccess({ providers, capability: cap, count: providers.length });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Run the read-only skill-store doctor diagnose pass.
 *
 * @remarks
 * Thin wrapper over {@link diagnoseSkillStore} from `@cleocode/core/skills/doctor`
 * — exists so the dispatch layer can route `tools.skill.doctor.diagnose` without
 * importing the diagnose module directly. The handler is read-only and never
 * mutates filesystem or db state.
 *
 * @param options.verbose - When true, the human renderer included on the
 *   envelope `data.report.rendered` field contains per-skill detail.
 *
 * @returns Engine result carrying the {@link DoctorDiagnoseReport} plus the
 *   rendered human-readable summary.
 *
 * @task T9652
 */
export async function toolsSkillDoctorDiagnose(options?: { verbose?: boolean }): Promise<
  EngineResult<{
    report: DoctorDiagnoseReport;
    rendered: string;
    healthy: boolean;
  }>
> {
  try {
    const report = await diagnoseSkillStore();
    const rendered = renderDoctorDiagnoseReport(report, options?.verbose ?? false);
    return engineSuccess({ report, rendered, healthy: report.healthy });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Run the Sphere B telemetry rollup powering `cleo skills stats`.
 *
 * Always returns the top-N rollup (`top`). The `bySource`, `byLifecycle`,
 * and `agentCreated` facets are populated only when the corresponding flag
 * is `true` — `null` otherwise so callers can distinguish "not requested"
 * from "zero rows".
 *
 * @param request - Faceting flags from {@link SkillStatsRequest}.
 *
 * @task T9690
 */
export async function toolsSkillStats(
  request?: SkillStatsRequest,
): Promise<EngineResult<SkillStatsResponse>> {
  try {
    const { countByLifecycle, countBySourceType, getTopUsed, listAgentCreated } = await import(
      '../store/skills-store.js'
    );

    const topLimit = request?.top ?? 10;
    const top = await getTopUsed(topLimit);

    const bySource = request?.bySource
      ? (await countBySourceType()).map((r) => ({
          sourceType: r.sourceType,
          count: r.count,
        }))
      : null;

    const byLifecycle = request?.byLifecycle
      ? (await countByLifecycle()).map((r) => ({ state: r.state, count: r.count }))
      : null;

    const agentCreated = request?.agentCreated
      ? (await listAgentCreated()).map((r) => ({
          name: r.name,
          version: r.version,
          installedAt: r.installedAt,
          lifecycleState: r.lifecycleState,
        }))
      : null;

    return engineSuccess({
      top: top.map((r) => ({ skillName: r.skillName, count: r.count })),
      bySource,
      byLifecycle,
      agentCreated,
      sinceDays: request?.sinceDays ?? null,
    });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Migrate Hermes `~/.hermes/skills/.usage.json` sidecars into CLEO `skills.db`.
 *
 * @remarks
 * Thin wrapper over {@link importFromHermes} so the dispatch layer can route
 * `tools.skill.import-hermes` without importing the skills domain module
 * directly. The full provenance + counter-synthesis logic lives in
 * `packages/core/src/skills/hermes-importer.ts`.
 *
 * @param request - Import flags (Hermes home override, dry-run mode).
 * @returns Engine result carrying per-skill outcomes + summary counters.
 *
 * @task T9691
 */
export async function toolsSkillImportHermes(
  request: SkillImportHermesRequest = {},
): Promise<EngineResult<SkillImportHermesResponse>> {
  try {
    const { importFromHermes } = await import('../skills/hermes-importer.js');
    const response = await importFromHermes(request);
    return engineSuccess(response);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Prune `skill_usage` rows older than the configured window.
 *
 * @remarks
 * Uses {@link pruneUsageOlderThan} from `@cleocode/core/store/skills-store`.
 * The window defaults to **180 days** (mirrors Hermes `archive_after_days`)
 * when the request omits `olderThanDays`. Dry-run mode computes the cutoff
 * and the projected `deletedRows` without mutating the database.
 *
 * @param request - Prune flags (window, dry-run, vacuum).
 * @returns Engine result with before/after counters and file-size deltas.
 *
 * @task T9693
 */
export async function toolsSkillPruneTelemetry(
  request: SkillPruneTelemetryRequest = {},
): Promise<EngineResult<SkillPruneTelemetryResponse>> {
  try {
    const { statSync } = await import('node:fs');
    const { getOpenSkillsDbPath, getSkillsNativeDb, openSkillsDb } = await import(
      '../store/skills-db.js'
    );
    const { pruneUsageOlderThan } = await import('../store/skills-store.js');
    const { skillUsage } = await import('../store/skills-schema.js');
    const { lt, sql } = await import('drizzle-orm');

    const olderThanDays = request.olderThanDays ?? 180;
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
      return engineError('E_INVALID_INPUT', `olderThanDays must be a non-negative number`);
    }
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
    const cutoffIso = cutoff.toISOString();
    const dryRun = request.dryRun === true;
    const wantVacuum = request.vacuum === true;

    // Ensure DB is open + resolve the path the singleton actually points at.
    await openSkillsDb();
    const dbPath = getOpenSkillsDbPath() ?? '';
    const safeSize = (path: string): number => {
      try {
        return statSync(path).size;
      } catch {
        return 0;
      }
    };
    const dbSizeBefore = safeSize(dbPath);

    if (dryRun) {
      // Count rows that would be deleted without touching them.
      const dbHandle = await openSkillsDb();
      const rows = dbHandle
        .select({ c: sql<number>`COUNT(*)`.as('c') })
        .from(skillUsage)
        .where(lt(skillUsage.observedAt, cutoffIso))
        .all();
      const projected = Number(rows[0]?.c ?? 0);
      const bounds = dbHandle
        .select({
          oldest: sql<string | null>`MIN(${skillUsage.observedAt})`.as('oldest'),
          newest: sql<string | null>`MAX(${skillUsage.observedAt})`.as('newest'),
        })
        .from(skillUsage)
        .all();
      return engineSuccess({
        deletedRows: projected,
        olderThanDays,
        cutoffIso,
        dryRun: true,
        vacuumed: false,
        dbSizeBefore,
        dbSizeAfter: dbSizeBefore,
        oldestRemaining: bounds[0]?.oldest ?? null,
        newestRemaining: bounds[0]?.newest ?? null,
      });
    }

    const result = await pruneUsageOlderThan(cutoffIso);

    let vacuumed = false;
    if (wantVacuum) {
      const nativeDb = getSkillsNativeDb();
      if (nativeDb?.isOpen) {
        try {
          nativeDb.exec('VACUUM;');
          vacuumed = true;
        } catch {
          // VACUUM may fail inside an open WAL transaction — surface but don't fail.
          vacuumed = false;
        }
      }
    }

    return engineSuccess({
      deletedRows: result.deletedRows,
      olderThanDays,
      cutoffIso,
      dryRun: false,
      vacuumed,
      dbSizeBefore,
      dbSizeAfter: safeSize(dbPath),
      oldestRemaining: result.oldestRemaining,
      newestRemaining: result.newestRemaining,
    });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Get catalog info (protocols, profiles, resources, or summary).
 */
export function toolsSkillCatalogInfo(): EngineResult<{
  available: boolean;
  version: string | null;
  libraryRoot: string | null;
  skillCount: number;
  protocolCount: number;
  profileCount: number;
}> {
  try {
    const available = catalog.isCatalogAvailable();
    const version = available ? catalog.getVersion() : null;
    const libraryRoot = available ? catalog.getLibraryRoot() : null;
    const skillCount = available ? catalog.getSkills().length : 0;
    const protocolCount = available ? catalog.listProtocols().length : 0;
    const profileCount = available ? catalog.listProfiles().length : 0;

    return engineSuccess({
      available,
      version,
      libraryRoot,
      skillCount,
      protocolCount,
      profileCount,
    });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * List catalog protocols.
 */
export function toolsSkillCatalogProtocols(
  limit?: number,
  offset?: number,
): EngineResult<{
  protocols: Array<{ name: string; path: string | null }>;
  count: number;
  total: number;
  filtered: number;
  page: ReturnType<typeof paginate>['page'];
}> {
  try {
    const protocols = catalog.listProtocols() as string[];
    const details = protocols.map((name: string) => ({
      name,
      path: (catalog.getProtocolPath(name) as string | undefined) ?? null,
    }));
    const page = paginate(details, limit, offset);
    return {
      success: true,
      data: {
        protocols: page.items as Array<{ name: string; path: string | null }>,
        count: details.length,
        total: details.length,
        filtered: details.length,
        page: page.page,
      },
      page: page.page,
    };
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * List catalog profiles.
 */
export function toolsSkillCatalogProfiles(
  limit?: number,
  offset?: number,
): EngineResult<{
  profiles: Array<{
    name: string;
    description: string;
    extends: string | undefined;
    skillCount: number;
    skills: string[];
  }>;
  count: number;
  total: number;
  filtered: number;
  page: ReturnType<typeof paginate>['page'];
}> {
  try {
    const profileNames = catalog.listProfiles() as string[];
    const profiles = profileNames.map((name: string) => {
      const profile = catalog.getProfile(name) as
        | { description?: string; extends?: string; skills?: string[] }
        | undefined;
      return {
        name,
        description: profile?.description ?? '',
        extends: profile?.extends,
        skillCount: profile?.skills?.length ?? 0,
        skills: profile?.skills ?? [],
      };
    });
    const page = paginate(profiles, limit, offset);
    return {
      success: true,
      data: {
        profiles: page.items as typeof profiles,
        count: profiles.length,
        total: profiles.length,
        filtered: profiles.length,
        page: page.page,
      },
      page: page.page,
    };
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * List catalog shared resources.
 */
export function toolsSkillCatalogResources(
  limit?: number,
  offset?: number,
): EngineResult<{
  resources: Array<{ name: string; path: string | null }>;
  count: number;
  total: number;
  filtered: number;
  page: ReturnType<typeof paginate>['page'];
}> {
  try {
    const resources = catalog.listSharedResources() as string[];
    const details = resources.map((name: string) => ({
      name,
      path: (catalog.getSharedResourcePath(name) as string | undefined) ?? null,
    }));
    const page = paginate(details, limit, offset);
    return {
      success: true,
      data: {
        resources: page.items as Array<{ name: string; path: string | null }>,
        count: details.length,
        total: details.length,
        filtered: details.length,
        page: page.page,
      },
      page: page.page,
    };
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Show skill precedence map.
 */
export async function toolsSkillPrecedenceShow(): Promise<
  EngineResult<{ precedenceMap: unknown }>
> {
  try {
    const { getSkillsMapWithPrecedence } = await import('../skills/precedence-integration.js');
    const map = getSkillsMapWithPrecedence();
    return engineSuccess({ precedenceMap: map });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Resolve skill paths for a specific provider.
 */
export async function toolsSkillPrecedenceResolve(
  providerId: string,
  scope: 'global' | 'project',
  projectRoot: string,
): Promise<EngineResult<{ providerId: string; scope: string; paths: unknown }>> {
  try {
    const { resolveSkillPathsForProvider } = await import('../skills/precedence-integration.js');
    const paths = await resolveSkillPathsForProvider(providerId, scope, projectRoot);
    return engineSuccess({ providerId, scope, paths });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Skill mutation operations
// ---------------------------------------------------------------------------

/**
 * Record a successful canonical-skill install in `~/.cleo/skills.db`.
 *
 * @remarks
 * Adapter that lifts the caamp-defined {@link SkillRowData} payload into
 * core's `upsertSkillRow` insert shape. Per T9659 / architecture-v3 §1,
 * caamp must NEVER import `@cleocode/core` — instead it emits this row
 * shape and core (here, in the engine layer) plugs the DB write.
 *
 * Failures are logged to stderr and swallowed: the canonical install on
 * disk is authoritative, so a missing `skills.db` row should NEVER block
 * a user's install. The follow-up `cleo skills doctor` sweep will
 * reconcile any drift.
 *
 * @param row - The provenance payload emitted by `installSkill`.
 *
 * @task T9659
 */
async function skillsDbRecorder(row: SkillRowData): Promise<void> {
  try {
    const writePayload = {
      name: row.name,
      sourceType: row.sourceType,
      sourceUrl: row.sourceUrl,
      installPath: row.installPath,
      // `canonical_path` mirrors `install_path` for the new SSoT — both
      // point at `~/.cleo/skills/<name>/`. Sphere B rows that are NOT under
      // the SSoT keep canonicalPath null per architecture-v3 §4.
      canonicalPath: row.sourceType === 'canonical' ? row.installPath : null,
      installedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    } as const;
    if (row.sourceType === 'canonical') {
      // T9708 — canonical rows are write-guarded. The local install mirrors a
      // row authored by owner-CI (the true `pr-generator`); we re-establish
      // that provenance frame here so the guard at `upsertSkillRow` allows
      // the mirror write. Sphere B rows (`user`/`community`/`agent-created`)
      // bypass the guard entirely and run in whatever frame the caller set.
      const { withProvenance } = await import('../sentient/skill-provenance.js');
      await withProvenance('pr-generator', () => upsertSkillRow(writePayload));
    } else {
      await upsertSkillRow(writePayload);
    }
  } catch (error) {
    // Log + continue — DB write is best-effort. Surfaced via stderr (not
    // the logger module) to avoid pulling pino into install hot-paths and
    // to keep visibility in CLI output. The canonical install on disk is
    // the authoritative artefact; `cleo skills doctor` reconciles drift.
    process.stderr.write(
      `[skills] failed to record skill row for ${row.name}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

/**
 * Install a skill to one or more providers.
 */
export async function toolsSkillInstall(
  name: string,
  projectRoot: string,
  source?: string,
  isGlobal?: boolean,
): Promise<
  EngineResult<{
    results: Array<{ providerId: string; success: boolean; errors: string[] }>;
    targets: string[];
  }>
> {
  try {
    const providers = getInstalledProviders();
    const globalFlag = isGlobal !== false;

    if (providers.length === 0) {
      return engineError('E_NOT_FOUND', 'No installed providers available');
    }

    const resolvedSource = source ?? `library:${name}`;
    const providerIds = providers.map((p: { id: string }) => p.id);

    const { determineInstallationTargets } = await import('../skills/precedence-integration.js');
    const targets = await determineInstallationTargets({
      skillName: name,
      source: resolvedSource,
      targetProviders: providerIds,
      projectRoot: globalFlag ? undefined : projectRoot,
    });

    const results: Array<{ providerId: string; success: boolean; errors: string[] }> = [];
    const errors: string[] = [];

    // Classify provenance ONCE: `library:<name>` is Sphere A canonical;
    // anything else is heuristically inferred (community/user) in
    // installSkill via the recordRow contract.
    const isCanonical = resolvedSource.startsWith('library:');
    for (const target of targets) {
      const provider = providers.find((p: { id: string }) => p.id === target.providerId);
      if (!provider) continue;
      const result = await installSkill(resolvedSource, name, [provider], globalFlag, projectRoot, {
        recordRow: skillsDbRecorder,
        sourceUrl: resolvedSource,
        sourceType: isCanonical ? 'canonical' : undefined,
      });
      results.push({ providerId: target.providerId, ...result });
      if (!result.success) {
        errors.push(`${target.providerId}: ${result.errors.join('; ')}`);
      }
    }

    const allSuccess = results.length > 0 && results.every((r) => r.success);
    if (!allSuccess) {
      return {
        success: false,
        error: {
          code: 'E_INTERNAL',
          message: errors.join('; ') || 'Skill install failed',
          details: { results, targets: targets.map((t) => t.providerId) },
        },
      };
    }

    return engineSuccess({ results, targets: targets.map((t) => t.providerId) });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Uninstall a skill from all providers.
 */
export async function toolsSkillUninstall(
  name: string,
  projectRoot: string,
  isGlobal?: boolean,
): Promise<EngineResult<{ removed: string[]; errors: string[] }>> {
  try {
    const providers = getInstalledProviders();
    const globalFlag = isGlobal !== false;

    if (providers.length === 0) {
      return engineError('E_NOT_FOUND', 'No installed providers available');
    }

    const result = await removeSkill(name, providers, globalFlag, projectRoot);
    const ok = result.removed.length > 0 && result.errors.length === 0;
    if (!ok) {
      return {
        success: false,
        error: {
          code: 'E_INTERNAL',
          message: result.errors.join('; ') || 'Skill uninstall failed',
          details: { removed: result.removed, errors: result.errors },
        },
      };
    }
    return engineSuccess({ removed: result.removed, errors: result.errors });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Refresh all tracked skills that have updates available.
 */
export async function toolsSkillRefresh(projectRoot: string): Promise<
  EngineResult<{
    updated: string[];
    failed: Array<{ name: string; error: string }>;
    checked: number;
  }>
> {
  try {
    const providers = getInstalledProviders();

    if (providers.length === 0) {
      return engineError('E_NOT_FOUND', 'No installed providers available');
    }

    const tracked = await getTrackedSkills();
    const updates = await checkAllSkillUpdates();
    const updated: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];

    for (const [name, status] of Object.entries(updates) as Array<
      [string, { hasUpdate: boolean }]
    >) {
      if (!status.hasUpdate) continue;
      const entry = tracked[name];
      if (!entry) continue;
      const src = entry.sourceType === 'library' ? `library:${name}` : entry.source;
      try {
        const result = await installSkill(
          src,
          name,
          providers,
          entry.isGlobal,
          entry.projectDir ?? projectRoot,
          {
            recordRow: skillsDbRecorder,
            sourceUrl: src,
            sourceType: entry.sourceType === 'library' ? 'canonical' : undefined,
          },
        );
        if (result.success) {
          updated.push(name);
        } else {
          failed.push({ name, error: result.errors.join('; ') || 'refresh failed' });
        }
      } catch (err) {
        failed.push({ name, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (failed.length > 0) {
      return {
        success: false,
        error: {
          code: 'E_INTERNAL',
          message: `${failed.length} skill refreshes failed`,
          details: { updated, failed, checked: Object.keys(updates).length },
        },
      };
    }

    return engineSuccess({ updated, failed, checked: Object.keys(updates).length });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Provider query operations
// ---------------------------------------------------------------------------

/**
 * List all registered providers.
 */
export function toolsProviderList(
  limit?: number,
  offset?: number,
): EngineResult<{
  providers: ReturnType<typeof getAllProviders>;
  count: number;
  total: number;
  filtered: number;
  page: ReturnType<typeof paginate>['page'];
}> {
  try {
    const providers = getAllProviders();
    const page = paginate(providers, limit, offset);
    return {
      success: true,
      data: {
        providers: page.items as ReturnType<typeof getAllProviders>,
        count: providers.length,
        total: providers.length,
        filtered: providers.length,
        page: page.page,
      },
      page: page.page,
    };
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Detect all available providers in the environment.
 */
export function toolsProviderDetect(): EngineResult<{
  providers: ReturnType<typeof detectAllProviders>;
  count: number;
}> {
  try {
    const detected = detectAllProviders();
    return engineSuccess({ providers: detected, count: detected.length });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Check injection status for all installed providers.
 */
export async function toolsProviderInjectStatus(
  projectRoot: string,
  scope?: 'project' | 'global',
  content?: string,
): Promise<EngineResult<{ checks: unknown[]; count: number }>> {
  try {
    const providers = getInstalledProviders();
    const resolvedScope = scope ?? 'project';
    const checks = await checkAllInjections(providers, projectRoot, resolvedScope, content);
    return engineSuccess({ checks, count: checks.length });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Check if a provider supports a specific capability.
 */
export async function toolsProviderSupports(
  providerId: string,
  capability: string,
): Promise<EngineResult<{ providerId: string; capability: string; supported: boolean }>> {
  try {
    const { providerSupportsById } = await import('@cleocode/caamp');
    const supported = providerSupportsById(providerId, capability);
    return engineSuccess({ providerId, capability, supported });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Query hook providers for a specific event.
 */
export async function toolsProviderHooks(
  event: string,
): Promise<EngineResult<{ event: HookEvent; providers: ProviderHookInfo[] }>> {
  try {
    const hookEvent = event as HookEvent;
    if (!isProviderHookEvent(hookEvent)) {
      return engineSuccess({ event: hookEvent, providers: [] });
    }
    const { getProvidersByHookEvent } = await import('@cleocode/caamp');
    const providers = getProvidersByHookEvent(hookEvent);
    return engineSuccess({
      event: hookEvent,
      providers: (providers as unknown[]).map((p: unknown) => ({
        id: (p as { id: string }).id,
        name: (p as { name?: string }).name,
        supportedHooks:
          (p as { capabilities?: { hooks?: { supported?: string[] } } }).capabilities?.hooks
            ?.supported ?? [],
      })),
    });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Inject CLEO directives into all installed provider instruction files.
 */
export async function toolsProviderInject(
  projectRoot: string,
  scope?: 'project' | 'global',
  references?: string[],
  content?: string,
): Promise<EngineResult<{ actions: Array<{ file: string; action: string }>; count: number }>> {
  try {
    const providers = getInstalledProviders();
    if (providers.length === 0) {
      return engineError('E_NOT_FOUND', 'No installed providers available');
    }
    const resolvedScope = scope ?? 'project';
    const resolvedRefs = references ?? ['@AGENTS.md'];
    const resolvedContent = content ?? buildInjectionContent({ references: resolvedRefs });
    const result = await injectAll(providers, projectRoot, resolvedScope, resolvedContent);
    const actions = Array.from(result.entries() as Iterable<[string, string]>).map(
      ([file, action]) => ({ file, action }),
    );
    return engineSuccess({ actions, count: actions.length });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Adapter query operations
// ---------------------------------------------------------------------------

/**
 * List all discovered adapters.
 */
export function toolsAdapterList(projectRoot: string): EngineResult<{
  adapters: ReturnType<AdapterManager['listAdapters']>;
  count: number;
}> {
  try {
    const manager = AdapterManager.getInstance(projectRoot);
    const adapters = manager.listAdapters();
    return engineSuccess({ adapters, count: adapters.length });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Show a single adapter by ID.
 */
export function toolsAdapterShow(
  projectRoot: string,
  id: string,
): EngineResult<{
  manifest: unknown;
  initialized: boolean;
  active: boolean;
}> {
  try {
    const manager = AdapterManager.getInstance(projectRoot);
    const manifest = manager.getManifest(id);
    const adapter = manager.get(id);
    if (!manifest) {
      return engineError('E_NOT_FOUND', `Adapter not found: ${id}`);
    }
    return engineSuccess({
      manifest,
      initialized: !!adapter,
      active: manager.getActiveId() === id,
    });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Detect active adapters.
 */
export function toolsAdapterDetect(
  projectRoot: string,
): EngineResult<{ detected: string[]; count: number }> {
  try {
    const manager = AdapterManager.getInstance(projectRoot);
    manager.discover();
    const detected = manager.detectActive();
    return engineSuccess({ detected, count: detected.length });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Get adapter health status.
 */
export function toolsAdapterHealth(
  projectRoot: string,
  id?: string,
): EngineResult<{
  adapters: ReturnType<AdapterManager['listAdapters']>;
  count: number;
}> {
  try {
    const manager = AdapterManager.getInstance(projectRoot);
    const adapters = manager.listAdapters();
    const filtered = id ? adapters.filter((a) => a.id === id) : adapters;
    return engineSuccess({
      adapters: filtered as ReturnType<AdapterManager['listAdapters']>,
      count: filtered.length,
    });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Adapter mutation operations
// ---------------------------------------------------------------------------

/**
 * Activate an adapter by ID.
 */
export async function toolsAdapterActivate(
  projectRoot: string,
  id: string,
): Promise<
  EngineResult<{
    id: string;
    name: string;
    version: string;
    active: boolean;
  }>
> {
  try {
    const manager = AdapterManager.getInstance(projectRoot);
    // Ensure manifests are discovered first
    if (!manager.getManifest(id)) {
      manager.discover();
    }
    // Return E_NOT_FOUND when the adapter manifest does not exist after discovery
    if (!manager.getManifest(id)) {
      return engineError('E_NOT_FOUND', `Adapter not found: ${id}`);
    }
    const adapter = await manager.activate(id);
    return engineSuccess({
      id,
      name: adapter.name,
      version: adapter.version,
      active: true,
    });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Dispose one or all adapters.
 */
export async function toolsAdapterDispose(
  projectRoot: string,
  id?: string,
): Promise<EngineResult<{ disposed: string }>> {
  try {
    const manager = AdapterManager.getInstance(projectRoot);
    if (id) {
      await manager.disposeAdapter(id);
    } else {
      await manager.dispose();
    }
    return engineSuccess({ disposed: id ?? 'all' });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}
