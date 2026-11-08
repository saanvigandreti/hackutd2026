import { z } from 'zod';
import { readBoundedJson } from '../nemotron.ts';

// Read-only client for the Prometheus HTTP API (https://prometheus.io/docs/prometheus/latest/querying/api/).
// It is configured only from the environment and sends a request only when a caller invokes it.
type Env = Record<string, string | undefined>;
type Config = { base: URL; host: string; authorization: string | null };

export type MetricCheck = { name: string; present: boolean; seriesCount: number; capped: boolean };
export type MetricCheckReport = { host: string; checkedAt: string; windowSeconds: number; metrics: MetricCheck[] };
export type LoadedRule = { group: string; file: string; name: string; type: 'alerting' | 'recording'; query: string };

export const SERIES_LIMIT = 500;
export const WINDOW_SECONDS = 300;
const MAX_NAMES = 50;
const metricName = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const seriesSchema = z.object({ status: z.literal('success'), data: z.array(z.record(z.string())) });
const rulesSchema = z.object({ status: z.literal('success'), data: z.object({ groups: z.array(z.object({
  name: z.string(), file: z.string(),
  rules: z.array(z.object({ name: z.string(), query: z.string(), type: z.enum(['alerting', 'recording']) })),
})) }) });

function readConfig(env: Env): Config {
  const raw = env['KETCHUP_PROMETHEUS_URL']?.trim();
  if (!raw) throw new Error('Prometheus is not configured. Set KETCHUP_PROMETHEUS_URL to check your own server.');
  let base: URL;
  try { base = new URL(raw); } catch { throw new Error('KETCHUP_PROMETHEUS_URL is not a valid URL.'); }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('KETCHUP_PROMETHEUS_URL must use http or https.');
  if (base.username || base.password) throw new Error('Put Prometheus credentials in KETCHUP_PROMETHEUS_BEARER_TOKEN or KETCHUP_PROMETHEUS_BASIC_AUTH, not in the URL.');
  if (base.search || base.hash) throw new Error('KETCHUP_PROMETHEUS_URL must not contain a query string or fragment.');
  const token = env['KETCHUP_PROMETHEUS_BEARER_TOKEN']?.trim();
  const basic = env['KETCHUP_PROMETHEUS_BASIC_AUTH']?.trim();
  if (token && basic) throw new Error('Set only one of KETCHUP_PROMETHEUS_BEARER_TOKEN and KETCHUP_PROMETHEUS_BASIC_AUTH.');
  if (/[\x00-\x1f\x7f]/.test(token ?? '')) throw new Error('KETCHUP_PROMETHEUS_BEARER_TOKEN must not contain control characters.');
  if (basic && !basic.includes(':')) throw new Error('KETCHUP_PROMETHEUS_BASIC_AUTH must have the form user:password.');
  const loopback = base.hostname === 'localhost' || base.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(base.hostname);
  if ((token || basic) && base.protocol === 'http:' && !loopback) throw new Error('Use an https KETCHUP_PROMETHEUS_URL to send Prometheus credentials; plain http carries them unencrypted.');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const authorization = token ? `Bearer ${token}` : basic ? `Basic ${Buffer.from(basic, 'utf8').toString('base64')}` : null;
  return { base, host: base.host, authorization };
}

export function prometheusStatus(env: Env): { configured: boolean; host: string | null } {
  try { return { configured: true, host: readConfig(env).host }; }
  catch { return { configured: false, host: null }; }
}

async function getJson(config: Config, path: string, params: URLSearchParams, options: {
  signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number; maximumBytes: number;
}): Promise<unknown> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const url = new URL(path, config.base);
  url.search = params.toString();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.authorization) headers['Authorization'] = config.authorization;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, { method: 'GET', redirect: 'error', signal, headers });
  } catch (error) {
    if (signal.aborted) throw new Error(`Prometheus at ${config.host} did not answer in time or the check was cancelled.`);
    if (/redirect/i.test(String((error as { cause?: unknown }).cause))) {
      throw new Error(`Prometheus at ${config.host} answered with a redirect, which Ketchup does not follow. Set KETCHUP_PROMETHEUS_URL to the final address.`);
    }
    throw new Error(`Could not reach Prometheus at ${config.host}.`);
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new Error(`Prometheus at ${config.host} rejected the credentials (HTTP ${response.status}).`);
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`Prometheus at ${config.host} returned HTTP ${response.status}.`);
  }
  try { return await readBoundedJson(response, options.maximumBytes); }
  catch (error) {
    if (signal.aborted) throw new Error(`Prometheus at ${config.host} did not answer in time or the check was cancelled.`);
    if (/size limit/.test(String(error))) throw new Error(`Prometheus at ${config.host} returned a response larger than Ketchup accepts.`);
    throw new Error(`${config.host} did not return a Prometheus API response.`);
  }
}

export async function checkMetricNames(options: {
  names: string[]; env: Env; fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; now?: Date;
}): Promise<MetricCheckReport> {
  const config = readConfig(options.env);
  const names = [...new Set(options.names)];
  if (names.length === 0 || names.length > MAX_NAMES) throw new Error(`Check between 1 and ${MAX_NAMES} metric names.`);
  for (const name of names) if (!metricName.test(name)) throw new Error(`"${name.slice(0, 80)}" is not a Prometheus metric name.`);
  const now = options.now ?? new Date();
  const start = new Date(now.getTime() - WINDOW_SECONDS * 1000);
  const metrics: MetricCheck[] = [];
  for (const name of names) {
    const params = new URLSearchParams({ 'match[]': name, start: start.toISOString(), end: now.toISOString(), limit: String(SERIES_LIMIT) });
    const raw = await getJson(config, 'api/v1/series', params, { ...options, maximumBytes: 1_048_576 });
    const parsed = seriesSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`${config.host} did not return a Prometheus series response.`);
    const series = parsed.data.data.filter((labels) => labels['__name__'] === name);
    metrics.push({ name, present: series.length > 0, seriesCount: Math.min(series.length, SERIES_LIMIT), capped: series.length >= SERIES_LIMIT });
  }
  return { host: config.host, checkedAt: now.toISOString(), windowSeconds: WINDOW_SECONDS, metrics };
}

export async function listRules(options: {
  env: Env; fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number;
}): Promise<LoadedRule[]> {
  const config = readConfig(options.env);
  const raw = await getJson(config, 'api/v1/rules', new URLSearchParams({ exclude_alerts: 'true' }), { ...options, maximumBytes: 4_194_304 });
  const parsed = rulesSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${config.host} did not return a Prometheus rules response.`);
  return parsed.data.data.groups.flatMap((group) => group.rules.map((rule) => ({
    group: group.name, file: group.file, name: rule.name, type: rule.type, query: rule.query,
  })));
}

// Matches the metric name as a whole PromQL identifier in the rule text; it does not parse PromQL.
export function rulesReferencing(rules: LoadedRule[], name: string): LoadedRule[] {
  if (!metricName.test(name)) return [];
  const pattern = new RegExp(`(?<![a-zA-Z0-9_:])${name}(?![a-zA-Z0-9_:])`);
  return rules.filter((rule) => pattern.test(rule.query));
}
