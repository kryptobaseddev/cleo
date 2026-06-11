/**
 * Local-model fit ranking for Ollama-backed open-weight models (T11982).
 *
 * ## Purpose
 *
 * Given the current machine's hardware (RAM, VRAM), rank 2–3 curated
 * open-weight models that are actually likely to run well. This is the
 * `cleo llm fit` wizard building block — it powers T11983's one-keypress
 * pull+connect flow.
 *
 * ## Vendor-vs-inspire decision (llmfit)
 *
 * Evaluated `github.com/AlexsJones/llmfit` (MIT, Go, ~400 LOC). The library
 * is a standalone Go binary — not a TS/ESM package. Its key contribution is
 * the IDEA: use RAM thresholds to gate model selection, prefer VRAM when
 * available, and produce a ranked list with human-readable reasons. We
 * **vendor the IDEA** (TS-native re-implementation) rather than shelling out
 * to a Go binary or adding a cross-language dependency. The model thresholds
 * below are independently calibrated from Ollama's documentation and the
 * Hugging Face model cards, not copy-pasted from llmfit.
 *
 * ## Gate-13 compliance
 *
 * This module:
 * - MUST NOT construct any transport or SDK client.
 * - MUST NOT read `process.env.*_API_KEY` directly.
 * - MUST NOT define a new `resolveLLMFor*` function.
 * - MUST NOT hardcode model-id literals in logic — all model IDs come from
 *   the {@link LOCAL_MODEL_CANDIDATES} data table.
 *
 * The hardware detection (`os.totalmem`, `os.freemem`, `/proc/meminfo`,
 * `nvidia-smi`) is plain system inspection — not covered by Gate-13 (which
 * governs LLM resolution / transport construction).
 *
 * Ollama liveness re-uses {@link probeOllamaAlive} from
 * `cross-provider-selector.ts` (no duplication). The `/api/tags` fetch is
 * a vanilla HTTP call to localhost, not a transport construction.
 *
 * @module llm/local-model-fit
 * @task T11982
 * @epic T11671
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import { promisify } from 'node:util';
import { getLogger } from '../logger.js';
import { probeOllamaAlive } from './cross-provider-selector.js';

const execFileAsync = promisify(execFile);
const logger = getLogger('llm-local-model-fit');

// ---------------------------------------------------------------------------
// Curated model candidate table (SSoT — all model IDs live HERE, not in logic)
// ---------------------------------------------------------------------------

/**
 * A single entry in the curated open-weight model catalog.
 *
 * These values are calibrated from Ollama model pages and Hugging Face cards.
 * Quantisation notes describe the default GGUF quantisation level pulled by
 * `ollama pull <model>`.
 */
export interface LocalModelCandidate {
  /** Ollama model tag (used verbatim in `ollama pull <modelTag>`). */
  readonly modelTag: string;
  /** Human-readable display name. */
  readonly displayName: string;
  /** Model family (for grouping in the wizard). */
  readonly family: 'gemma3' | 'qwen3' | 'llama3.2' | 'qwen2.5-coder' | 'phi4';
  /** Minimum RAM required to run (worst-case, CPU inference), in GiB. */
  readonly minRamGb: number;
  /** Recommended RAM for comfortable CPU inference, in GiB. */
  readonly recommendedRamGb: number;
  /** Minimum VRAM required for GPU acceleration, in GiB (0 = CPU-only model). */
  readonly minVramGb: number;
  /** Recommended VRAM for full GPU offload, in GiB (0 = CPU-only model). */
  readonly recommendedVramGb: number;
  /** Approximate model size on disk (for download size estimation), in GiB. */
  readonly diskSizeGb: number;
  /** Default quantisation pulled by `ollama pull` (informational). */
  readonly quantNote: string;
  /**
   * Whether this model is intended for code tasks (true) or general use (false).
   * Shown as a tag in the wizard.
   */
  readonly codeSpecialist: boolean;
  /**
   * Context window in tokens.
   * Used to surface context-length as a selection criterion.
   */
  readonly contextLengthK: number;
}

