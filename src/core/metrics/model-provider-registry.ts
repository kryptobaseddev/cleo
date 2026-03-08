const MODELS_DEV_URL = 'https://models.dev/api.json';

interface ModelsDevProviderRecord {
  id?: string;
  models?: Record<string, { id?: string }>;
}

export interface ModelProviderLookup {
  provider?: string;
  source: 'model-prefix' | 'models.dev-exact' | 'models.dev-suffix' | 'none';
  candidates?: string[];
}

type ModelsDevIndex = Record<string, ModelsDevProviderRecord>;

let modelsDevCache: Promise<ModelsDevIndex | null> | null = null;

function getModelPrefix(model?: string): string | undefined {
  const value = (model ?? '').trim().toLowerCase();
  if (!value.includes('/')) return undefined;
  const [prefix] = value.split('/');
  return prefix || undefined;
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function resolveProviderFromModelIndex(index: ModelsDevIndex, model?: string): ModelProviderLookup {
  const value = (model ?? '').trim().toLowerCase();
  if (!value) return { source: 'none' };

  const exactMatches: string[] = [];
  const suffixMatches: string[] = [];

  for (const [providerId, provider] of Object.entries(index)) {
    const models = provider.models ?? {};
    if (models[value]) exactMatches.push(providerId);

    for (const modelId of Object.keys(models)) {
      if (!modelId.includes('/')) continue;
      const [, suffix] = modelId.split(/\/(.+)/, 2);
      if (suffix === value) {
        suffixMatches.push(providerId);
      }
    }
  }

  const prefix = getModelPrefix(value);
  const exactCandidates = uniq(exactMatches);
  if (prefix && exactCandidates.includes(prefix)) {
    return { provider: prefix, source: 'model-prefix', candidates: exactCandidates };
  }
  if (exactCandidates.length === 1) {
    return { provider: exactCandidates[0], source: 'models.dev-exact', candidates: exactCandidates };
  }
  if (exactCandidates.length > 1) {
    return { source: 'models.dev-exact', candidates: exactCandidates };
  }

  const suffixCandidates = uniq(suffixMatches);
  if (suffixCandidates.length === 1) {
    return { provider: suffixCandidates[0], source: 'models.dev-suffix', candidates: suffixCandidates };
  }
  if (suffixCandidates.length > 1) {
    return { source: 'models.dev-suffix', candidates: suffixCandidates };
  }

  return { source: 'none' };
}

async function loadModelsDevIndex(): Promise<ModelsDevIndex | null> {
  if (!modelsDevCache) {
    modelsDevCache = fetch(MODELS_DEV_URL, {
      signal: AbortSignal.timeout(1500),
      headers: { accept: 'application/json' },
    })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<ModelsDevIndex>;
      })
      .catch(() => null);
  }

  return modelsDevCache;
}

export async function resolveProviderFromModelRegistry(model?: string): Promise<ModelProviderLookup> {
  const prefix = getModelPrefix(model);
  if (prefix) {
    return { provider: prefix, source: 'model-prefix' };
  }

  const index = await loadModelsDevIndex();
  if (!index) return { source: 'none' };
  return resolveProviderFromModelIndex(index, model);
}

export function resetModelsDevCache(): void {
  modelsDevCache = null;
}
