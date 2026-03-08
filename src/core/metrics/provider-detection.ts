import { basename } from 'node:path';
import {
  type DetectionResult,
  detectProjectProviders,
  getProvider,
  resolveAlias,
} from '@cleocode/caamp';

export interface RuntimeProviderContext {
  runtimeProviderId?: string;
  runtimeToolName?: string;
  runtimeVendor?: string;
  runtimeInstructionFile?: string;
  runtimeProjectDetected?: boolean;
  runtimeDetectionMethods?: string[];
  runtimeCandidates?: string[];
  inferredModelProvider?: string;
}

export interface RuntimeProviderSnapshot {
  cwd?: string;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}

function inferProviderFromVendor(vendor?: string): string | undefined {
  const value = (vendor ?? '').trim().toLowerCase();
  if (!value) return undefined;
  if (value.includes('anthropic') || value.includes('claude')) return 'anthropic';
  if (value.includes('openai') || value.includes('codex') || value.includes('chatgpt'))
    return 'openai';
  if (value.includes('google') || value.includes('gemini')) return 'google';
  if (value.includes('xai') || value.includes('grok')) return 'xai';
  return undefined;
}

function getRuntimeHints(snapshot: RuntimeProviderSnapshot): string[] {
  const argv = snapshot.argv ?? process.argv;
  const env = snapshot.env ?? process.env;
  const hints = new Set<string>();

  const bin = basename(argv[1] ?? argv[0] ?? '').replace(/\.[^.]+$/, '');
  if (bin) hints.add(bin);

  if (env['CLAUDE_CODE_ENABLE_TELEMETRY'] || env['CLAUDE_CODE_ENTRYPOINT']) {
    hints.add('claude-code');
    hints.add('claude');
  }
  if (env['OPENCODE_AGENT'] || env['OPENCODE']) {
    hints.add('opencode');
  }
  if (env['CURSOR_TRACE_ID'] || env['CURSOR_AGENT']) {
    hints.add('cursor');
  }

  return Array.from(hints);
}

function pickDetectionByHint(
  detections: DetectionResult[],
  hints: string[],
): DetectionResult | null {
  for (const hint of hints) {
    const resolved = resolveAlias(hint);
    const direct = detections.find(
      (entry) => entry.provider.id === resolved || entry.provider.id === hint,
    );
    if (direct) return direct;

    const byAlias = detections.find(
      (entry) =>
        entry.provider.aliases.includes(hint) ||
        entry.provider.agentFlag === hint ||
        entry.provider.toolName.toLowerCase() === hint.toLowerCase(),
    );
    if (byAlias) return byAlias;

    const provider = getProvider(resolved);
    if (provider) {
      return {
        provider,
        installed: true,
        methods: [],
        projectDetected: false,
      } satisfies DetectionResult;
    }
  }

  return null;
}

export function selectRuntimeProviderContext(
  detections: DetectionResult[],
  snapshot: RuntimeProviderSnapshot = {},
): RuntimeProviderContext {
  const hints = getRuntimeHints(snapshot);
  const hinted = pickDetectionByHint(detections, hints);
  const projectMatches = detections.filter((entry) => entry.projectDetected);
  const installed = detections.filter((entry) => entry.installed);

  const selected =
    hinted ??
    (projectMatches.length === 1 ? projectMatches[0] : null) ??
    (installed.length === 1 ? installed[0] : null);

  if (!selected) {
    return {
      runtimeCandidates: installed.map((entry) => entry.provider.id),
    };
  }

  return {
    runtimeProviderId: selected.provider.id,
    runtimeToolName: selected.provider.toolName,
    runtimeVendor: selected.provider.vendor,
    runtimeInstructionFile: selected.provider.instructFile,
    runtimeProjectDetected: selected.projectDetected,
    runtimeDetectionMethods: selected.methods,
    runtimeCandidates: installed.map((entry) => entry.provider.id),
    inferredModelProvider: inferProviderFromVendor(selected.provider.vendor),
  };
}

let cachedRuntimeProvider: RuntimeProviderContext | null = null;

export function detectRuntimeProviderContext(
  snapshot: RuntimeProviderSnapshot = {},
): RuntimeProviderContext {
  if (!snapshot.cwd && !snapshot.argv && !snapshot.env && cachedRuntimeProvider) {
    return cachedRuntimeProvider;
  }

  try {
    const detections = detectProjectProviders(snapshot.cwd ?? process.cwd());
    const context = selectRuntimeProviderContext(detections, snapshot);
    if (!snapshot.cwd && !snapshot.argv && !snapshot.env) {
      cachedRuntimeProvider = context;
    }
    return context;
  } catch {
    return {};
  }
}

export function resetRuntimeProviderContextCache(): void {
  cachedRuntimeProvider = null;
}