/**
 * Curated candidate table. These are the ONLY models `rankLocalModelFit`
 * can recommend — expand this table to add new models.
 *
 * Exclusions:
 * - `qwen2:0.5b` — proof-of-life only; deliberately absent from this list.
 *
 * @task T11982
 */
export const LOCAL_MODEL_CANDIDATES: ReadonlyArray<LocalModelCandidate> = [
  {
    modelTag: 'gemma3:1b',
    displayName: 'Gemma 3 1B',
    family: 'gemma3',
    minRamGb: 3,
    recommendedRamGb: 4,
    minVramGb: 2,
    recommendedVramGb: 3,
    diskSizeGb: 0.8,
    quantNote: 'Q4_K_M (default pull)',
    codeSpecialist: false,
    contextLengthK: 128,
  },
  {
    modelTag: 'gemma3:4b',
    displayName: 'Gemma 3 4B',
    family: 'gemma3',
    minRamGb: 6,
    recommendedRamGb: 8,
    minVramGb: 5,
    recommendedVramGb: 6,
    diskSizeGb: 3.1,
    quantNote: 'Q4_K_M (default pull)',
    codeSpecialist: false,
    contextLengthK: 128,
  },
  {
    modelTag: 'gemma3:12b',
    displayName: 'Gemma 3 12B',
    family: 'gemma3',
    minRamGb: 10,
    recommendedRamGb: 16,
    minVramGb: 9,
    recommendedVramGb: 12,
    diskSizeGb: 8.1,
    quantNote: 'Q4_K_M (default pull)',
    codeSpecialist: false,
    contextLengthK: 128,
  },
  {
    modelTag: 'qwen3:1.7b',
    displayName: 'Qwen 3 1.7B',
    family: 'qwen3',
    minRamGb: 3,
    recommendedRamGb: 4,
    minVramGb: 2,
    recommendedVramGb: 3,
    diskSizeGb: 1.4,
    quantNote: 'Q4_K_M (default pull)',
    codeSpecialist: false,
    contextLengthK: 32,
  },
  {
    modelTag: 'qwen3:4b',
    displayName: 'Qwen 3 4B',
    family: 'qwen3',
    minRamGb: 6,
    recommendedRamGb: 8,
    minVramGb: 4,
    recommendedVramGb: 6,
    diskSizeGb: 2.6,
    quantNote: 'Q4_K_M (default pull)',
    codeSpecialist: false,
    contextLengthK: 32,
  },
  {
    modelTag: 'qwen3:8b',
    displayName: 'Qwen 3 8B',
    family: 'qwen3',
    minRamGb: 8,
    recommendedRamGb: 12,
    minVramGb: 7,
    recommendedVramGb: 10,
    diskSizeGb: 5.2,
    quantNote: 'Q4_K_M (default pull)',
    codeSpecialist: false,
    contextLengthK: 32,
  },
  {
    modelTag: 'llama3.2:3b',
    displayName: 'Llama 3.2 3B',
    family: 'llama3.2',
    minRamGb: 4,
    recommendedRamGb: 6,
    minVramGb: 3,
    recommendedVramGb: 4,
    diskSizeGb: 2.0,
    quantNote: 'Q4_K_M (default pull)',
    codeSpecialist: false,
    contextLengthK: 128,
  },
  {
    modelTag: 'qwen2.5-coder:3b',
    displayName: 'Qwen 2.5 Coder 3B',
    family: 'qwen2.5-coder',
    minRamGb: 4,
    recommendedRamGb: 6,
    minVramGb: 3,
    recommendedVramGb: 4,
    diskSizeGb: 1.9,
    quantNote: 'Q4_K_M (default pull)',
    codeSpecialist: true,
    contextLengthK: 128,
  },
  {
    modelTag: 'phi4-mini:3.8b',
    displayName: 'Phi 4 Mini 3.8B',
    family: 'phi4',
    minRamGb: 4,
    recommendedRamGb: 6,
    minVramGb: 3,
    recommendedVramGb: 4,
    diskSizeGb: 2.5,
    quantNote: 'Q4_K_M (default pull)',
    codeSpecialist: false,
    contextLengthK: 128,
  },
] as const;

