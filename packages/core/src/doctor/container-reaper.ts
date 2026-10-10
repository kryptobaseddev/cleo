/**
 * Bounded reaper for throwaway containers (T13436), behind
 * `cleo doctor system --repair` (dry run) and `--repair --apply`.
 *
 * The convention: a throwaway container is started with `docker run --rm` or
 * labelled `cleo.task=<id>` and `cleo.ttl=<duration>` (`4h`, `2d`). The reaper
 * removes exactly two things:
 * - STOPPED containers carrying `cleo.ttl` created longer ago than it (opted in
 *   by the label);
 * - anonymous volumes no container uses (64-hex names: the ones
 *   `docker run` without `--rm` leaves behind, from any container).
 *
 * A RUNNING labelled container is never removed: one past its ttl since it
 * last STARTED (a restart resets the clock, creation does not) is only
 * reported, because a reused container may be mid-test (T13451). It never
 * touches an unlabelled container or a named volume.
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

/** `docker ps` columns {@link planContainerReap} reads; labels last (they may hold anything but tabs). */
export const LABELLED_FORMAT =
  '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.CreatedAt}}\t{{.State}}\t{{.Labels}}';

/** A labelled container past its ttl. */
export interface ReapContainer {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly task: string | null;
  readonly ttl: string;
  /** Since creation for a stopped container, since its last start for a running one. */
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
  /** Stopped containers past their ttl: removed by `--apply`. */
  readonly containers: readonly ReapContainer[];
  /** Running containers past their ttl since their last start: reported, never removed. */
  readonly runningExpired: readonly ReapContainer[];
  readonly volumes: readonly string[];
  /** Labelled containers whose `cleo.ttl` could not be parsed (left alone). */
  readonly invalidTtl: readonly string[];
  readonly applied: readonly ReapOutcome[];
}

/** Raw docker output for {@link planContainerReap}. */
export interface ContainerReapInput {
  /** `docker ps -a --filter label=cleo.ttl --format` {@link LABELLED_FORMAT}. */
  readonly labelledContainers: string | null;
  /** Full container id → `State.StartedAt` (RFC 3339), for the running candidates. */
  readonly startedAt: Readonly<Record<string, string>>;
  /**
   * Full container id → `State.FinishedAt`, for the stopped candidates: a stopped
   * container's ttl runs from when it last stopped, so one reused across runs
   * is not removed between them. Docker's zero time (never started) falls back
   * to `CreatedAt`.
   */
  readonly finishedAt?: Readonly<Record<string, string>>;
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
  const runningExpired: ReapContainer[] = [];
  const invalidTtl: string[] = [];
  const timeOf = (map: Readonly<Record<string, string>>, id: string): number => {
    const full = Object.keys(map).find((k) => k.startsWith(id));
    const at = full === undefined ? '' : (map[full] ?? '');
    // Docker's zero time means "never"; drop sub-millisecond digits Date.parse may not accept.
    return at === '' || at.startsWith('0001-')
      ? Number.NaN
      : Date.parse(at.replace(/(\.\d{3})\d+/, '$1'));
  };
  for (const line of (input.labelledContainers ?? '').split('\n')) {
    const [id, name, image, createdAt, state, rawLabels = ''] = line.split('\t');
    if (!id || !name || !image || !createdAt || !state) continue;
    const labels = parseLabels(rawLabels);
    const ttl = labels.get(CLEO_TTL_LABEL);
    if (ttl === undefined) continue;
    const ttlSec = parseTtl(ttl);
    const running = state === 'running' || state === 'restarting' || state === 'paused';
    const finished = timeOf(input.finishedAt ?? {}, id);
    const since = running
      ? timeOf(input.startedAt, id)
      : Number.isNaN(finished)
        ? parseDockerCreatedAt(createdAt)
        : finished;
    if (ttlSec === null || Number.isNaN(since)) {
      invalidTtl.push(name);
      continue;
    }
    const ageSec = Math.round((input.nowMs - since) / 1000);
    if (ageSec <= ttlSec) continue;
    const entry = { id, name, image, task: labels.get(CLEO_TASK_LABEL) ?? null, ttl, ageSec };
    (running ? runningExpired : containers).push(entry);
  }
  const volumes = (input.danglingVolumes ?? '')
    .split('\n')
    .map((v) => v.trim())
    .filter((v) => ANONYMOUS_VOLUME.test(v));
  return {
    mode: 'dry-run',
    dockerAvailable: input.labelledContainers !== null || input.danglingVolumes !== null,
    containers,
    runningExpired,
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
    readDocker(['ps', '-a', '--filter', `label=${CLEO_TTL_LABEL}`, '--format', LABELLED_FORMAT]),
    readDocker(['volume', 'ls', '-q', '-f', 'dangling=true']),
  ]);
  const ids = (labelledContainers ?? '')
    .split('\n')
    .map((l) => l.split('\t')[0] ?? '')
    .filter((id) => id !== '');
  const startedAt: Record<string, string> = {};
  const finishedAt: Record<string, string> = {};
  if (ids.length > 0) {
    const out = await readDocker([
      'inspect',
      '--format',
      '{{.Id}}\t{{.State.StartedAt}}\t{{.State.FinishedAt}}',
      ...ids,
    ]);
    for (const line of (out ?? '').split('\n')) {
      const [id, started, finished] = line.split('\t');
      if (id && started) startedAt[id] = started;
      if (id && finished) finishedAt[id] = finished;
    }
  }
  return { labelledContainers, danglingVolumes, startedAt, finishedAt, nowMs: Date.now() };
}

/**
 * Remove exactly what `plan` lists: each expired STOPPED labelled container
 * with `docker rm -v`, never `-f`, so one started since the plan is refused by
 * docker and reported (its anonymous volumes go with it, named ones never do),
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
    const error = await docker(['rm', '-v', c.id]);
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
