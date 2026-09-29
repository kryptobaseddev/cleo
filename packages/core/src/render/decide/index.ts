/**
 * Human renderers for `cleo decide` (System One): `config`, `status`, `ask`
 * and the profile list (`profiles`, `use`, `config --remove`).
 *
 * The CLI shows these on an interactive terminal (see
 * `packages/cleo/src/cli/lib/interactive-commands.ts`); `--json` and any
 * piped or non-TTY run keep the LAFS envelope. Every value rendered here is
 * already secret-free: keys appear only as the masked last-4 preview the
 * decide operations return.
 *
 * @task T12733
 * @epic T12486
 */

import { BOLD, DIM, GREEN, NC, RED, YELLOW } from '../colors.js';

/** A JSON object as the renderer receives it. */
type Fields = Readonly<Record<string, unknown>>;

/** `value` as an object, or `undefined`. */
function obj(value: unknown): Fields | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
}

/** `value` as a string, or `undefined`. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** `value` as a finite number, or `undefined`. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** `value` as an array of objects (non-objects dropped). */
function objects(value: unknown): Fields[] {
  if (!Array.isArray(value)) return [];
  const out: Fields[] = [];
  for (const item of value) {
    const o = obj(item);
    if (o) out.push(o);
  }
  return out;
}

const OK = `${GREEN}✓${NC}`;
const BAD = `${RED}✗${NC}`;
const WARN = `${YELLOW}!${NC}`;

/** A labelled, aligned detail line. */
function row(label: string, value: string): string {
  return `  ${label.padEnd(8)} ${value}`;
}

/** `https://…` plus `(default)` or `(override)` when known. */
function urlLine(data: Fields): string | undefined {
  const url = str(data['baseUrl']);
  if (!url) return undefined;
  const source = str(data['urlSource']);
  return source ? `${url} ${DIM}(${source})${NC}` : url;
}

/** Capability summary: the wire plus any extensions, e.g. `jev-systemone/1 + batch, usage`. */
function capabilitiesLine(value: unknown): string | undefined {
  const caps = obj(value);
  const wire = str(caps?.['wire']);
  if (!caps || !wire) return undefined;
  const extras = [
    obj(caps['batch']) ? 'batch' : undefined,
    Array.isArray(caps['templates']) ? 'templates' : undefined,
    caps['flows'] === true ? 'flows' : undefined,
    caps['usage'] === true ? 'usage' : undefined,
    caps['cacheControl'] === true ? 'cache' : undefined,
    caps['langHint'] === true ? 'lang' : undefined,
  ].filter((x): x is string => x !== undefined);
  return extras.length ? `${wire} + ${extras.join(', ')}` : wire;
}

/** A USD amount with enough precision for per-decision costs (`$0.000015`). */
function usd(amount: number): string {
  return `$${amount >= 0.01 ? amount.toFixed(2) : amount.toFixed(6)}`;
}

/** Micro-dollars as USD. */
function micros(amount: number): string {
  return usd(amount / 1_000_000);
}

/** A typed answer in words: `yes (confidence 60%)`, `"b" (confidence 80%)`, `0.7`. */
function answerLine(value: unknown): string {
  const answer = obj(value);
  if (!answer) return 'none';
  const confidence = num(answer['confidence']);
  const suffix = confidence !== undefined ? ` (confidence ${Math.round(confidence * 100)}%)` : '';
  const v = answer['value'];
  if (typeof v === 'boolean') return `${v ? 'yes' : 'no'}${suffix}`;
  if (typeof v === 'string') return `"${v}"${suffix}`;
  if (typeof v === 'number') return `${v}${suffix}`;
  return `unknown${suffix}`;
}

/** `provider · 368 ms · $0.000015 · req_ixolop…`. */
function sourceLine(ask: Fields): string {
  const parts = [str(ask['source']) ?? 'unknown'];
  const latency = num(ask['latencyMs']);
  if (latency !== undefined) parts.push(`${latency} ms`);
  const cost = num(ask['costUsd']);
  if (cost !== undefined) parts.push(usd(cost));
  const requestId = str(ask['requestId']);
  if (requestId) parts.push(requestId.length > 12 ? `${requestId.slice(0, 12)}…` : requestId);
  return parts.join(' · ');
}

