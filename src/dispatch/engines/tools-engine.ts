/**
 * Tools Engine — Thin wrapper layer for tools domain operations.
 *
 * Delegates all business logic to src/core/ and @cleocode/caamp.
 * Each function catches errors and wraps them into EngineResult.
 *
 * Sub-domains:
 *   issue.*      - Issue diagnostics
 *   skill.*      - Skill discovery, dispatch, catalog, precedence
 *   provider.*   - CAAMP provider registry
 *   todowrite.*  - TodoWrite sync state
 *   adapter.*    - Provider adapter management
 *
 * @task T5703
 * @epic T5701
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
} from '@cleocode/caamp';
import { AdapterManager } from '../../core/adapters/index.js';
import { clearSyncState, getSyncStatus } from '../../core/admin/sync.js';
import { collectDiagnostics } from '../../core/issue/diagnostics.js';
import { paginate } from '../../core/pagination.js';
import { systemSync } from './system-engine.js';
import { type EngineResult, engineError, engineSuccess } from './_error.js';

// Re-export EngineResult for consumers
export type { EngineResult };

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
): Promise<EngineResult<{ skills: Awaited<ReturnType<typeof discoverSkills>>; count: number; query: string }>> {
  try {
    const q = (query ?? '').toLowerCase();
    const skills = await discoverSkills(getCanonicalSkillsDir());
    const filtered = q
      ? skills.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.metadata.description.toLowerCase().includes(q),
        )
      : skills;
    return engineSuccess({ skills: filtered, count: filtered.length, query: q });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Get dispatch matrix entries for a skill.
 */
export function toolsSkillDispatch(
  name: string,
): EngineResult<{
  skill: string;
  dispatch: {
    byTaskType: string[];
    byKeyword: string[];
    byProtocol: string[];
  };
}> {
  try {
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
export async function toolsSkillVerify(
  name: string,
): Promise<
  EngineResult<{
    skill: string;
    installed: boolean;
    inCatalog: boolean;
    installPath: string | null;
  }>
> {
  try {
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
export function toolsSkillDependencies(
  name: string,
): EngineResult<{
  skill: string;
  direct: ReturnType<typeof catalog.getSkillDependencies>;
  tree: ReturnType<typeof catalog.resolveDependencyTree>;
}> {
  try {
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
  capability?: 'supportsSubagents' | 'supportsProgrammaticSpawn' | 'supportsInterAgentComms' | 'supportsParallelSpawn',
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
    const protocols = catalog.listProtocols();
    const details = protocols.map((name) => ({
      name,
      path: catalog.getProtocolPath(name) ?? null,
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
    const profileNames = catalog.listProfiles();
    const profiles = profileNames.map((name) => {
      const profile = catalog.getProfile(name);
      return {
        name,
        description: profile?.description ?? '',
        extends: profile?.extends,
        skillCount: profile?.skills.length ?? 0,
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
    const resources = catalog.listSharedResources();
    const details = resources.map((name) => ({
      name,
      path: catalog.getSharedResourcePath(name) ?? null,
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
    const { getSkillsMapWithPrecedence } = await import(
      '../../core/skills/precedence-integration.js'
    );
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
    const { resolveSkillPathsForProvider } = await import(
      '../../core/skills/precedence-integration.js'
    );
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
    const providerIds = providers.map((p) => p.id);

    const { determineInstallationTargets } = await import(
      '../../core/skills/precedence-integration.js'
    );
    const targets = await determineInstallationTargets({
      skillName: name,
      source: resolvedSource,
      targetProviders: providerIds,
      projectRoot: globalFlag ? undefined : projectRoot,
    });

    const results: Array<{ providerId: string; success: boolean; errors: string[] }> = [];
    const errors: string[] = [];

    for (const target of targets) {
      const provider = providers.find((p) => p.id === target.providerId);
      if (!provider) continue;
      const result = await installSkill(resolvedSource, name, [provider], globalFlag, projectRoot);
      results.push({ providerId: target.providerId, ...result });
      if (!result.success) {
        errors.push(`${target.providerId}: ${result.errors.join('; ')}`);
      }
    }

    const allSuccess = results.length > 0 && results.every((r) => r.success);
    if (!allSuccess) {
      return {
        success: false,
        data: { results, targets: targets.map((t) => t.providerId) },
        error: {
          code: 'E_INTERNAL',
          message: errors.join('; ') || 'Skill install failed',
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
        data: { removed: result.removed, errors: result.errors },
        error: {
          code: 'E_INTERNAL',
          message: result.errors.join('; ') || 'Skill uninstall failed',
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
export async function toolsSkillRefresh(
  projectRoot: string,
): Promise<
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

    for (const [name, status] of Object.entries(updates)) {
      if (!status.hasUpdate) continue;
      const entry = tracked[name];
      if (!entry) continue;
      const source = entry.sourceType === 'library' ? `library:${name}` : entry.source;
      try {
        const result = await installSkill(
          source,
          name,
          providers,
          entry.isGlobal,
          entry.projectDir ?? projectRoot,
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
        data: { updated, failed, checked: Object.keys(updates).length },
        error: {
          code: 'E_INTERNAL',
          message: `${failed.length} skill refreshes failed`,
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
): Promise<EngineResult<unknown>> {
  try {
    const { queryHookProviders } = await import('./hooks-engine.js');
    const result = await queryHookProviders(
      event as import('../../core/hooks/types.js').HookEvent,
    );
    return result;
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Provider mutation operations
// ---------------------------------------------------------------------------

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
    const resolvedContent =
      content ?? buildInjectionContent({ references: resolvedRefs });
    const result = await injectAll(providers, projectRoot, resolvedScope, resolvedContent);
    const actions = Array.from(result.entries()).map(([file, action]) => ({ file, action }));
    return engineSuccess({ actions, count: actions.length });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// TodoWrite operations
// ---------------------------------------------------------------------------

/**
 * Get TodoWrite sync status.
 */
export async function toolsTodowriteStatus(
  projectRoot: string,
): Promise<EngineResult<unknown>> {
  try {
    const result = await getSyncStatus(projectRoot);
    return result;
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Trigger TodoWrite sync.
 */
export function toolsTodowriteSync(
  projectRoot: string,
  params?: { direction?: string },
): EngineResult<unknown> {
  try {
    return systemSync(projectRoot, params);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Clear TodoWrite sync state.
 */
export async function toolsTodowriteClear(
  projectRoot: string,
  dryRun?: boolean,
): Promise<EngineResult<unknown>> {
  try {
    const result = await clearSyncState(projectRoot, dryRun);
    return result;
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
export function toolsAdapterList(
  projectRoot: string,
): EngineResult<{
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