// ---------------------------------------------------------------------------
// Hardware detection
// ---------------------------------------------------------------------------

/**
 * VRAM detection result.
 *
 * VRAM detection is best-effort and graceful — the field is `null` when no
 * GPU is detected (nvidia-smi absent, no Apple Silicon heuristic, etc.).
 */
export interface VramInfo {
  /** Total VRAM in bytes, or null if detection failed. */
  totalBytes: number | null;
  /** Free VRAM in bytes, or null if detection failed. */
  freeBytes: number | null;
  /** Detection method used. */
  method: 'nvidia-smi' | 'rocm-smi' | 'apple-unified' | 'none';
}

/**
 * Full hardware snapshot used by the ranking algorithm.
 */
export interface HardwareSnapshot {
  /** Total system RAM in bytes (from `os.totalmem()`). */
  totalRamBytes: number;
  /**
   * Available RAM in bytes.
   * Linux: from `/proc/meminfo` `MemAvailable` (more accurate than `os.freemem`).
   * Other platforms: `os.freemem()`.
   */
  availableRamBytes: number;
  /** VRAM information (best-effort, never throws). */
  vram: VramInfo;
  /** Detected platform. */
  platform: string;
}

/**
 * Read `MemAvailable` from `/proc/meminfo` on Linux.
 *
 * Returns `null` on non-Linux or if the file is unreadable.
 *
 * @internal
 */