/** Shorten a long state for display. */
function clip(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The URL / model / key / status block of a configured profile or probe. */
function settingsBlock(data: Fields, state: string | undefined, caps: unknown): string[] {
  const lines: string[] = [];
  const url = urlLine(data);
  if (url) lines.push(row('URL', url));
  lines.push(row('Model', str(data['model']) ?? `${YELLOW}none${NC}`));
  const key = str(data['keyPreview']);
  if (key) lines.push(row('Key', key));
  const status = [state, capabilitiesLine(caps) ? `capabilities ${capabilitiesLine(caps)}` : '']
    .filter(Boolean)
    .join(' · ');
  if (status) lines.push(row('Status', status));
  return lines;
}

/**
 * Render a `decide ask` result (also the wizard's smoke test).
 *
 * @param data - `DecideAskResult`.
 * @param heading - Title line text.
 * @returns The block, one line per field.
 */
function askBlock(data: Fields, heading: string): string[] {
  const fromProvider = str(data['source']) === 'provider' || str(data['source']) === 'cache';
  const lines = [`${fromProvider ? OK : WARN} ${BOLD}${heading}${NC}`];
  const question = str(data['question']);
  if (question) lines.push(`  Question: ${question}`);
  const state = str(data['state']);
  if (state) lines.push(`  State:    ${clip(state)}`);
  lines.push(`  Answer:   ${answerLine(data['answer'])}`);
  lines.push(`  Source:   ${sourceLine(data)}`);
  const profile = str(data['profile']);
  if (profile) lines.push(`  Profile:  ${profile}`);
  const reason = str(data['fallbackReason']);
  if (reason) lines.push(`  ${YELLOW}Fallback: ${reason}${NC}`);
  return lines;
}

/**
 * Human form of `cleo decide ask`: the question, the state, the answer as
 * yes/no with confidence, and source · latency · cost · request id.
 *
 * @param data - `DecideAskResult`.
 * @param quiet - Print only the answer.
 * @returns Rendered text.
 */
export function renderDecideAsk(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return answerLine(data['answer']);
  return askBlock(data, 'System One decision').join('\n');
}

/**
 * Human form of the profile list (`cleo decide profiles`, `use`,
 * `config --remove`): one line per profile, the active one marked.
 *
 * @param data - `DecideProfileListResult`.
 * @param quiet - Print only the ids.
 * @returns Rendered text.
 */
export function renderDecideProfiles(data: Record<string, unknown>, quiet: boolean): string {
  const profiles = objects(data['profiles']);
  if (quiet) return profiles.map((p) => str(p['id']) ?? '').join('\n');
  if (profiles.length === 0) {
    return 'No System One profiles. Add one: cleo decide config --provider layahost --key-stdin';
  }
  const active = str(data['active']);
  const lines = [`${BOLD}System One profiles${NC} ${DIM}(active: ${active ?? 'none'})${NC}`];
  const width = Math.max(...profiles.map((p) => (str(p['id']) ?? '').length));
  for (const p of profiles) {
    const probe = obj(p['probe']);
    const state = str(probe?.['state']);
    const mark = p['active'] === true ? `${GREEN}*${NC}` : ' ';
    const cells = [
      (str(p['id']) ?? '').padEnd(width),
      urlLine(p) ?? '',
      str(p['model']) ?? `${YELLOW}no model${NC}`,
      str(p['keyPreview']) ?? '',
      state ? (state === 'reachable' ? `${GREEN}${state}${NC}` : `${RED}${state}${NC}`) : '',
    ].filter(Boolean);
    lines.push(`${mark} ${cells.join('  ')}`);
  }
  if (data['reconciled'] === true) {
    lines.push(
      `${YELLOW}Note: an older CLEO rewrote the settings; its values were kept for ${active ?? 'the active profile'}.${NC}`,
    );
  }
  return lines.join('\n');
}

/**
 * Human form of `cleo decide config`: the wizard result (with its smoke
 * test), a scripted configure result, the profile list after `--remove`, or
 * the active settings when no flags are given.
 *
 * @param data - `DecideWizardResult`, `DecideConfigureResult`, `DecideProfileListResult` or `DecideCredentialsSummary`.
 * @param quiet - Print only the one-line outcome.
 * @returns Rendered text.
 */
export function renderDecideConfig(data: Record<string, unknown>, quiet: boolean): string {
  if (Array.isArray(data['profiles'])) return renderDecideProfiles(data, quiet);
  const wizardConfig = obj(data['config']);
  const isWizard = str(data['summary']) !== undefined && 'configured' in data;
  if (isWizard && !wizardConfig) {
    return `${WARN} System One not configured: ${str(data['summary']) ?? 'skipped'}`;
  }
  const config = wizardConfig ?? data;
  const profile = str(config['profile']) ?? str(config['provider']) ?? 'System One';
  if (data['cleared'] === true || config['configured'] === false) {
    const what = data['cleared'] === true ? 'cleared' : 'not configured';
    return `${WARN} System One ${what}. Configure it: cleo decide config`;
  }
  const active = config['active'] === true || str(config['activeProfile']) === profile;
  const state = str(config['providerState']);
  const good = state === undefined || state === 'reachable';
  const verb = str(config['modelSource']) !== undefined ? 'configured' : 'settings';
  const title = `${good ? OK : BAD} ${BOLD}System One ${verb}: ${profile}${NC} ${active ? '(active)' : `${DIM}(inactive; cleo decide use ${profile})${NC}`}`;
  if (quiet) return title;
  const lines = [title, ...settingsBlock(config, state, config['capabilities'])];
  const warning = str(config['warning']);
  if (warning) lines.push(`  ${YELLOW}${warning}${NC}`);
  const smoke = obj(data['smoke']);
  if (smoke) lines.push(...askBlock(smoke, 'Test decision'));
  return lines.join('\n');
}

/**
 * Human form of `cleo decide status`: reachability, settings, capabilities,
 * balance and month-to-date spend against the cap.
 *
 * @param data - `DecideProbeResult`.
 * @param quiet - Print only the state.
 * @returns Rendered text.
 */
export function renderDecideStatus(data: Record<string, unknown>, quiet: boolean): string {
  const state = str(data['state']) ?? 'unknown';
  if (quiet) return state;
  const profile = str(data['profile']);
  const title = `${state === 'reachable' ? OK : BAD} ${BOLD}System One ${state}${profile ? `: ${profile}` : ''}${NC}`;
  const lines = [title];
  if (state !== 'unconfigured') {
    const latency = num(data['latencyMs']);
    const status = [state, latency !== undefined ? `${latency} ms` : undefined]
      .filter(Boolean)
      .join(' · ');
    lines.push(...settingsBlock(data, status, data['capabilities']));
  }
  const usage = obj(data['usage']);
  const balance = num(usage?.['balanceMicros']);
  if (balance !== undefined) {
    const left = num(usage?.['decisionsLeft']);
    lines.push(
      row('Balance', `${micros(balance)}${left !== undefined ? ` (${left} decisions left)` : ''}`),
    );
  }
  const spend = obj(data['spend']);
  const spent = num(spend?.['spentMicros']);
  const cap = num(spend?.['capMicros']);
  if (spent !== undefined && cap !== undefined) {
    const reached = spend?.['capReached'] === true ? ` ${RED}(cap reached)${NC}` : '';
    lines.push(
      row(
        'Spend',
        `${micros(spent)} of ${micros(cap)} in ${str(spend?.['month']) ?? 'this month'}${reached}`,
      ),
    );
  }
  const sites = num(data['sites']);
  if (sites !== undefined) lines.push(row('Sites', String(sites)));
  const detail = str(data['detail']);
  if (detail) lines.push(`  ${DIM}${detail}${NC}`);
  return lines.join('\n');
}
