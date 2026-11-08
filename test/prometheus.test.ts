import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { checkMetricNames, listRules, prometheusStatus, rulesReferencing, SERIES_LIMIT } from '../src/connectors/prometheus.ts';

const fixture = (name: string) => readFileSync(new URL(`fixtures/prometheus/${name}`, import.meta.url));
const seriesExample = fixture('series-example.json');
const rulesExample = fixture('rules-example.json');
let handle: (request: IncomingMessage, response: ServerResponse) => void = (_request, response) => { response.end(); };
let seen: { method: string; url: string; authorization: string | undefined }[] = [];
const server = createServer((request, response) => {
  seen.push({ method: request.method ?? '', url: request.url ?? '', authorization: request.headers.authorization });
  handle(request, response);
});
let env: Record<string, string>;
let host: string;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.closeAllConnections(); server.close(); });
const reset = (next: typeof handle, extra: Record<string, string> = {}) => {
  handle = next; seen = [];
  env = { KETCHUP_PROMETHEUS_URL: `http://${host}/prom`, ...extra };
};
const json = (body: Buffer) => (_request: IncomingMessage, response: ServerResponse) => {
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
};

test('not configured: status is off and no request is attempted', async () => {
  assert.deepEqual(prometheusStatus({}), { configured: false, host: null });
  assert.deepEqual(prometheusStatus({ KETCHUP_PROMETHEUS_URL: 'ftp://example.invalid' }), { configured: false, host: null });
  assert.deepEqual(prometheusStatus({ KETCHUP_PROMETHEUS_URL: 'https://user:secret@prom.example.invalid' }), { configured: false, host: null });
  assert.deepEqual(prometheusStatus({ KETCHUP_PROMETHEUS_URL: 'https://prom.example.invalid:9090/sub/path', KETCHUP_PROMETHEUS_BEARER_TOKEN: 't' }),
    { configured: true, host: 'prom.example.invalid:9090' });
  await assert.rejects(checkMetricNames({ names: ['up'], env: {}, fetchImpl: async () => { throw new Error('Network access must not happen'); } }),
    /not configured\. Set KETCHUP_PROMETHEUS_URL/);
});

test('present metric: documented series example is read with a bounded read-only GET', async () => {
  reset(json(seriesExample), { KETCHUP_PROMETHEUS_BEARER_TOKEN: 'offline-dummy-token' });
  const now = new Date(0);
  const report = await checkMetricNames({ names: ['up', 'process_start_time_seconds', 'up'], env, now });
  assert.deepEqual(report, { host, checkedAt: now.toISOString(), windowSeconds: 300, metrics: [
    { name: 'up', present: true, seriesCount: 2, capped: false },
    { name: 'process_start_time_seconds', present: true, seriesCount: 1, capped: false },
  ] });
  assert.equal(seen.length, 2);
  const first = new URL(seen[0]!.url, 'http://x');
  assert.equal(seen[0]!.method, 'GET');
  assert.equal(first.pathname, '/prom/api/v1/series');
  assert.deepEqual(first.searchParams.getAll('match[]'), ['up']);
  assert.equal(Date.parse(first.searchParams.get('start') ?? ''), -300_000);
  assert.equal(Date.parse(first.searchParams.get('end') ?? ''), 0);
  assert.equal(first.searchParams.get('limit'), String(SERIES_LIMIT));
  assert.equal(seen[0]!.authorization, 'Bearer offline-dummy-token');
  assert.doesNotMatch(JSON.stringify(report), /offline-dummy-token/);
});

test('absent metric: a name with no matching series reports present false', async () => {
  reset(json(seriesExample), { KETCHUP_PROMETHEUS_BASIC_AUTH: 'reader:offline-dummy' });
  const report = await checkMetricNames({ names: ['DCGM_FI_DEV_XID_ERRORS'], env });
  assert.deepEqual(report.metrics, [{ name: 'DCGM_FI_DEV_XID_ERRORS', present: false, seriesCount: 0, capped: false }]);
  assert.equal(seen[0]!.authorization, `Basic ${Buffer.from('reader:offline-dummy').toString('base64')}`);
});

