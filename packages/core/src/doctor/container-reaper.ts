/**
 * Bounded reaper for throwaway containers (T13436), behind
 * `cleo doctor system --repair` (dry run) and `--repair --apply`.
 *
 * The convention: a throwaway container is started with `docker run --rm` or
 * labelled `cleo.task=<id>` and `cleo.ttl=<duration>` (`4h`, `2d`). The reaper
 * removes exactly two things:
 * - containers carrying `cleo.ttl` whose age is past it (opted in by the label);
 * - anonymous volumes no container uses (64-hex names: the ones
 *   `docker run` without `--rm` leaves behind).
 *
 * It never touches an unlabelled container, running or not, or a named volume.
 *
 * @task T13436
 * @epic T13434
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseDockerCreatedAt } from './system-health.js';

/** The label that opts a container into reaping, with its time to live. */
export const CLEO_TTL_LABEL = 'cleo.ttl';
/** The label naming the task a container was started for. */
export const CLEO_TASK_LABEL = 'cleo.task';

/** A container the reaper would remove. */
export interface ReapContainer {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly task: string | null;
  readonly ttl: string;
  readonly ageSec: number;
}

/** One removal and its outcome. */
export interface ReapOutcome {
  readonly target: string;
  readonly kind: 'container' | 'volume';
  readonly ok: boolean;
  readonly error?: string;
}

/** What the reaper found, and (with `--apply`) what it removed. */
export interface ContainerReapPlan {
  readonly mode: 'dry-run' | 'apply';
  /** False when docker is absent or did not answer: nothing was assessed. */
  readonly dockerAvailable: boolean;
  readonly containers: readonly ReapContainer[];
  readonly volumes: readonly string[];
  /** Labelled containers whose `cleo.ttl` could not be parsed (left alone). */
  readonly invalidTtl: readonly string[];
  readonly applied: readonly ReapOutcome[];
}

/** Raw docker output for {@link planContainerReap}. */
export interface ContainerReapInput {
  /** `docker ps -a --filter label=cleo.ttl --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.CreatedAt}}\t{{.Labels}}'`. */
  readonly labelledContainers: string | null;
  /** `docker volume ls -q -f dangling=true`. */
  readonly danglingVolumes: string | null;
  readonly nowMs: number;
}

/** `90s`, `30m`, `4h`, `2d` to seconds; `null` when not a duration. */
export function parseTtl(ttl: string): number | null {
  const m = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!m) return null;
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's' | 'm' | 'h' | 'd'];
}

/** Docker's `k=v,k=v` label list to a map. */
function parseLabels(labels: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of labels.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) out.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return out;
}

/** Anonymous volumes have docker-generated 64-hex names; named volumes do not. */
const ANONYMOUS_VOLUME = /^[0-9a-f]{64}$/;

/**
 * Decide what to reap. Pure.
 *
 * @example
 * ```ts
 * planContainerReap({ labelledContainers, danglingVolumes, nowMs: Date.now() }).containers;
 * ```
 *
 * @task T13436
 */
export function planContainerReap(input: ContainerReapInput): ContainerReapPlan {
  const containers: ReapContainer[] = [];
  const invalidTtl: string[] = [];
  for (const line of (input.labelledContainers ?? '').split('\n')) {
    const [id, name, image, createdAt, rawLabels = ''] = line.split('\t');
    if (!id || !name || !image || !createdAt) continue;
    const labels = parseLabels(rawLabels);
    const ttl = labels.get(CLEO_TTL_LABEL);
    if (ttl === undefined) continue;
    const ttlSec = parseTtl(ttl);
    const created = parseDockerCreatedAt(createdAt);
    if (ttlSec === null || Number.isNaN(created)) {
      invalidTtl.push(name);
      continue;
    }
    const ageSec = Math.round((input.nowMs - created) / 1000);
    if (ageSec > ttlSec) {
      containers.push({ id, name, image, task: labels.get(CLEO_TASK_LABEL) ?? null, ttl, ageSec });
    }
  }
  const volumes = (input.danglingVolumes ?? '')
    .split('\n')
    .map((v) => v.trim())
    .filter((v) => ANONYMOUS_VOLUME.test(v));
  return {
    mode: 'dry-run',
    dockerAvailable: input.labelledContainers !== null || input.danglingVolumes !== null,
    containers,
    volumes,
    invalidTtl,
    applied: [],
  };
}

const execFileAsync = promisify(execFile);

/** Runs `docker <args>`; resolves to the error text, or `null` on success. */
export type DockerRunFn = (args: readonly string[]) => Promise<string | null>;

const defaultDocker: DockerRunFn = async (args) => {
  try {
    await execFileAsync('docker', [...args], { timeout: 60_000, encoding: 'utf8' });
    return null;
  } catch (err) {
    return err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
  }
};

const readDocker = async (args: readonly string[]): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync('docker', [...args], {
      timeout: 5000,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout;
  } catch {
    return null;
  }
};

/**
 * Read docker for {@link planContainerReap}. Never throws; an absent docker
 * gives `null` outputs and a plan with `dockerAvailable: false`.
 *
 * @task T13436
 */
export async function collectContainerReapInput(): Promise<ContainerReapInput> {
  const [labelledContainers, danglingVolumes] = await Promise.all([
    readDocker([
      'ps',
      '-a',
      '--filter',
      `label=${CLEO_TTL_LABEL}`,
      '--format',
      '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.CreatedAt}}\t{{.Labels}}',
    ]),
    readDocker(['volume', 'ls', '-q', '-f', 'dangling=true']),
  ]);
  return { labelledContainers, danglingVolumes, nowMs: Date.now() };
}

/**
 * Remove exactly what `plan` lists: each expired labelled container with
 * `docker rm -f -v` (its anonymous volumes go with it, named ones never do),
 * then each anonymous dangling volume. A volume that gained a user since the
 * plan is refused by docker and reported, not forced.
 *
 * @task T13436
 */
export async function applyContainerReap(
  plan: ContainerReapPlan,
  docker: DockerRunFn = defaultDocker,
): Promise<ContainerReapPlan> {
  const applied: ReapOutcome[] = [];
  for (const c of plan.containers) {
    const error = await docker(['rm', '-f', '-v', c.id]);
    applied.push({
      target: c.name,
      kind: 'container',
      ok: error === null,
      ...(error ? { error } : {}),
    });
  }
  for (const v of plan.volumes) {
    const error = await docker(['volume', 'rm', v]);
    applied.push({ target: v, kind: 'volume', ok: error === null, ...(error ? { error } : {}) });
  }
  return { ...plan, mode: 'apply', applied };
}