async function readLinuxMemAvailableBytes(): Promise<number | null> {
  try {
    const content = await readFile('/proc/meminfo', 'utf-8');
    for (const line of content.split('\n')) {
      if (line.startsWith('MemAvailable:')) {
        // Format: "MemAvailable:   42233788 kB"
        const match = /MemAvailable:\s+(\d+)\s+kB/.exec(line);
        if (match?.[1]) {
          return parseInt(match[1], 10) * 1024;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Detect NVIDIA VRAM via `nvidia-smi`.
 *
 * Returns `null` fields if the binary is absent or errors.
 *
 * @internal
 */
async function detectNvidiaVram(): Promise<VramInfo | null> {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=memory.total,memory.free',
      '--format=csv,noheader,nounits',
    ]);
    // Output: "10240, 7995" (in MiB)
    const parts = stdout.trim().split(',');
    if (parts.length >= 2) {
      const totalMib = parseInt(parts[0]!.trim(), 10);
      const freeMib = parseInt(parts[1]!.trim(), 10);
      if (!Number.isNaN(totalMib) && !Number.isNaN(freeMib)) {
        return {
          totalBytes: totalMib * 1024 * 1024,
          freeBytes: freeMib * 1024 * 1024,
          method: 'nvidia-smi',
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Detect AMD VRAM via `rocm-smi`.
 *
 * Returns `null` fields if the binary is absent or errors.
 *
 * @internal
 */
async function detectRocmVram(): Promise<VramInfo | null> {
  try {
    const { stdout } = await execFileAsync('rocm-smi', ['--showmeminfo', 'vram', '--csv']);
    // rocm-smi CSV: variable format, heuristically parse for Total/Used lines
    const totalMatch = /Total\s+VRAM.*?(\d+)/i.exec(stdout);
    const usedMatch = /Used\s+VRAM.*?(\d+)/i.exec(stdout);
    if (totalMatch?.[1]) {
      const totalBytes = parseInt(totalMatch[1], 10) * 1024 * 1024;
      const usedBytes = usedMatch?.[1] ? parseInt(usedMatch[1], 10) * 1024 * 1024 : null;
      return {
        totalBytes,
        freeBytes: usedBytes !== null ? totalBytes - usedBytes : null,
        method: 'rocm-smi',
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Capture a full hardware snapshot.
 *
 * Never throws — VRAM detection failures degrade gracefully to `null`.
 *
 * @param overrides - Override fields for testing (avoids OS calls in unit tests).
 * @returns A hardware snapshot describing this machine's capabilities.
 *
 * @task T11982
 */
export async function captureHardwareSnapshot(overrides?: {
  totalRamBytes?: number;
  availableRamBytes?: number;
  vram?: VramInfo;
  platform?: string;
}): Promise<HardwareSnapshot> {
  const platform = overrides?.platform ?? process.platform;
  const totalRamBytes = overrides?.totalRamBytes ?? totalmem();

  let availableRamBytes: number;
  if (overrides?.availableRamBytes !== undefined) {
    availableRamBytes = overrides.availableRamBytes;
  } else if (platform === 'linux') {
    availableRamBytes = (await readLinuxMemAvailableBytes()) ?? freemem();
  } else {
    availableRamBytes = freemem();
  }

  let vram: VramInfo;
  if (overrides?.vram !== undefined) {
    vram = overrides.vram;
  } else {
    // Try NVIDIA first, then AMD, then Apple-Silicon heuristic.
    const nvidia = await detectNvidiaVram();
    if (nvidia) {
      vram = nvidia;
    } else {
      const amd = await detectRocmVram();
      if (amd) {
        vram = amd;
      } else if (platform === 'darwin') {
        // Apple Silicon unified memory: VRAM = total RAM (conservative floor).
        vram = {
          totalBytes: totalRamBytes,
          freeBytes: availableRamBytes,
          method: 'apple-unified',
        };
      } else {
        vram = { totalBytes: null, freeBytes: null, method: 'none' };
      }
    }
  }

  return { totalRamBytes, availableRamBytes, vram, platform };
}

// ---------------------------------------------------------------------------
// Ollama model list
// ---------------------------------------------------------------------------

/**
 * A model already pulled and available locally in Ollama.
 */
export interface OllamaPulledModel {
  /** Tag as returned by `/api/tags`. */
  name: string;
  /** Parameter size string (e.g. `"3.1B"`). */
  parameterSize: string;
  /** Quantisation level (e.g. `"Q4_K_M"`). */
  quantizationLevel: string;
  /** Model family (e.g. `"qwen2"`). */
  family: string;
}

/**
 * Parse raw `/api/tags` response from Ollama.
 *
 * @internal
 */
function parseOllamaTagsResponse(body: unknown): OllamaPulledModel[] {
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as Record<string, unknown>)['models'])
  ) {
    return [];
  }
  const models = (body as { models: unknown[] }).models;
  const result: OllamaPulledModel[] = [];
  for (const m of models) {
    if (typeof m !== 'object' || m === null) continue;
    const model = m as Record<string, unknown>;
    const name = typeof model['name'] === 'string' ? model['name'] : '';
    const details =
      typeof model['details'] === 'object' && model['details'] !== null
        ? (model['details'] as Record<string, unknown>)
        : {};
    const parameterSize =
      typeof details['parameter_size'] === 'string' ? details['parameter_size'] : '';
    const quantizationLevel =
      typeof details['quantization_level'] === 'string' ? details['quantization_level'] : '';
    const family = typeof details['family'] === 'string' ? details['family'] : '';
    if (name) {
      result.push({ name, parameterSize, quantizationLevel, family });
    }
  }
  return result;
}

/**
 * Fetch the list of locally-pulled models from Ollama's `/api/tags` endpoint.
 *
 * Uses the HTTP API (not shelling out) — Gate-13 does not govern plain `fetch`
 * calls to localhost.
 *
 * @param baseUrl - Ollama base URL (default `http://localhost:11434`).
 * @param fetchFn - Injectable `fetch` for testing (defaults to global `fetch`).
 * @returns Array of pulled models, or empty array if Ollama is not reachable.
 *
 * @task T11982
 */
export async function listOllamaPulledModels(
  baseUrl = 'http://localhost:11434',
  fetchFn: typeof fetch = fetch,
): Promise<OllamaPulledModel[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}/api/tags`, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return [];
    const body: unknown = await response.json();
    return parseOllamaTagsResponse(body);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Ranking algorithm
// ---------------------------------------------------------------------------

/**
 * Hard RAM floor below which no local model recommendation is made.
 * Machines under this threshold are steered toward cloud providers instead.
 */
export const LOCAL_FIT_FLOOR_GB = 4;

/**
 * A ranked local model fit result.
 */
export interface LocalModelFitResult {
  /** The candidate model. */
  candidate: LocalModelCandidate;
  /**
   * Overall fit score (higher is better).
   * Used to rank candidates — not surfaced directly in the wizard UI.
   */
  score: number;
  /**
   * Whether this model is already pulled in the local Ollama installation.
   * Models that are already pulled get a score boost (prefer not re-downloading).
   */
  alreadyPulled: boolean;
  /**
   * Human-readable fit reasons (bullet list for wizard display).
   * Examples: "fits in 10GB VRAM", "already pulled", "recommended for 8GB RAM".
   */
  reasons: string[];
  /**
   * Fit tier:
   * - `'excellent'` — hardware is well above requirements; full GPU offload expected.
   * - `'good'`      — hardware meets recommended threshold; runs well.
   * - `'marginal'`  — hardware meets minimum; expect slower inference.
   */
  fitTier: 'excellent' | 'good' | 'marginal';
  /**
   * The `ollama pull <pullCommand>` string for this model.
   */
  pullCommand: string;
}

/**
 * Output envelope returned by {@link rankLocalModelFit}.
 */
export interface LocalModelFitEnvelope {
  /** Hardware snapshot used for ranking. */
  hardware: {
    totalRamGb: number;
    availableRamGb: number;
    vramTotalGb: number | null;
    vramFreeGb: number | null;
    vramMethod: VramInfo['method'];
  };
  /** Whether Ollama was detected as running. */
  ollamaRunning: boolean;
  /** Models already available in the local Ollama installation. */
  pulledModels: OllamaPulledModel[];
  /**
   * Ranked 2–3 best-fit candidates.
   * Empty when hardware is below the 4 GB floor.
   */
  recommendations: LocalModelFitResult[];
  /**
   * Human-readable explanation when no recommendations are available.
   * null when recommendations is non-empty.
   */
  noRecommendationReason: string | null;
}

/** Score bonus when the model is already pulled locally. */
const ALREADY_PULLED_BONUS = 50;
/** Score bonus when VRAM is sufficient for full GPU offload. */
const VRAM_FULL_OFFLOAD_BONUS = 40;
/** Score bonus when VRAM meets the minimum (partial offload). */
const VRAM_PARTIAL_BONUS = 15;
/** Score bonus when available RAM exceeds the recommended threshold. */
const RAM_COMFORTABLE_BONUS = 20;
/** Score bonus when RAM is sufficient but below recommended. */
const RAM_SUFFICIENT_BONUS = 5;
/** Penalty when the model barely meets the minimum RAM. */
const RAM_TIGHT_PENALTY = -10;
/** Score bonus for models with longer context windows. */
const LONG_CONTEXT_BONUS = 8;

/**
 * Compute the fit score for a candidate given this machine's hardware.
 *
 * @internal
 */
function scoreCandidate(
  candidate: LocalModelCandidate,
  snapshot: HardwareSnapshot,
  alreadyPulled: boolean,
): { score: number; reasons: string[]; fitTier: LocalModelFitResult['fitTier'] } {
  const ramGb = snapshot.totalRamBytes / 1024 ** 3;
  const availableRamGb = snapshot.availableRamBytes / 1024 ** 3;
  const vramTotalGb =
    snapshot.vram.totalBytes !== null ? snapshot.vram.totalBytes / 1024 ** 3 : null;
  const vramFreeGb = snapshot.vram.freeBytes !== null ? snapshot.vram.freeBytes / 1024 ** 3 : null;

  let score = 0;
  const reasons: string[] = [];
  let fitTier: LocalModelFitResult['fitTier'] = 'marginal';

  // VRAM scoring
  if (vramTotalGb !== null && vramFreeGb !== null && candidate.minVramGb > 0) {
    if (vramFreeGb >= candidate.recommendedVramGb) {
      score += VRAM_FULL_OFFLOAD_BONUS;
      reasons.push(
        `fits in ${vramFreeGb.toFixed(1)} GB free VRAM (recommended: ${candidate.recommendedVramGb} GB)`,
      );
      fitTier = 'excellent';
    } else if (vramFreeGb >= candidate.minVramGb) {
      score += VRAM_PARTIAL_BONUS;
      reasons.push(
        `partial GPU offload possible (${vramFreeGb.toFixed(1)} GB free VRAM, min: ${candidate.minVramGb} GB)`,
      );
      // fitTier is 'marginal' here (VRAM partial offload: 'good' is appropriate)
      fitTier = 'good';
    } else {
      reasons.push(
        `CPU inference only — VRAM ${vramFreeGb.toFixed(1)} GB below model minimum ${candidate.minVramGb} GB`,
      );
    }
  } else if (candidate.minVramGb === 0) {
    reasons.push('optimised for CPU inference');
  } else if (snapshot.vram.method === 'none') {
    reasons.push('no GPU detected — will use CPU inference');
  }

  // RAM scoring
  if (availableRamGb >= candidate.recommendedRamGb) {
    score += RAM_COMFORTABLE_BONUS;
    reasons.push(
      `${availableRamGb.toFixed(1)} GB available RAM (recommended: ${candidate.recommendedRamGb} GB)`,
    );
    if (fitTier !== 'excellent') fitTier = 'good';
  } else if (ramGb >= candidate.recommendedRamGb) {
    score += RAM_SUFFICIENT_BONUS;
    reasons.push(`${ramGb.toFixed(1)} GB total RAM meets recommendation (some swap may be used)`);
    if (fitTier !== 'excellent') fitTier = 'good';
  } else if (ramGb >= candidate.minRamGb) {
    score += RAM_TIGHT_PENALTY;
    reasons.push(
      `${ramGb.toFixed(1)} GB RAM meets minimum — expect slower inference (recommended: ${candidate.recommendedRamGb} GB)`,
    );
    // fitTier stays 'marginal'
  }

  // Context window bonus
  if (candidate.contextLengthK >= 128) {
    score += LONG_CONTEXT_BONUS;
    reasons.push(`${candidate.contextLengthK}k context window`);
  }

  // Already-pulled bonus
  if (alreadyPulled) {
    score += ALREADY_PULLED_BONUS;
    reasons.push('already pulled — no download needed');
  }

  return { score, reasons, fitTier };
}

/**
 * Rank the 2–3 best-fit local open-weight models for this machine.
 *
 * ## Floor
 *
 * Machines with total RAM below {@link LOCAL_FIT_FLOOR_GB} (4 GB) receive no
 * recommendations. This deliberately excludes `qwen2:0.5b` (proof-of-life
 * only) — it is absent from {@link LOCAL_MODEL_CANDIDATES}.
 *
 * ## Algorithm
 *
 *   1. Capture hardware snapshot.
 *   2. Probe Ollama liveness and fetch the pulled-models list.
 *   3. Filter candidates to those whose `minRamGb` ≤ total RAM.
 *   4. Score remaining candidates (VRAM fit + RAM comfort + already-pulled bonus).
 *   5. Return the top 3 (or fewer), ordered by score descending.
 *
 * @param opts - Override hardware snapshot for testing.
 * @returns Fit envelope with ranked candidates.
 *
 * @task T11982
 */
export async function rankLocalModelFit(opts?: {
  /** Override the hardware snapshot (for testing). */
  hardwareOverride?: Parameters<typeof captureHardwareSnapshot>[0];
  /** Override Ollama base URL. */
  ollamaBaseUrl?: string;
  /** Injectable fetch for testing. */
  fetchFn?: typeof fetch;
  /** Override pulled models list (for testing). */
  pulledModelsOverride?: OllamaPulledModel[];
}): Promise<LocalModelFitEnvelope> {
  const ollamaBaseUrl = opts?.ollamaBaseUrl ?? 'http://localhost:11434';

  const [snapshot, ollamaRunning] = await Promise.all([
    captureHardwareSnapshot(opts?.hardwareOverride),
    probeOllamaAlive(ollamaBaseUrl),
  ]);

  const pulledModels =
    opts?.pulledModelsOverride ??
    (ollamaRunning ? await listOllamaPulledModels(ollamaBaseUrl, opts?.fetchFn) : []);

  const pulledTags = new Set(pulledModels.map((m) => m.name));
  const ramGb = snapshot.totalRamBytes / 1024 ** 3;

  const hardware: LocalModelFitEnvelope['hardware'] = {
    totalRamGb: ramGb,
    availableRamGb: snapshot.availableRamBytes / 1024 ** 3,
    vramTotalGb: snapshot.vram.totalBytes !== null ? snapshot.vram.totalBytes / 1024 ** 3 : null,
    vramFreeGb: snapshot.vram.freeBytes !== null ? snapshot.vram.freeBytes / 1024 ** 3 : null,
    vramMethod: snapshot.vram.method,
  };

  // Hard floor: machines under LOCAL_FIT_FLOOR_GB get no recommendation.
  if (ramGb < LOCAL_FIT_FLOOR_GB) {
    logger.warn(
      { ramGb: ramGb.toFixed(1), floorGb: LOCAL_FIT_FLOOR_GB },
      'local-model-fit: RAM below floor — no local model recommended',
    );
    return {
      hardware,
      ollamaRunning,
      pulledModels,
      recommendations: [],
      noRecommendationReason: `This machine has only ${ramGb.toFixed(1)} GB RAM. Local LLM inference requires at least ${LOCAL_FIT_FLOOR_GB} GB. Use a cloud provider instead.`,
    };
  }

  // Filter to candidates that at minimum fit in RAM.
  const eligible = LOCAL_MODEL_CANDIDATES.filter((c) => ramGb >= c.minRamGb);

  if (eligible.length === 0) {
    return {
      hardware,
      ollamaRunning,
      pulledModels,
      recommendations: [],
      noRecommendationReason: `No curated model fits the available RAM (${ramGb.toFixed(1)} GB).`,
    };
  }

  // Score every eligible candidate.
  const scored: LocalModelFitResult[] = eligible.map((candidate) => {
    const alreadyPulled = pulledTags.has(candidate.modelTag);
    const { score, reasons, fitTier } = scoreCandidate(candidate, snapshot, alreadyPulled);
    return {
      candidate,
      score,
      alreadyPulled,
      reasons,
      fitTier,
      pullCommand: `ollama pull ${candidate.modelTag}`,
    };
  });

  // Sort by score descending, then by displayName ascending for stable tie-break.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.candidate.modelTag.localeCompare(b.candidate.modelTag);
  });

  // Return top 3.
  const recommendations = scored.slice(0, 3);

  return {
    hardware,
    ollamaRunning,
    pulledModels,
    recommendations,
    noRecommendationReason: null,
  };
}