test('invalid names and ambiguous credentials fail before network access', async () => {
  reset(json(seriesExample));
  await assert.rejects(checkMetricNames({ names: ['up{job="x"}'], env }), /is not a Prometheus metric name/);
  await assert.rejects(checkMetricNames({ names: [], env }), /between 1 and 50/);
  await assert.rejects(checkMetricNames({ names: ['up'], env: { ...env, KETCHUP_PROMETHEUS_BEARER_TOKEN: 'a', KETCHUP_PROMETHEUS_BASIC_AUTH: 'b:c' } }), /only one of/);
  await assert.rejects(checkMetricNames({ names: ['up'], env: { ...env, KETCHUP_PROMETHEUS_BEARER_TOKEN: 'a\r\nb' } }), /control characters/);
  const cleartext = { KETCHUP_PROMETHEUS_URL: 'http://prom.example.invalid:9090', KETCHUP_PROMETHEUS_BEARER_TOKEN: 't' };
  await assert.rejects(checkMetricNames({ names: ['up'], env: cleartext }), /https KETCHUP_PROMETHEUS_URL to send Prometheus credentials/);
  assert.deepEqual(prometheusStatus(cleartext), { configured: false, host: null }, 'credentials never go to a remote host over plain http');
  assert.equal(prometheusStatus({ ...cleartext, KETCHUP_PROMETHEUS_URL: 'http://localhost:9090' }).configured, true, 'a loopback Prometheus may use http');
  assert.equal(seen.length, 0);
});

test('401 is reported as rejected credentials without exposing the body', async () => {
  reset((_request, response) => { response.writeHead(401, { 'Content-Type': 'text/plain' }).end('server detail'); });
  await assert.rejects(checkMetricNames({ names: ['up'], env }), (error: Error) =>
    /rejected the credentials \(HTTP 401\)/.test(error.message) && !error.message.includes('server detail'));
});

test('an HTML page is reported as not Prometheus', async () => {
  // Authored stand-in for a login or proxy page; it is not a Prometheus response.
  reset((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Sign in</title>'); });
  await assert.rejects(checkMetricNames({ names: ['up'], env }), new RegExp(`${host} did not return a Prometheus API response`));
  reset((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"hello":"world"}'); });
  await assert.rejects(checkMetricNames({ names: ['up'], env }), /did not return a Prometheus series response/);
});

test('oversize responses are refused', async () => {
  reset((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(`{"status":"success","data":[${'{"__name__":"up"},'.repeat(80_000)}{}]}`);
  });
  await assert.rejects(checkMetricNames({ names: ['up'], env }), /larger than Ketchup accepts/);
});

test('redirects are refused, not followed', async () => {
  reset((request, response) => {
    if (request.url?.startsWith('/elsewhere')) { response.writeHead(200).end(seriesExample); return; }
    response.writeHead(302, { Location: `http://${host}/elsewhere` }).end();
  });
  await assert.rejects(checkMetricNames({ names: ['up'], env }), /answered with a redirect/);
  assert.deepEqual(seen.map((request) => request.url.split('?')[0]), ['/prom/api/v1/series']);
});

test('a server that never answers times out', async () => {
  reset(() => undefined);
  await assert.rejects(checkMetricNames({ names: ['up'], env, timeoutMs: 200 }), /did not answer in time/);
  await assert.rejects(checkMetricNames({ names: ['up'], env, signal: AbortSignal.abort() }), /did not answer in time or the check was cancelled/);
});

test('an unreachable host is reported by host only', async () => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  await assert.rejects(checkMetricNames({ names: ['up'], env: { KETCHUP_PROMETHEUS_URL: `http://127.0.0.1:${port}/` } }),
    new RegExp(`Could not reach Prometheus at 127\\.0\\.0\\.1:${port}\\.`));
});

test('rules: documented example is listed and matched by whole metric name', async () => {
  reset(json(rulesExample));
  const rules = await listRules({ env });
  assert.equal(new URL(seen[0]!.url, 'http://x').pathname, '/prom/api/v1/rules');
  assert.deepEqual(rules, [
    { group: 'example', file: '/rules.yaml', name: 'HighRequestLatency', type: 'alerting', query: 'job:request_latency_seconds:mean5m{job="myjob"} > 0.5' },
    { group: 'example', file: '/rules.yaml', name: 'job:http_inprogress_requests:sum', type: 'recording', query: 'sum by (job) (http_inprogress_requests)' },
  ]);
  assert.deepEqual(rulesReferencing(rules, 'http_inprogress_requests').map((rule) => rule.name), ['job:http_inprogress_requests:sum']);
  assert.deepEqual(rulesReferencing(rules, 'request_latency_seconds'), []);
});
